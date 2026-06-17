const path = require('path');
const userSettings = require('./user-settings');
const sidecarDbRepair = require('./plex-sidecar-db-repair');

const lastRepairAt = new Map();
const MIN_REPAIR_GAP_MS = Number(process.env.PLEX_DB_WATCHDOG_MIN_GAP_MS) || 60 * 1000;
const BROKEN_REPAIR_GAP_MS = Number(process.env.PLEX_DB_WATCHDOG_BROKEN_GAP_MS) || 10 * 1000;

function collectRepairTargets() {
  const targets = new Map();

  for (const libraryPath of sidecarDbRepair.discoverVaultLibraryPaths()) {
    const key = path.resolve(libraryPath).toLowerCase();
    targets.set(key, {
      libraryPath,
      sectionKey: null,
      label: 'discovered',
    });
  }

  for (const row of userSettings.listPlexSyncCandidates()) {
    if (!row.plex_library_path) continue;
    const key = path.resolve(row.plex_library_path).toLowerCase();
    targets.set(key, {
      libraryPath: row.plex_library_path,
      sectionKey: row.plex_section_key || null,
      label: `user-${row.id}`,
    });
  }

  return [...targets.values()];
}

async function repairIfNeeded({ libraryPath, sectionKey = null, label = 'default' }) {
  if (!libraryPath) return null;

  const audit = sidecarDbRepair.auditVaultLibraryPlayback(libraryPath, { sectionKey });
  if (!audit.ok || audit.needs_repair === 0) {
    return { label, skipped: true, audit };
  }

  const key = path.resolve(libraryPath).toLowerCase();
  const gap = audit.needs_repair > 0 ? BROKEN_REPAIR_GAP_MS : MIN_REPAIR_GAP_MS;
  const last = lastRepairAt.get(key) || 0;
  if (Date.now() - last < gap) {
    return { label, skipped: true, reason: 'cooldown', audit };
  }

  const repair = sidecarDbRepair.repairVaultLibraryFromSidecars(libraryPath, { sectionKey });
  lastRepairAt.set(key, Date.now());
  console.log(
    `[plex-db-watchdog] ${label}: repaired ${repair.repaired}/${repair.total_strm}`
    + ` (audit had ${audit.needs_repair} broken)`,
  );
  return { label, audit, repair };
}

async function repairIfNeededForUser(row) {
  return repairIfNeeded({
    libraryPath: row.plex_library_path,
    sectionKey: row.plex_section_key || null,
    label: `user-${row.id}`,
  });
}

async function tick() {
  let anyBroken = false;
  for (const target of collectRepairTargets()) {
    try {
      const result = await repairIfNeeded(target);
      if (result?.audit?.needs_repair > 0) anyBroken = true;
    } catch (err) {
      console.warn(`[plex-db-watchdog] ${target.label}: ${err.message}`);
    }
  }
  return anyBroken;
}

function startPlexDbWatchdog() {
  const okIntervalMs = Number(process.env.PLEX_DB_WATCHDOG_MS) || 90 * 1000;
  const brokenIntervalMs = Number(process.env.PLEX_DB_WATCHDOG_BROKEN_MS) || 15 * 1000;

  const schedule = () => {
    tick()
      .then((anyBroken) => {
        setTimeout(schedule, anyBroken ? brokenIntervalMs : okIntervalMs);
      })
      .catch((err) => {
        console.warn('[plex-db-watchdog] tick failed:', err.message);
        setTimeout(schedule, brokenIntervalMs);
      });
  };

  schedule();
}

module.exports = {
  collectRepairTargets,
  repairIfNeeded,
  repairIfNeededForUser,
  tick,
  startPlexDbWatchdog,
};
