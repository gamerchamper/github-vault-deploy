/**
 * Chunk lookup cache — 404 caching, deduplication, repair backoff.
 * Prevents repeated GitHub API/raw requests for known-missing chunks.
 */
const crypto = require('crypto');

const MISSING_TTL_MS = 30 * 60 * 1000;
const CONFIRMED_MISSING_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
const BASE_BACKOFF_MS = 60 * 1000;
const CONFIRM_MISSING_AFTER = 5;

const missingCache = new Map();
const pendingLookups = new Map();
const repoHealthCache = new Map();
const REPO_HEALTH_TTL_MS = 10 * 60 * 1000;

let db = null;

function getDb() {
  if (!db) {
    try { db = require('../db/database'); } catch { /* tests */ }
  }
  return db;
}

function blobKey(owner, repo, path, branch) {
  return `${owner}/${repo}@${branch || 'main'}:${path}`;
}

function syncKey(chunkId, linkedAccountId) {
  return `${chunkId}:${linkedAccountId}`;
}

let redisBridge = null;
function getRedis() {
  if (redisBridge === false) return null;
  if (redisBridge) return redisBridge;
  try {
    redisBridge = require('./chunk-lookup-redis');
    if (!redisBridge.isEnabled()) redisBridge = false;
  } catch {
    redisBridge = false;
  }
  return redisBridge || null;
}

function isBlobMissing(key) {
  const entry = missingCache.get(key);
  if (!entry) return false;
  if (Date.now() > entry.until) {
    missingCache.delete(key);
    return false;
  }
  return true;
}

async function isBlobMissingAsync(key) {
  if (isBlobMissing(key)) return true;
  const redis = getRedis();
  if (!redis) return false;
  const remote = await redis.getMissing(key);
  if (remote) {
    missingCache.set(key, remote);
    return Date.now() <= remote.until;
  }
  return false;
}

function markBlobMissing(key, { confirmed = false } = {}) {
  const ttl = confirmed ? CONFIRMED_MISSING_TTL_MS : MISSING_TTL_MS;
  const entry = { until: Date.now() + ttl, confirmed, at: Date.now() };
  missingCache.set(key, entry);
  const redis = getRedis();
  if (redis) redis.setMissing(key, entry).catch(() => {});
}

function clearBlobMissing(key) {
  missingCache.delete(key);
  const redis = getRedis();
  if (redis) redis.clearMissing(key).catch(() => {});
}

function stableSha(owner, repo, path, branch, etag) {
  if (etag) return String(etag).replace(/"/g, '');
  return crypto.createHash('sha1').update(`${owner}/${repo}/${path}@${branch || 'main'}`).digest('hex');
}

async function dedupe(key, fn) {
  if (pendingLookups.has(key)) {
    try { return await pendingLookups.get(key); } catch (err) { throw err; }
  }
  const promise = fn().finally(() => pendingLookups.delete(key));
  pendingLookups.set(key, promise);
  return promise;
}

function loadSyncFailure(chunkId, linkedAccountId) {
  const database = getDb();
  if (!database) return null;
  try {
    return database.prepare(`
      SELECT fail_count, next_retry_at, confirmed_missing, last_error
      FROM chunk_sync_failures
      WHERE chunk_id = ? AND linked_account_id = ?
    `).get(chunkId, linkedAccountId);
  } catch {
    return null;
  }
}

function shouldRetrySync(chunkId, linkedAccountId, { force = false } = {}) {
  if (force) return true;
  const row = loadSyncFailure(chunkId, linkedAccountId);
  if (!row) return true;
  if (row.confirmed_missing) return false;
  if (!row.next_retry_at) return true;
  const next = new Date(row.next_retry_at).getTime();
  return Date.now() >= next;
}

function recordSyncFailure(chunkId, linkedAccountId, errorMsg) {
  const database = getDb();
  if (!database) return;
  const prev = loadSyncFailure(chunkId, linkedAccountId);
  const count = (prev?.fail_count || 0) + 1;
  const delay = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, Math.min(count - 1, 8)));
  const confirmed = count >= CONFIRM_MISSING_AFTER ? 1 : 0;
  const nextRetry = confirmed ? null : new Date(Date.now() + delay).toISOString();

  database.prepare(`
    INSERT INTO chunk_sync_failures (chunk_id, linked_account_id, fail_count, last_fail_at, next_retry_at, last_error, confirmed_missing)
    VALUES (?, ?, ?, datetime('now'), ?, ?, ?)
    ON CONFLICT(chunk_id, linked_account_id) DO UPDATE SET
      fail_count = excluded.fail_count,
      last_fail_at = excluded.last_fail_at,
      next_retry_at = excluded.next_retry_at,
      last_error = excluded.last_error,
      confirmed_missing = excluded.confirmed_missing
  `).run(chunkId, linkedAccountId, count, nextRetry, (errorMsg || '').slice(0, 500), confirmed);
}

