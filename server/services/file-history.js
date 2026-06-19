/**
 * File version history — snapshots on each content change; backfills from Git manifest commits.
 * Old chunk blobs remain on GitHub (addressable by SHA) even after paths are overwritten.
 */
const crypto = require('crypto');
const db = require('../db/database');
const github = require('./github');
const metadata = require('./metadata');

const ENABLED = process.env.EXPERIMENTAL_FILE_HISTORY !== '0';
const MAX_VERSIONS_PER_FILE = parseInt(process.env.FILE_HISTORY_MAX_VERSIONS || '40', 10);
const GIT_BACKFILL_LIMIT = parseInt(process.env.FILE_HISTORY_GIT_BACKFILL || '50', 10);

function isEnabled() {
  return ENABLED;
}

function normalizeManifestChunks(manifest) {
  return (manifest?.chunks || []).map((c) => ({
    chunk_index: c.index ?? c.chunk_index ?? 0,
    full_name: c.repo ?? c.full_name,
    repo_path: c.repo_path,
    sha: c.sha,
    size: c.size,
    plain_size: c.plain_size ?? null,
    chunk_iv: c.chunk_iv ?? null,
    chunk_tag: c.chunk_tag ?? null,
  }));
}

function contentFingerprint(chunks, size) {
  const parts = (chunks || [])
    .slice()
    .sort((a, b) => a.chunk_index - b.chunk_index)
    .map((c) => `${c.chunk_index}:${c.sha}:${c.plain_size ?? c.size}`);
  return crypto.createHash('sha256').update(`${size}|${parts.join('|')}`).digest('hex');
}

function contentFingerprintFromManifest(manifest) {
  const chunks = normalizeManifestChunks(manifest);
  return contentFingerprint(chunks, manifest.size ?? 0);
}

function snapshotIsDownloadable(snapshot) {
  const chunks = snapshot?.chunks || [];
  if (!chunks.length) return false;
  return chunks.every((c) => c.sha && c.chunk_iv && c.chunk_tag);
}

function resolveRepoId(userId, fullName) {
  const row = db.prepare(
    'SELECT id FROM storage_repos WHERE user_id = ? AND full_name = ? LIMIT 1',
  ).get(userId, fullName);
  return row?.id ?? null;
}

function buildSnapshot(file, chunks, encryptionMeta) {
  return {
    file_id: file.id,
    name: file.name,
    path: file.path,
    parent_path: file.parent_path,
    size: file.size,
    mime_type: file.mime_type,
    chunk_count: file.chunk_count,
    encryption: encryptionMeta,
    chunks: chunks.map((c) => ({
      chunk_index: c.chunk_index,
      repo_id: c.repo_id,
      full_name: c.full_name,
      repo_path: c.repo_path,
      sha: c.sha,
      size: c.size,
      plain_size: c.plain_size,
      chunk_iv: c.chunk_iv,
      chunk_tag: c.chunk_tag,
    })),
    recorded_at: new Date().toISOString(),
  };
}

function buildSnapshotFromManifest(userId, file, manifest) {
  const encryptionMeta = manifest.encryption || null;
  const chunks = normalizeManifestChunks(manifest).map((c) => ({
    ...c,
    repo_id: resolveRepoId(userId, c.full_name),
  }));
  return {
    file_id: file.id,
    name: manifest.name || file.name,
    path: manifest.path || file.path,
    parent_path: manifest.parent_path ?? file.parent_path,
    size: manifest.size ?? file.size,
    mime_type: manifest.mime_type || file.mime_type,
    chunk_count: manifest.chunk_count || chunks.length,
    encryption: encryptionMeta,
    chunks,
    recorded_at: manifest.updated_at || manifest.created_at || new Date().toISOString(),
  };
}

function loadChunksForFile(fileId) {
  return db.prepare(`
    SELECT c.*, r.full_name
    FROM chunks c
    JOIN storage_repos r ON c.repo_id = r.id
    WHERE c.file_id = ?
    ORDER BY c.chunk_index
  `).all(fileId);
}

function getLatestVersion(fileId) {
  return db.prepare(`
    SELECT * FROM file_versions
    WHERE file_id = ?
    ORDER BY version_num DESC
    LIMIT 1
  `).get(fileId);
}

function pruneOldVersions(fileId) {
  const rows = db.prepare(`
    SELECT id FROM file_versions
    WHERE file_id = ?
    ORDER BY version_num DESC
  `).all(fileId);
  if (rows.length <= MAX_VERSIONS_PER_FILE) return;
  const drop = rows.slice(MAX_VERSIONS_PER_FILE);
  const del = db.prepare('DELETE FROM file_versions WHERE id = ?');
  for (const row of drop) del.run(row.id);
}

