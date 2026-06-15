const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const cache = require('./cache');

const INTERVAL_MS = Number(process.env.MAINTENANCE_INTERVAL_MS) || 60 * 60 * 1000;
const BANDWIDTH_LOG_RETENTION_DAYS = Number(process.env.BANDWIDTH_LOG_RETENTION_DAYS) || 30;
const SHOUTBOX_RETENTION_DAYS = Number(process.env.SHOUTBOX_RETENTION_DAYS) || 14;

let lastRunAt = null;
let lastStats = {};

function pruneBandwidthLog() {
  const result = db.prepare(`
    DELETE FROM bandwidth_log
    WHERE recorded_at < datetime('now', '-' || ? || ' days')
  `).run(BANDWIDTH_LOG_RETENTION_DAYS);
  return result.changes || 0;
}

function pruneShareShoutbox() {
  try {
    const result = db.prepare(`
      DELETE FROM share_shoutbox
      WHERE created_at < datetime('now', '-' || ? || ' days')
    `).run(SHOUTBOX_RETENTION_DAYS);
    return result.changes || 0;
  } catch {
    return 0;
  }
}

function checkpointWal() {
  try {
    db.pragma('wal_checkpoint(PASSIVE)');
    return true;
  } catch {
    return false;
  }
}

function cleanupOrphanHlsDirs(activeDirs) {
  const cacheDir = cache.cacheDir;
  if (!cacheDir || !fs.existsSync(cacheDir)) return 0;

  let removed = 0;
  for (const name of fs.readdirSync(cacheDir)) {
    if (!name.endsWith('_hls')) continue;
    const dir = path.join(cacheDir, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    if (activeDirs.has(dir)) continue;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed += 1;
    } catch {
      /* ignore */
    }
  }
  return removed;
}

function runMaintenance() {
  const stats = {
    at: new Date().toISOString(),
    bandwidth_rows_deleted: 0,
    shoutbox_rows_deleted: 0,
    wal_checkpoint: false,
    orphan_hls_dirs_removed: 0,
  };

  try {
    stats.bandwidth_rows_deleted = pruneBandwidthLog();
  } catch (err) {
    console.warn('[maintenance] bandwidth prune failed:', err.message);
  }

  try {
    stats.shoutbox_rows_deleted = pruneShareShoutbox();
  } catch (err) {
    console.warn('[maintenance] shoutbox prune failed:', err.message);
  }

  try {
    stats.wal_checkpoint = checkpointWal();
  } catch (err) {
    console.warn('[maintenance] WAL checkpoint failed:', err.message);
  }

  try {
    const github = require('./github');
    stats.github_caches = github.pruneCaches();
  } catch (err) {
    console.warn('[maintenance] github cache prune failed:', err.message);
  }

  try {
    const geoip = require('./geoip');
    stats.geo_cache_pruned = geoip.pruneCache();
  } catch (err) {
    console.warn('[maintenance] geo cache prune failed:', err.message);
  }

  try {
    const chunkLookup = require('./chunk-lookup-cache');
    stats.chunk_lookup_pruned = chunkLookup.pruneExpired();
  } catch (err) {
    console.warn('[maintenance] chunk lookup prune failed:', err.message);
  }

  try {
    const hlsStream = require('./hls-stream');
    stats.hls_sessions = hlsStream.cleanupExpiredSessions();
    stats.orphan_hls_dirs_removed = cleanupOrphanHlsDirs(hlsStream.getActiveSessionDirs());
  } catch (err) {
    console.warn('[maintenance] HLS cleanup failed:', err.message);
  }

  try {
    const chunkSession = require('./chunk-session');
    stats.chunk_sessions = chunkSession.cleanupExpiredSessions();
  } catch (err) {
    console.warn('[maintenance] chunk session cleanup failed:', err.message);
  }

  try {
    const diskCache = require('./disk-cache');
    stats.cache_stale = diskCache.evictStaleEntries();
  } catch (err) {
    console.warn('[maintenance] cache stale eviction failed:', err.message);
  }

  lastRunAt = Date.now();
  lastStats = stats;

  const touched = Object.entries(stats)
    .filter(([key, value]) => key !== 'at' && value && value !== false)
    .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
    .join(', ');

  if (touched) {
    console.log(`[maintenance] ${touched}`);
  }

  return stats;
}

function startMaintenance() {
  setTimeout(() => {
    try { runMaintenance(); } catch (err) {
      console.warn('[maintenance] initial run failed:', err.message);
    }
  }, 30 * 1000);

  setInterval(() => {
    try { runMaintenance(); } catch (err) {
      console.warn('[maintenance] scheduled run failed:', err.message);
    }
  }, INTERVAL_MS);
}

function getStats() {
  return {
    last_run_at: lastRunAt ? new Date(lastRunAt).toISOString() : null,
    interval_ms: INTERVAL_MS,
    last: lastStats,
  };
}

module.exports = {
  runMaintenance,
  startMaintenance,
  getStats,
  pruneBandwidthLog,
  pruneShareShoutbox,
  checkpointWal,
};