function markSyncConfirmedMissing(chunkId, linkedAccountId, errorMsg) {
  const database = getDb();
  if (!database) return;
  database.prepare(`
    INSERT INTO chunk_sync_failures (chunk_id, linked_account_id, fail_count, last_fail_at, next_retry_at, last_error, confirmed_missing)
    VALUES (?, ?, 1, datetime('now'), NULL, ?, 1)
    ON CONFLICT(chunk_id, linked_account_id) DO UPDATE SET
      last_fail_at = datetime('now'),
      next_retry_at = NULL,
      last_error = excluded.last_error,
      confirmed_missing = 1
  `).run(chunkId, linkedAccountId, (errorMsg || 'Source chunk missing').slice(0, 500));
}

function clearSyncFailure(chunkId, linkedAccountId) {
  const database = getDb();
  if (!database) return;
  try {
    database.prepare('DELETE FROM chunk_sync_failures WHERE chunk_id = ? AND linked_account_id = ?')
      .run(chunkId, linkedAccountId);
  } catch { /* table may not exist in old tests */ }
}

function clearSyncFailuresForAccount(linkedAccountId) {
  const database = getDb();
  if (!database) return;
  try {
    database.prepare('DELETE FROM chunk_sync_failures WHERE linked_account_id = ?').run(linkedAccountId);
  } catch { /* ignore */ }
}

function filterRetryableChunks(rows, linkedAccountId, { force = false } = {}) {
  if (force) return rows;
  return rows.filter((row) => shouldRetrySync(row.id, linkedAccountId, { force }));
}

function getRepoHealth(owner, repo) {
  const key = `${owner}/${repo}`;
  const entry = repoHealthCache.get(key);
  if (entry && Date.now() - entry.at < REPO_HEALTH_TTL_MS) return entry;
  return null;
}

function setRepoHealth(owner, repo, { reachable, branch }) {
  const key = `${owner}/${repo}`;
  repoHealthCache.set(key, { reachable, branch, at: Date.now() });
}