function insertVersionRow(userId, fileId, {
  versionNum,
  fingerprint,
  manifestSha,
  source,
  note,
  snapshot,
  createdAt = null,
}) {
  const result = db.prepare(`
    INSERT INTO file_versions (
      file_id, user_id, version_num, size, chunk_count, content_fingerprint,
      manifest_sha, source, note, manifest_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
  `).run(
    fileId,
    userId,
    versionNum,
    snapshot.size,
    snapshot.chunk_count || snapshot.chunks?.length || 0,
    fingerprint,
    manifestSha,
    source,
    note,
    JSON.stringify(snapshot),
    createdAt,
  );
  pruneOldVersions(fileId);
  return db.prepare('SELECT * FROM file_versions WHERE id = ?').get(Number(result.lastInsertRowid));
}

async function recordVersion(userId, fileId, { source = 'upload', manifestSha = null, note = null } = {}) {
  if (!ENABLED) return null;

  const file = db.prepare(
    "SELECT * FROM files WHERE id = ? AND user_id = ? AND is_folder = 0 AND upload_status = 'ready'",
  ).get(fileId, userId);
  if (!file) return null;

  const chunks = loadChunksForFile(fileId);
  if (!chunks.length) return null;

  let encryptionMeta;
  try {
    encryptionMeta = JSON.parse(file.encryption_meta);
  } catch {
    encryptionMeta = null;
  }
  if (!encryptionMeta) return null;

  const fingerprint = contentFingerprint(chunks, file.size);
  const latest = getLatestVersion(fileId);
  if (latest?.content_fingerprint === fingerprint) {
    if (manifestSha && latest.manifest_sha !== manifestSha) {
      db.prepare('UPDATE file_versions SET manifest_sha = ? WHERE id = ?').run(manifestSha, latest.id);
    }
    return latest;
  }

  const versionNum = (latest?.version_num ?? 0) + 1;
  const snapshot = buildSnapshot(file, chunks, encryptionMeta);
  return insertVersionRow(userId, fileId, {
    versionNum,
    fingerprint,
    manifestSha,
    source,
    note,
    snapshot,
  });
}

/** Snapshot the current ready file before chunks are replaced (vault-sync content update). */
async function recordVersionBeforeReplace(userId, fileId, { source = 'sync', note = null } = {}) {
  if (!ENABLED) return null;
  const file = db.prepare(`
    SELECT * FROM files WHERE id = ? AND user_id = ? AND is_folder = 0 AND is_deleted = 0
      AND (upload_status IS NULL OR upload_status = 'ready')
  `).get(fileId, userId);
  if (!file) return null;

  const chunks = loadChunksForFile(fileId);
  if (!chunks.length) return null;

  let encryptionMeta;
  try {
    encryptionMeta = JSON.parse(file.encryption_meta);
  } catch {
    return null;
  }

  const fingerprint = contentFingerprint(chunks, file.size);
  const existing = db.prepare(
    'SELECT id FROM file_versions WHERE file_id = ? AND content_fingerprint = ? LIMIT 1',
  ).get(fileId, fingerprint);
  if (existing) return existing;

  const versionNum = (getLatestVersion(fileId)?.version_num ?? 0) + 1;
  const snapshot = buildSnapshot(file, chunks, encryptionMeta);
  return insertVersionRow(userId, fileId, {
    versionNum,
    fingerprint,
    manifestSha: null,
    source,
    note: note || 'Before content update',
    snapshot,
  });
}

async function fetchManifestAtCommit(userId, fileId, commitSha) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const metaRepo = metadata.getMetadataRepo(userId);
  if (!user || !metaRepo || !commitSha) return null;

  const octokit = github.createClient(user.access_token);
  const path = metadata.manifestPath(fileId);
  return metadata.readJsonAtRef(octokit, metaRepo, path, commitSha);
}

async function backfillVersionsFromGit(userId, fileId) {
  if (!ENABLED) return 0;

  const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(fileId, userId);
  if (!file) return 0;

  const commits = await listManifestCommits(userId, fileId, GIT_BACKFILL_LIMIT);
  if (!commits.length) return 0;

  let added = 0;
  const seenFingerprints = new Set(
    db.prepare('SELECT content_fingerprint FROM file_versions WHERE file_id = ?').all(fileId)
      .map((r) => r.content_fingerprint),
  );

  // Oldest first so version numbers align with timeline
  const ordered = commits.slice().reverse();

  for (const commit of ordered) {
    const manifest = await fetchManifestAtCommit(userId, fileId, commit.sha);
    if (!manifest?.chunks?.length) continue;

    const fingerprint = contentFingerprintFromManifest(manifest);
    if (seenFingerprints.has(fingerprint)) {
      const row = db.prepare(
        'SELECT id FROM file_versions WHERE file_id = ? AND content_fingerprint = ? LIMIT 1',
      ).get(fileId, fingerprint);
      if (row && commit.sha) {
        db.prepare(
          'UPDATE file_versions SET manifest_sha = COALESCE(manifest_sha, ?) WHERE id = ?',
        ).run(commit.sha, row.id);
      }
      continue;
    }

    const snapshot = buildSnapshotFromManifest(userId, file, manifest);
    if (!snapshotIsDownloadable(snapshot)) continue;

    const maxVer = db.prepare(
      'SELECT MAX(version_num) as n FROM file_versions WHERE file_id = ?',
    ).get(fileId);
    const versionNum = (maxVer?.n ?? 0) + 1;

    insertVersionRow(userId, fileId, {
      versionNum,
      fingerprint,
      manifestSha: commit.sha,
      source: 'git',
      note: 'Recovered from Git manifest history',
      snapshot,
      createdAt: commit.date || null,
    });
    seenFingerprints.add(fingerprint);
    added += 1;
  }

  return added;
}

