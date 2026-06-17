const store = require('./store');
const vaultUpstream = require('./vault-upstream');
const manifestSync = require('./manifest-sync');
const plexGuard = require('./plex-guard');

let schedulerConfig = null;
let syncTimer = null;
let guardTimer = null;

function msFromMinutes(min) {
  return Math.max(1, Number(min) || 15) * 60 * 1000;
}

async function syncTick(config) {
  if (config.auto_sync === false) return;
  try {
    await vaultUpstream.pingVault(config);
    await manifestSync.runSync(config);
    if (config.plex_token && config.plex_section_key) {
      await plexGuard.refreshPlexLibrary(config);
      await new Promise((r) => setTimeout(r, 12000));
    }
    plexGuard.repairLibrary(config);
  } catch (err) {
    store.appendEvent(config, 'error', 'Scheduled sync failed', { error: err.message });
  }
}

function startScheduler(config) {
  schedulerConfig = config;
  const syncMs = msFromMinutes(config.sync_interval_minutes);
  const guardMs = Number(process.env.FUTURE_VAULT_GUARD_MS) || 15000;

  setTimeout(() => syncTick(config).catch(() => {}), 8000);
  syncTimer = setInterval(() => syncTick(config).catch(() => {}), syncMs);

  setTimeout(() => plexGuard.guardTick(config).catch(() => {}), 5000);
  guardTimer = setInterval(() => plexGuard.guardTick(config).catch(() => {}), guardMs);

  store.appendEvent(config, 'info', 'Future Vault scheduler started', {
    sync_minutes: config.sync_interval_minutes,
    guard_ms: guardMs,
  });
}

function stopScheduler() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  if (guardTimer) {
    clearInterval(guardTimer);
    guardTimer = null;
  }
}

function restartScheduler(config) {
  stopScheduler();
  if (config) startScheduler(config);
}

module.exports = {
  startScheduler,
  stopScheduler,
  restartScheduler,
  syncTick,
};