async function headBlob(owner, repo, path, branch) {
  const key = blobKey(owner, repo, path, branch);
  if (await isBlobMissingAsync(key)) return { ok: false, status: 404, cached: true };

  return dedupe(`head:${key}`, async () => {
    if (isBlobMissing(key)) return { ok: false, status: 404, cached: true };
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch || 'main'}/${path}`;
    const resp = await fetch(rawUrl, { method: 'HEAD', timeout: 10000 });
    if (resp.status === 404) {
      markBlobMissing(key);
      return { ok: false, status: 404, cached: false };
    }
    if (resp.ok) {
      clearBlobMissing(key);
      return { ok: true, status: resp.status, etag: resp.headers.get('etag'), cached: false };
    }
    return { ok: false, status: resp.status, cached: false };
  });
}

async function getFileSha(octokit, owner, repo, path, branch, { subsystem = 'lookup', bypassMissing = false } = {}) {
  const rateLimit = require('./github-rate-limit');
  const key = blobKey(owner, repo, path, branch);
  if (!bypassMissing && await isBlobMissingAsync(key)) return null;

  return dedupe(`sha:${key}`, async () => {
    if (!bypassMissing && isBlobMissing(key)) return null;

    const head = await headBlob(owner, repo, path, branch);
    if (head.cached && !head.ok) {
      if (!bypassMissing) return null;
      clearBlobMissing(key);
    } else if (!head.ok && head.status === 404 && !bypassMissing) {
      return null;
    }

    return rateLimit.runWithSubsystem(subsystem, async () => {
      try {
        const { data } = await octokit.repos.getContent({ owner, repo, path, ref: branch });
        if (Array.isArray(data)) return null;
        clearBlobMissing(key);
        return data.sha;
      } catch (err) {
        if (err.status === 404) {
          markBlobMissing(key);
          return null;
        }
        throw err;
      }
    });
  });
}

async function downloadBlob(octokit, owner, repo, path, branch, { subsystem = 'download' } = {}) {
  const rateLimit = require('./github-rate-limit');
  const key = blobKey(owner, repo, path, branch);
  if (await isBlobMissingAsync(key)) {
    const err = new Error(`Chunk not found: ${path}`);
    err.status = 404;
    throw err;
  }

  return dedupe(`dl:${key}`, async () => {
    if (isBlobMissing(key)) {
      const err = new Error(`Chunk not found: ${path}`);
      err.status = 404;
      throw err;
    }

    const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch || 'main'}/${path}`;
    const resp = await fetch(rawUrl, { timeout: 60000 });
    if (resp.ok) {
      clearBlobMissing(key);
      return Buffer.from(await resp.arrayBuffer());
    }
    if (resp.status === 404) {
      markBlobMissing(key);
      const err = new Error(`Chunk not found: ${path}`);
      err.status = 404;
      throw err;
    }

    return rateLimit.runWithSubsystem(subsystem, async () => {
      try {
        const { data } = await octokit.repos.getContent({ owner, repo, path, ref: branch });
        if (Array.isArray(data)) throw new Error('Expected file, got directory');
        if (data.encoding === 'base64' && data.content) {
          clearBlobMissing(key);
          return Buffer.from(data.content, 'base64');
        }
        if (!data.download_url) throw new Error(`No content for ${path}`);
        const fallbackResp = await fetch(data.download_url, { timeout: 60000 });
        if (!fallbackResp.ok) throw new Error(`Download failed (${fallbackResp.status}) for ${path}`);
        clearBlobMissing(key);
        return Buffer.from(await fallbackResp.arrayBuffer());
      } catch (err) {
        if (err.status === 404) markBlobMissing(key);
        throw err;
      }
    });
  });
}

function getCacheStats() {
  let missing = 0;
  let confirmed = 0;
  for (const entry of missingCache.values()) {
    missing += 1;
    if (entry.confirmed) confirmed += 1;
  }
  const database = getDb();
  let syncFailures = 0;
  let confirmedMissing = 0;
  if (database) {
    try {
      syncFailures = database.prepare('SELECT COUNT(*) as c FROM chunk_sync_failures').get()?.c || 0;
      confirmedMissing = database.prepare('SELECT COUNT(*) as c FROM chunk_sync_failures WHERE confirmed_missing = 1').get()?.c || 0;
    } catch { /* ignore */ }
  }
  return {
    missing_blob_cache: missing,
    confirmed_missing_cache: confirmed,
    pending_lookups: pendingLookups.size,
    repo_health_cached: repoHealthCache.size,
    sync_failure_rows: syncFailures,
    confirmed_missing_rows: confirmedMissing,
  };
}

function pruneExpired() {
  const now = Date.now();
  let missingPruned = 0;
  let repoPruned = 0;

  for (const [key, entry] of missingCache) {
    if (now > entry.until) {
      missingCache.delete(key);
      missingPruned += 1;
    }
  }

  for (const [key, entry] of repoHealthCache) {
    if (now - entry.at > REPO_HEALTH_TTL_MS) {
      repoHealthCache.delete(key);
      repoPruned += 1;
    }
  }

  return { missing_pruned: missingPruned, repo_health_pruned: repoPruned };
}

module.exports = {
  blobKey,
  getFileSha,
  downloadBlob,
  headBlob,
  isBlobMissing,
  markBlobMissing,
  clearBlobMissing,
  loadSyncFailure,
  shouldRetrySync,
  recordSyncFailure,
  markSyncConfirmedMissing,
  clearSyncFailure,
  clearSyncFailuresForAccount,
  filterRetryableChunks,
  getRepoHealth,
  setRepoHealth,
  getCacheStats,
  pruneExpired,
  stableSha,
};