function mapVersionRow(row, { isCurrent = false } = {}) {
  let downloadable = true;
  try {
    const snapshot = JSON.parse(row.manifest_json);
    downloadable = snapshotIsDownloadable(snapshot);
  } catch {
    downloadable = false;
  }

  return {
    id: row.id,
    versionNum: row.version_num,
    size: row.size,
    chunkCount: row.chunk_count,
    contentFingerprint: row.content_fingerprint,
    manifestSha: row.manifest_sha,
    source: row.source,
    note: row.note,
    createdAt: row.created_at,
    isCurrent: !!isCurrent,
    downloadable,
  };
}

async function listManifestCommits(userId, fileId, limit = 30) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const metaRepo = metadata.getMetadataRepo(userId);
  if (!user || !metaRepo) return [];

  const path = metadata.manifestPath(fileId);
  const [owner, name] = metaRepo.full_name.split('/');
  const octokit = github.createClient(user.access_token);

  try {
    const rateLimit = require('./github-rate-limit');
    const { data } = await rateLimit.runWithSubsystem('metadata', () =>
      octokit.repos.listCommits({
        owner,
        repo: name,
        path,
        per_page: Math.min(limit, 100),
      }),
    );
    return (data || []).map((c) => ({
      sha: c.sha,
      message: c.commit?.message || '',
      date: c.commit?.committer?.date || c.commit?.author?.date,
      author: c.commit?.author?.name,
    }));
  } catch {
    return [];
  }
}

async function listVersions(userId, fileId) {
  if (!ENABLED) {
    return { enabled: false, versions: [], gitCommits: [] };
  }

  const file = db.prepare('SELECT id FROM files WHERE id = ? AND user_id = ?').get(fileId, userId);
  if (!file) throw new Error('File not found');

  await recordVersion(userId, fileId).catch(() => {});

  await backfillVersionsFromGit(userId, fileId).catch((err) => {
    console.warn('[file-history] git backfill failed:', err.message);
  });

  const rows = db.prepare(`
    SELECT * FROM file_versions
    WHERE file_id = ? AND user_id = ?
    ORDER BY version_num DESC
  `).all(fileId, userId);

  const latest = rows[0];
  const versions = rows.map((row, idx) => mapVersionRow(row, { isCurrent: idx === 0 }));

  const gitCommits = await listManifestCommits(userId, fileId);

  return {
    enabled: true,
    fileId,
    versions,
    gitCommits,
    currentVersionId: latest?.id ?? null,
    totalFromGit: gitCommits.length,
  };
}

function getVersion(userId, fileId, versionId) {
  const row = db.prepare(`
    SELECT * FROM file_versions
    WHERE id = ? AND file_id = ? AND user_id = ?
  `).get(versionId, fileId, userId);
  if (!row) throw new Error('Version not found');
  return row;
}

function getVersionDetails(userId, fileId, versionId) {
  const row = getVersion(userId, fileId, versionId);
  const snapshot = JSON.parse(row.manifest_json);
  const file = db.prepare('SELECT id, name, path FROM files WHERE id = ? AND user_id = ?').get(fileId, userId);
  if (!file) throw new Error('File not found');

  const chunks = normalizeManifestChunks(snapshot)
    .slice()
    .sort((a, b) => a.chunk_index - b.chunk_index);

  const reposUsed = {};
  for (const c of chunks) {
    const repo = c.full_name || 'unknown';
    reposUsed[repo] = (reposUsed[repo] || 0) + 1;
  }

  return {
    version: mapVersionRow(row, { isCurrent: false }),
    file: {
      id: file.id,
      name: snapshot.name || file.name,
      path: snapshot.path || file.path,
      size: snapshot.size,
      mime_type: snapshot.mime_type,
      chunk_count: snapshot.chunk_count || chunks.length,
    },
    chunks: chunks.map((c) => ({
      index: c.chunk_index,
      repo: c.full_name,
      path: c.repo_path,
      sha: c.sha,
      encrypted_size: c.size,
      plain_size: c.plain_size || c.size,
      has_chunk_key: !!(c.chunk_iv && c.chunk_tag),
      chunk_iv: c.chunk_iv ? `${String(c.chunk_iv).slice(0, 12)}…` : null,
    })),
    repos_used: reposUsed,
    manifest_sha: row.manifest_sha,
    content_fingerprint: row.content_fingerprint,
    downloadable: snapshotIsDownloadable(snapshot),
    recorded_at: snapshot.recorded_at || row.created_at,
  };
}

module.exports = {
  isEnabled,
  recordVersion,
  recordVersionBeforeReplace,
  backfillVersionsFromGit,
  listVersions,
  getVersion,
  getVersionDetails,
  contentFingerprint,
  listManifestCommits,
  snapshotIsDownloadable,
};
