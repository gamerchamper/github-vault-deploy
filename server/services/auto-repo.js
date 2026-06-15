const userSettings = require('./user-settings');
const repoBatch = require('./repo-batch');

const CHECK_INTERVAL_MS = Number(process.env.AUTO_REPO_CHECK_MS) || 60 * 1000;
const runningUsers = new Set();

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
  if (repoBatch.hasActiveBatchTask(userId)) return;

  runningUsers.add(userId);
  try {
    repoBatch.startBatchCreate(userId, {
      gb: userRow.auto_repo_gb,
      linkedAccountId: userRow.auto_repo_linked_account_id || null,
      source: 'auto',
    });
    userSettings.markAutoRepoRun(userId);
    console.log(`[auto-repo] Started batch for user ${userId} (${userRow.auto_repo_gb} GB)`);
  } catch (err) {
    console.warn(`[auto-repo] user ${userId}: ${err.message}`);
  } finally {
    runningUsers.delete(userId);
  }
}

async function tick() {
  for (const userRow of userSettings.listAutoRepoCandidates()) {
    if (!isDue(userRow.auto_repo_last_run_at, userRow.auto_repo_interval_minutes)) continue;
    await runForUser(userRow);
  }
}

function startAutoRepoScheduler() {
  setTimeout(() => {
    tick().catch((err) => console.warn('[auto-repo] initial tick failed:', err.message));
  }, 45 * 1000);

  setInterval(() => {
    tick().catch((err) => console.warn('[auto-repo] tick failed:', err.message));
  }, CHECK_INTERVAL_MS);
}

module.exports = {
  tick,
  startAutoRepoScheduler,
};
