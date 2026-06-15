const db = require('../db/database');
const accounts = require('./accounts');

const DEFAULTS = {
  auto_repo_enabled: false,
  auto_repo_interval_minutes: 60,
  auto_repo_gb: 5,
  auto_repo_linked_account_id: null,
};

function rowToSettings(row) {
  if (!row) return { ...DEFAULTS };
  return {
    auto_repo_enabled: !!row.auto_repo_enabled,
    auto_repo_interval_minutes: Math.max(1, parseInt(row.auto_repo_interval_minutes, 10) || DEFAULTS.auto_repo_interval_minutes),
    auto_repo_gb: Math.max(1, parseInt(row.auto_repo_gb, 10) || DEFAULTS.auto_repo_gb),
    auto_repo_linked_account_id: row.auto_repo_linked_account_id ?? null,
    auto_repo_last_run_at: row.auto_repo_last_run_at || null,
    repo_capacity_gb: parseInt(process.env.REPO_CAPACITY_GB || '1', 10),
  };
}

function getSettings(userId) {
  const row = db.prepare(`
    SELECT auto_repo_enabled, auto_repo_interval_minutes, auto_repo_gb,
           auto_repo_linked_account_id, auto_repo_last_run_at
    FROM users WHERE id = ?
  `).get(userId);
  return rowToSettings(row);
}

function updateSettings(userId, patch = {}) {
  const current = getSettings(userId);
  const next = { ...current };

  if (patch.auto_repo_enabled !== undefined) {
    next.auto_repo_enabled = !!patch.auto_repo_enabled;
  }
  if (patch.auto_repo_interval_minutes !== undefined) {
    const minutes = parseInt(patch.auto_repo_interval_minutes, 10);
    if (!Number.isFinite(minutes) || minutes < 1) {
      throw new Error('Interval must be at least 1 minute');
    }
    if (minutes > 24 * 60) {
      throw new Error('Interval cannot exceed 24 hours');
    }
    next.auto_repo_interval_minutes = minutes;
  }
  if (patch.auto_repo_gb !== undefined) {
    const gb = parseInt(patch.auto_repo_gb, 10);
    if (!Number.isFinite(gb) || gb < 1) {
      throw new Error('Storage amount must be at least 1 GB');
    }
    if (gb > 500) {
      throw new Error('Storage amount cannot exceed 500 GB per run');
    }
    next.auto_repo_gb = gb;
  }
  if (patch.auto_repo_linked_account_id !== undefined) {
    if (patch.auto_repo_linked_account_id == null || patch.auto_repo_linked_account_id === '') {
      next.auto_repo_linked_account_id = null;
    } else {
      const linkedAccountId = parseInt(patch.auto_repo_linked_account_id, 10);
      const account = accounts.getLinkedAccount(userId, linkedAccountId);
      if (!account || account.role !== 'storage') {
        throw new Error('Linked storage account not found');
      }
      next.auto_repo_linked_account_id = linkedAccountId;
    }
  }

  db.prepare(`
    UPDATE users SET
      auto_repo_enabled = ?,
      auto_repo_interval_minutes = ?,
      auto_repo_gb = ?,
      auto_repo_linked_account_id = ?
    WHERE id = ?
  `).run(
    next.auto_repo_enabled ? 1 : 0,
    next.auto_repo_interval_minutes,
    next.auto_repo_gb,
    next.auto_repo_linked_account_id,
    userId,
  );

  return getSettings(userId);
}

function listAutoRepoCandidates() {
  return db.prepare(`
    SELECT id, auto_repo_enabled, auto_repo_interval_minutes, auto_repo_gb,
           auto_repo_linked_account_id, auto_repo_last_run_at
    FROM users
    WHERE auto_repo_enabled = 1
  `).all();
}

function markAutoRepoRun(userId) {
  db.prepare('UPDATE users SET auto_repo_last_run_at = CURRENT_TIMESTAMP WHERE id = ?').run(userId);
}

module.exports = {
  getSettings,
  updateSettings,
  listAutoRepoCandidates,
  markAutoRepoRun,
};
