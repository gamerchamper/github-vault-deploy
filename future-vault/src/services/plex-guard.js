const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const store = require('./store');

let sidecarDbRepair;
let plexPatches;

function loadRepoServices(config) {
  if (!sidecarDbRepair) {
    sidecarDbRepair = require(path.join(config.repo_root, 'server/services/plex-sidecar-db-repair'));
  }
  if (!plexPatches) {
    plexPatches = require(path.join(config.repo_root, 'server/services/plex-patches'));
  }
  return { sidecarDbRepair, plexPatches };
}

function isPlexRunning() {
  if (process.platform === 'win32') {
    try {
      const out = execSync('tasklist /FI "IMAGENAME eq Plex Media Server.exe" /NH', { encoding: 'utf8' });
      return /Plex Media Server\.exe/i.test(out);
    } catch {
      return null;
    }
  }
  return null;
}

function plexLogMtime() {
  const base = process.env.LOCALAPPDATA || process.env.HOME;
  if (!base) return null;
  const logPath = path.join(base, 'Plex Media Server', 'Logs', 'Plex Media Server.log');
  if (!fs.existsSync(logPath)) return null;
  return fs.statSync(logPath).mtimeMs;
}

function auditLibrary(config) {
  const { sidecarDbRepair } = loadRepoServices(config);
  return sidecarDbRepair.auditVaultLibraryPlayback(config.plex_library_path, {
    sectionKey: config.plex_section_key || null,
  });
}

function repairLibrary(config) {
  const { sidecarDbRepair } = loadRepoServices(config);
  const before = auditLibrary(config);
  if (!before.ok || before.needs_repair === 0) {
    return { ok: true, skipped: true, before, after: before };
  }
  const repair = sidecarDbRepair.repairVaultLibraryFromSidecars(config.plex_library_path, {
    sectionKey: config.plex_section_key || null,
  });
  const after = auditLibrary(config);
  store.patchStatus(config, {
    last_repair_at: new Date().toISOString(),
    last_repair_ready: after.ready,
    last_repair_total: after.total_strm,
  });
  store.appendEvent(config, 'info', `Plex DB repaired ${repair.repaired}/${repair.total_strm}`, {
    before: before.needs_repair,
    after: after.ready,
  });
  return { ok: true, before, repair, after };
}

function ensurePlugins(config) {
  const { plexPatches } = loadRepoServices(config);
  const paths = plexPatches.resolvePaths();
  const steps = [];

  try {
    const deployed = plexPatches.deployUserPlugins(paths.plexDataDir);
    steps.push({ step: 'deploy_plugins', ok: true, detail: deployed });
  } catch (err) {
    steps.push({ step: 'deploy_plugins', ok: false, error: err.message });
  }

  try {
    const prefFiles = plexPatches.writePluginPreferences(paths.plexDataDir, {
      vaultUrl: config.vault_url || '',
      apiKey: config.vault_api_key || '',
      agentUrl: config.agent_url,
      agentApiKey: config.api_key,
    });
    steps.push({ step: 'write_prefs', ok: true, detail: prefFiles });
  } catch (err) {
    steps.push({ step: 'write_prefs', ok: false, error: err.message });
  }

  const ok = steps.every((s) => s.ok !== false);
  store.patchStatus(config, { plugin_ok: ok, plugin_checked_at: new Date().toISOString() });
  if (ok) store.appendEvent(config, 'info', 'Plex plugins verified');
  else store.appendEvent(config, 'warn', 'Plex plugin maintenance had issues', { steps });

  return { ok, steps };
}

async function refreshPlexLibrary(config) {
  if (!config.plex_token || !config.plex_section_key) {
    return { ok: false, skipped: true, reason: 'missing_plex_token_or_section' };
  }
  try {
    const plexClient = require(path.join(config.repo_root, 'server/services/plex-client'));
    const plexUrl = config.plex_server_url || plexClient.DEFAULT_PLEX_URL;
    await plexClient.testConnection(plexUrl, config.plex_token);
    await plexClient.refreshLibrary(plexUrl, config.plex_token, config.plex_section_key, { force: true });
    store.appendEvent(config, 'info', 'Triggered Plex library refresh');
    return { ok: true };
  } catch (err) {
    store.appendEvent(config, 'warn', 'Plex refresh failed', { error: err.message });
    return { ok: false, error: err.message };
  }
}

async function guardTick(config) {
  const running = isPlexRunning();
  store.patchStatus(config, { plex_running: running });

  const logMtime = plexLogMtime();
  const status = store.readStatus(config);
  if (logMtime && status.plex_log_mtime && logMtime > status.plex_log_mtime + 5000) {
    store.patchStatus(config, {
      plex_log_mtime: logMtime,
      plex_last_restart_at: new Date().toISOString(),
      plex_restart_pending_repair: true,
    });
    store.appendEvent(config, 'info', 'Plex restart detected — scheduling repair');
  } else if (logMtime) {
    store.patchStatus(config, { plex_log_mtime: logMtime });
  }

  const freshStatus = store.readStatus(config);
  if (freshStatus.plex_restart_pending_repair) {
    const waitSec = config.repair_after_plex_restart_sec || 45;
    const restartAt = Date.parse(freshStatus.plex_last_restart_at || 0);
    if (Date.now() - restartAt >= waitSec * 1000) {
      store.patchStatus(config, { plex_restart_pending_repair: false });
      if (config.auto_repair !== false) {
        await runSync(config, { prune: false }).catch(() => {});
        repairLibrary(config);
      }
    }
  } else if (config.auto_repair !== false) {
    const audit = auditLibrary(config);
    if (audit.needs_repair > 0) {
      repairLibrary(config);
    }
  }

  if (config.auto_plugin !== false) {
    ensurePlugins(config);
  }
}

async function fullMaintenance(config) {
  const sync = await require('./manifest-sync').runSync(config);
  let refresh = null;
  if (config.plex_token && config.plex_section_key) {
    refresh = await refreshPlexLibrary(config);
    await new Promise((r) => setTimeout(r, 12000));
  }
  const repair = repairLibrary(config);
  return { sync, refresh, repair };
}

module.exports = {
  auditLibrary,
  repairLibrary,
  ensurePlugins,
  refreshPlexLibrary,
  guardTick,
  fullMaintenance,
  isPlexRunning,
};
