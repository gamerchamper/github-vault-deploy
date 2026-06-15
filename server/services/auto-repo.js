const userSettings = require('./user-settings');
const repoBatch = require('./repo-batch');
const tasks = require('./tasks');

const CHECK_INTERVAL_MS = Number(process.env.AUTO_REPO_CHECK_MS) || 60 * 1000;
const runningUsers = new Set();

function taskIdForUser(userId) {
  return `auto-repo-${userId}`;
}

function computeNextRunAt(settings) {
  const intervalMs = Math.max(1, settings.auto_repo_interval_minutes || 60) * 60 * 1000;
  if (!settings.auto_repo_last_run_at) {
    return new Date().toISOString();
  }
  const last = Date.parse(settings.auto_repo_last_run_at);
  if (!Number.isFinite(last)) return new Date().toISOString();
  return new Date(last + intervalMs).toISOString();
}

function buildTitle(userId, settings) {
  const label = repoBatch.accountLabel(userId, settings.auto_repo_linked_account_id);
  const repos = Math.ceil((settings.auto_repo_gb || 1) / repoBatch.REPO_CAPACITY_GB);
  return `Auto storage · ${repos} repo${repos === 1 ? '' : 's'} every ${settings.auto_repo_interval_minutes}m (${label})`;
}

function getAutoRepoTask(userId) {
  return tasks.get(taskIdForUser(userId), userId);
}

function removeAutoRepoTask(userId) {
  tasks.remove(taskIdForUser(userId), userId);
}

function syncAutoRepoTask(userId, settings = null) {
  settings = settings || userSettings.getSettings(userId);
  if (!settings.auto_repo_enabled) {
    removeAutoRepoTask(userId);
    return null;
  }

  const id = taskIdForUser(userId);
  const existing = tasks.get(id, userId);
  if (existing?.status === 'processing' && existing.phase === 'creating') {
    return existing;
  }

  const nextRunAt = computeNextRunAt(settings);
  const reposPerRun = Math.ceil((settings.auto_repo_gb || 1) / repoBatch.REPO_CAPACITY_GB);
  const payload = {
    persistent: true,
    intervalMinutes: settings.auto_repo_interval_minutes,
    gbPerRun: settings.auto_repo_gb,
    linkedAccountId: settings.auto_repo_linked_account_id,
    nextRunAt,
    lastRunAt: settings.auto_repo_last_run_at,
    total: reposPerRun,
    done: 0,
    resumable: false,
  };

  if (!existing) {
    tasks.create(userId, {
      id,
      type: 'auto-repo',
      title: buildTitle(userId, settings),
      payload,
    });
  }

  return tasks.update(id, userId, {
    status: 'pending',
    phase: 'countdown',
    title: buildTitle(userId, settings),
    percent: 0,
    error: null,
    done: 0,
    total: reposPerRun,
    currentRepo: null,
    currentName: null,
    ...payload,
  });
}

function syncFromSettings(userId, settings) {
  return syncAutoRepoTask(userId, settings);
}

function isDue(lastRunAt, intervalMinutes) {
  const intervalMs = Math.max(1, intervalMinutes || 60) * 60 * 1000;
  if (!lastRunAt) return true;
  const last = Date.parse(lastRunAt);
  if (!Number.isFinite(last)) return true;
  return Date.now() - last >= intervalMs;
}

async function runForUser(userRow) {
  const userId = userRow.id;
  if (runningUsers.has(userId)) return;

  const autoTask = getAutoRepoTask(userId);
  if (autoTask?.status === 'processing') return;
  if (repoBatch.hasActiveBatchTask(userId)) return;

  const settings = userSettings.getSettings(userId);
  const count = Math.ceil((settings.auto_repo_gb || 1) / repoBatch.REPO_CAPACITY_GB);
  const linkedAccountId = settings.auto_repo_linked_account_id || null;
  const taskId = taskIdForUser(userId);

  syncAutoRepoTask(userId, settings);
  runningUsers.add(userId);

  try {
    await repoBatch.runBatchCreate(userId, taskId, {
      count,
      linkedAccountId,
      source: 'auto',
      persistent: true,
    });
    userSettings.markAutoRepoRun(userId);
    syncAutoRepoTask(userId, userSettings.getSettings(userId));
    console.log(`[auto-repo] Completed batch for user ${userId} (${settings.auto_repo_gb} GB)`);
  } catch (err) {
    console.warn(`[auto-repo] user ${userId}: ${err.message}`);
    tasks.update(taskId, userId, {
      status: 'pending',
      phase: 'countdown',
      error: err.message,
      lastLog: `Run failed: ${err.message}`,
    });
  } finally {
    runningUsers.delete(userId);
  }
}

async function tick() {
  for (const userRow of userSettings.listAutoRepoCandidates()) {
    const settings = userSettings.getSettings(userRow.id);
    syncAutoRepoTask(userRow.id, settings);
    if (isDue(userRow.auto_repo_last_run_at, userRow.auto_repo_interval_minutes)) {
      await runForUser(userRow);
    }
  }
}

function syncAllEnabled() {
  for (const userRow of userSettings.listAutoRepoCandidates()) {
    syncAutoRepoTask(userRow.id, userSettings.getSettings(userRow.id));
  }
}

function startAutoRepoScheduler() {
  setTimeout(() => {
    try {
      syncAllEnabled();
      tick().catch((err) => console.warn('[auto-repo] initial tick failed:', err.message));
    } catch (err) {
      console.warn('[auto-repo] initial sync failed:', err.message);
    }
  }, 45 * 1000);

  setInterval(() => {
    tick().catch((err) => console.warn('[auto-repo] tick failed:', err.message));
  }, CHECK_INTERVAL_MS);
}

module.exports = {
  taskIdForUser,
  computeNextRunAt,
  syncAutoRepoTask,
  syncFromSettings,
  removeAutoRepoTask,
  tick,
  startAutoRepoScheduler,
};
