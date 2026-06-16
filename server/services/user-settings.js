const db = require('../db/database');
const accounts = require('./accounts');
const plexClient = require('./plex-client');

const DEFAULTS = {
  auto_repo_enabled: false,
  auto_repo_interval_minutes: 60,
  auto_repo_gb: 5,
  auto_repo_linked_account_id: null,
  plex_sync_enabled: false,
  plex_library_path: null,
  plex_server_url: plexClient.DEFAULT_PLEX_URL,
  plex_token: null,
  plex_section_key: null,
  plex_sync_interval_minutes: 30,
};

function maskToken(token) {
  if (!token) return null;
  const s = String(token);
  if (s.length <= 8) return '••••••••';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function rowToSettings(row) {
  if (!row) return { ...DEFAULTS, repo_capacity_gb: parseInt(process.env.REPO_CAPACITY_GB || '1', 10) };
  return {
    auto_repo_enabled: !!row.auto_repo_enabled,
    auto_repo_interval_minutes: Math.max(1, parseInt(row.auto_repo_interval_minutes, 10) || DEFAULTS.auto_repo_interval_minutes),
    auto_repo_gb: Math.max(1, parseInt(row.auto_repo_gb, 10) || DEFAULTS.auto_repo_gb),
    auto_repo_linked_account_id: row.auto_repo_linked_account_id ?? null,
    auto_repo_last_run_at: row.auto_repo_last_run_at || null,
    plex_sync_enabled: !!row.plex_sync_enabled,
    plex_library_path: row.plex_library_path || null,
    plex_server_url: row.plex_server_url || DEFAULTS.plex_server_url,
    plex_token_set: !!row.plex_token,
    plex_token_preview: maskToken(row.plex_token),
    plex_section_key: row.plex_section_key || null,
    plex_sync_interval_minutes: Math.max(1, parseInt(row.plex_sync_interval_minutes, 10) || DEFAULTS.plex_sync_interval_minutes),
    plex_last_sync_at: row.plex_last_sync_at || null,
    plex_last_sync_error: row.plex_last_sync_error || null,
    repo_capacity_gb: parseInt(process.env.REPO_CAPACITY_GB || '1', 10),
  };
}

function getSettings(userId) {
  const row = db.prepare(`
    SELECT auto_repo_enabled, auto_repo_interval_minutes, auto_repo_gb,
           auto_repo_linked_account_id, auto_repo_last_run_at,
           plex_sync_enabled, plex_library_path, plex_server_url, plex_token,
           plex_section_key, plex_sync_interval_minutes, plex_last_sync_at, plex_last_sync_error
    FROM users WHERE id = ?
  `).get(userId);
  return rowToSettings(row);
}

function updateSettings(userId, patch = {}) {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const current = rowToSettings(row);
  const next = { ...current };
  const nextToken = patch.plex_token !== undefined ? patch.plex_token : row?.plex_token;

  if (patch.auto_repo_enabled !== undefined) {
    next.auto_repo_enabled = !!patch.auto_repo_enabled;
  }
  if (patch.auto_repo_interval_minutes !== undefined) {
    const minutes = parseInt(patch.auto_repo_interval_minutes, 10);
    if (!Number.isFinite(minutes) || minutes < 1) throw new Error('Interval must be at least 1 minute');
    if (minutes > 24 * 60) throw new Error('Interval cannot exceed 24 hours');
    next.auto_repo_interval_minutes = minutes;
  }
  if (patch.auto_repo_gb !== undefined) {
    const gb = parseInt(patch.auto_repo_gb, 10);
    if (!Number.isFinite(gb) || gb < 1) throw new Error('Storage amount must be at least 1 GB');
    if (gb > 500) throw new Error('Storage amount cannot exceed 500 GB per run');
    next.auto_repo_gb = gb;
  }
  if (patch.auto_repo_linked_account_id !== undefined) {
    if (patch.auto_repo_linked_account_id == null || patch.auto_repo_linked_account_id === '') {
      next.auto_repo_linked_account_id = null;
    } else {
      const linkedAccountId = parseInt(patch.auto_repo_linked_account_id, 10);
      const account = accounts.getLinkedAccount(userId, linkedAccountId);
      if (!account || account.role !== 'storage') throw new Error('Linked storage account not found');
      next.auto_repo_linked_account_id = linkedAccountId;
    }
  }

  if (patch.plex_sync_enabled !== undefined) {
    next.plex_sync_enabled = !!patch.plex_sync_enabled;
  }
  if (patch.plex_library_path !== undefined) {
    const p = String(patch.plex_library_path || '').trim();
    next.plex_library_path = p || null;
    next.plex_section_key = null;
  }
  if (patch.plex_server_url !== undefined) {
    const url = String(patch.plex_server_url || '').trim();
    next.plex_server_url = url || DEFAULTS.plex_server_url;
  }
  if (patch.plex_token !== undefined) {
    const token = String(patch.plex_token || '').trim();
    if (token && token.length < 8) throw new Error('Plex token looks too short');
    next.plex_token_set = !!token;
    next.plex_token_preview = maskToken(token);
  }
  if (patch.plex_section_key !== undefined) {
    next.plex_section_key = patch.plex_section_key ? String(patch.plex_section_key) : null;
  }
  if (patch.plex_sync_interval_minutes !== undefined) {
    const minutes = parseInt(patch.plex_sync_interval_minutes, 10);
    if (!Number.isFinite(minutes) || minutes < 5) throw new Error('Plex sync interval must be at least 5 minutes');
    if (minutes > 24 * 60) throw new Error('Plex sync interval cannot exceed 24 hours');
    next.plex_sync_interval_minutes = minutes;
  }

  db.prepare(`
    UPDATE users SET
      auto_repo_enabled = ?,
      auto_repo_interval_minutes = ?,
      auto_repo_gb = ?,
      auto_repo_linked_account_id = ?,
      plex_sync_enabled = ?,
      plex_library_path = ?,
      plex_server_url = ?,
      plex_token = ?,
      plex_section_key = ?,
      plex_sync_interval_minutes = ?
    WHERE id = ?
  `).run(
    next.auto_repo_enabled ? 1 : 0,
    next.auto_repo_interval_minutes,
    next.auto_repo_gb,
    next.auto_repo_linked_account_id,
    next.plex_sync_enabled ? 1 : 0,
    next.plex_library_path,
    next.plex_server_url,
    patch.plex_token !== undefined ? (String(patch.plex_token || '').trim() || null) : row.plex_token,
    next.plex_section_key,
    next.plex_sync_interval_minutes,
    userId,
  );

  return getSettings(userId);
}

function listAutoRepoCandidates() {
  return db.prepare(`
    SELECT id, auto_repo_enabled, auto_repo_interval_minutes, auto_repo_gb,
           auto_repo_linked_account_id, auto_repo_last_run_at
    FROM users WHERE auto_repo_enabled = 1
  `).all();
}

function listPlexSyncCandidates() {
  return db.prepare(`
    SELECT id, plex_sync_enabled, plex_library_path, plex_server_url, plex_token,
           plex_section_key, plex_sync_interval_minutes, plex_last_sync_at
    FROM users WHERE plex_sync_enabled = 1
  `).all();
}

function markAutoRepoRun(userId) {
  db.prepare('UPDATE users SET auto_repo_last_run_at = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
}

function markPlexSyncRun(userId, error = null) {
  db.prepare(`
    UPDATE users SET
      plex_last_sync_at = CURRENT_TIMESTAMP,
      plex_last_sync_error = ?
    WHERE id = ?
  `).run(error, userId);
}

function getPlexToken(userId) {
  const row = db.prepare('SELECT plex_token FROM users WHERE id = ?').get(userId);
  return row?.plex_token || null;
}

module.exports = {
  getSettings,
  updateSettings,
  listAutoRepoCandidates,
  listPlexSyncCandidates,
  markAutoRepoRun,
  markPlexSyncRun,
  getPlexToken,
};
