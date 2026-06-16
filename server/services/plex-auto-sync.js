const db = require('../db/database');
const userSettings = require('./user-settings');
const plexLibrarySync = require('./plex-library-sync');
const plexClient = require('./plex-client');
const appUrl = require('./app-url');

const runningUsers = new Set();

function getPlexSettings(userId) {
  return userSettings.getSettings(userId);
}

function isDue(lastRunAt, intervalMinutes) {
  const intervalMs = Math.max(1, intervalMinutes || 30) * 60 * 1000;
  if (!lastRunAt) return true;
  const last = Date.parse(lastRunAt);
  if (!Number.isFinite(last)) return true;
  return Date.now() - last >= intervalMs;
}

async function runSyncForUser(userId, req, { force = false } = {}) {
  if (runningUsers.has(userId)) {
    throw new Error('Plex sync is already running');
  }

  const settings = userSettings.getSettings(userId);
  const token = userSettings.getPlexToken(userId);
  if (!settings.plex_sync_enabled && !force) {
    throw new Error('Plex library sync is disabled');
  }
  if (!settings.plex_library_path) {
    throw new Error('Set a Plex library folder path in Settings');
  }
  if (!token) {
    throw new Error('Set your Plex token in Settings');
  }

  runningUsers.add(userId);
  try {
    const syncResult = await plexLibrarySync.syncLibrary(
      userId,
      req,
      settings.plex_library_path,
      { prune: true },
    );

    let sectionKey = settings.plex_section_key || null;
    if (!sectionKey && settings.plex_server_url && token) {
      const match = await plexClient.findLibraryForPath(
        settings.plex_server_url,
        token,
        settings.plex_library_path,
      );
      if (match?.key) {
        sectionKey = match.key;
        userSettings.updateSettings(userId, { plex_section_key: sectionKey });
      }
    }

    let refresh = null;
    if (sectionKey) {
      refresh = await plexClient.refreshLibrary(
        settings.plex_server_url || plexClient.DEFAULT_PLEX_URL,
        token,
        sectionKey,
      );
    }

    userSettings.markPlexSyncRun(userId, null);
    return {
      ...syncResult,
      refresh,
      section_key: sectionKey,
    };
  } catch (err) {
    userSettings.markPlexSyncRun(userId, err.message);
    throw err;
  } finally {
    runningUsers.delete(userId);
  }
}

async function tick() {
  for (const row of userSettings.listPlexSyncCandidates()) {
    if (!isDue(row.plex_last_sync_at, row.plex_sync_interval_minutes)) continue;
    const fakeReq = { get: () => null, secure: appUrl.isSecureAppUrl() };
    try {
      await runSyncForUser(row.id, fakeReq);
      console.log(`[plex-sync] Synced library for user ${row.id}`);
    } catch (err) {
      console.warn(`[plex-sync] user ${row.id}: ${err.message}`);
    }
  }
}

function startPlexAutoSync() {
  const intervalMs = Number(process.env.PLEX_SYNC_CHECK_MS) || 5 * 60 * 1000;
  setTimeout(() => {
    tick().catch((err) => console.warn('[plex-sync] initial tick failed:', err.message));
  }, 60 * 1000);

  setInterval(() => {
    tick().catch((err) => console.warn('[plex-sync] tick failed:', err.message));
  }, intervalMs);
}

module.exports = {
  getPlexSettings,
  runSyncForUser,
  tick,
  startPlexAutoSync,
};
