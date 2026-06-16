const apiKeys = require('./api-keys');
const appUrl = require('./app-url');
const fs = require('fs');
const path = require('path');
const userSettings = require('./user-settings');
const plexClient = require('./plex-client');
const plexPatches = require('./plex-patches');
const plexAutoSync = require('./plex-auto-sync');

const LIBRARY_TITLE = 'GitHub Vault';

function resolveLibraryPath(settings, body, serverUrl) {
  const fromBody = String(body?.plex_library_path || '').trim();
  const fromSettings = String(settings?.plex_library_path || '').trim();
  const explicit = fromBody || fromSettings;
  if (explicit) return explicit;

  if (plexClient.isLocalPlexHost(serverUrl)) {
    return plexPatches.ensureVaultLibraryDir(plexPatches.defaultPlexDataDir());
  }

  throw new Error(
    'Set the library folder to a path on your Plex machine before integrating '
    + '(e.g. C:\\Users\\You\\AppData\\Local\\Plex Media Server\\GitHub Vault). '
    + 'Vault cannot guess this path when Plex is on another host.',
  );
}

function shouldInstallLocalFiles(serverUrl) {
  if (process.env.PLEX_INTEGRATE_LOCAL === '1') return true;
  if (process.env.PLEX_INTEGRATE_LOCAL === '0') return false;
  return plexClient.isLocalPlexHost(serverUrl);
}

function getOrCreateApiKey(userId) {
  const keys = apiKeys.listKeys(userId);
  for (const existing of keys) {
    if (!existing.revoked_at && /plex/i.test(existing.name || '')) {
      apiKeys.revokeKey(userId, existing.id);
    }
  }
  const created = apiKeys.createKey(userId, 'Plex integration');
  return { reused: false, keyId: created.id, key: created.key, name: created.name };
}

async function integratePlex(userId, req, {
  plexUrl,
  plexToken,
  plexLibraryPath,
  patchBundled = true,
  runInitialSync = true,
} = {}) {
  const settings = userSettings.getSettings(userId);
  const token = plexToken || userSettings.getPlexToken(userId);
  if (!token) throw new Error('Plex token is required — paste it in Settings or pass plex_token');

  const serverUrl = plexUrl || settings.plex_server_url || plexClient.DEFAULT_PLEX_URL;
  const libraryPath = resolveLibraryPath(settings, { plex_library_path: plexLibraryPath }, serverUrl);
  const installLocal = shouldInstallLocalFiles(serverUrl);
  const paths = plexPatches.resolvePaths();
  const vaultUrl = appUrl.getAppUrl(req);
  const keyInfo = getOrCreateApiKey(userId);

  if (!keyInfo.key) {
    throw new Error('Could not create Plex integration API key');
  }

  const steps = [];

  if (installLocal) {
    fs.mkdirSync(libraryPath, { recursive: true });

    const deployed = plexPatches.deployUserPlugins(paths.plexDataDir);
    steps.push({ step: 'plugins', ok: true, detail: `Deployed ${deployed.length} bundle(s) to ${paths.pluginsDir}` });

    const prefFiles = plexPatches.writePluginPreferences(paths.plexDataDir, {
      vaultUrl,
      apiKey: keyInfo.key,
    });
    steps.push({ step: 'preferences', ok: true, detail: prefFiles });

    if (patchBundled) {
      const patchResult = plexPatches.applyBundledPatches(paths.bundledPluginsDir);
      steps.push({
        step: 'bundled_patches',
        ok: patchResult.ok,
        detail: patchResult.steps || [],
        error: patchResult.error || null,
        bundledPluginsDir: paths.bundledPluginsDir,
      });
    }
  } else {
    steps.push({
      step: 'remote_mode',
      ok: true,
      detail: 'Skipped local plugin/patch install — Plex is not on this server. '
        + 'Copy bundles from integrate/plex/patches and re-run Integrate on the Plex machine, '
        + 'or set PLEX_INTEGRATE_LOCAL=1 if vault shares Plex filesystem.',
    });
  }

  await plexClient.testConnection(serverUrl, token);
  steps.push({ step: 'plex_connection', ok: true });

  let libraryResult;
  try {
    libraryResult = await plexClient.ensureLibrarySection(serverUrl, token, libraryPath, {
      title: LIBRARY_TITLE,
    });
  } catch (err) {
    const hint = /400|path|location|invalid/i.test(err.message)
      ? ' Create the folder on the Plex machine first and use a Windows path Plex can read.'
      : '';
    throw new Error(`${err.message}${hint}`);
  }
  steps.push({
    step: 'library',
    ok: true,
    created: libraryResult.created,
    section_key: libraryResult.section?.key,
    path: libraryPath,
  });

  userSettings.updateSettings(userId, {
    plex_sync_enabled: true,
    plex_library_path: libraryPath,
    plex_server_url: serverUrl,
    plex_token: token,
    plex_section_key: libraryResult.section?.key || null,
  });

  const manifestPath = installLocal
    ? plexPatches.writeIntegrationManifest(paths.plexDataDir, {
      integrated_at: new Date().toISOString(),
      vault_url: vaultUrl,
      library_path: libraryPath,
      bundled_plugins_dir: paths.bundledPluginsDir,
      plex_data_dir: paths.plexDataDir,
      api_key_id: keyInfo.keyId,
      api_key_preview: keyInfo.key ? `${keyInfo.key.slice(0, 8)}…` : null,
      remote_plex: !installLocal,
    })
    : null;
  if (manifestPath) steps.push({ step: 'manifest', ok: true, path: manifestPath });

  let syncResult = null;
  if (runInitialSync) {
    const plexLibrarySync = require('./plex-library-sync');
    if (plexLibrarySync.canWriteLibraryPath(libraryPath)) {
      syncResult = await plexAutoSync.runSyncForUser(userId, req, { force: true });
      steps.push({ step: 'initial_sync', ok: true, stats: syncResult.stats });
    } else {
      const { manifest, stats } = plexLibrarySync.buildSyncManifest(userId, req);
      steps.push({
        step: 'initial_sync_local',
        ok: true,
        stats,
        detail: 'Library linked. Click "Write to folder on this PC" in Settings to populate STRM files.',
        entry_count: manifest.entries.length,
      });
      syncResult = { local_sync_required: true, stats, manifest };
    }
  }

  return {
    success: true,
    library_path: libraryPath,
    plex_data_dir: paths.plexDataDir,
    bundled_plugins_dir: paths.bundledPluginsDir,
    section_key: libraryResult.section?.key || null,
    api_key: keyInfo.key,
    api_key_reused: keyInfo.reused,
    steps,
    sync: syncResult,
    restart_plex: installLocal,
    remote_plex: !installLocal,
    message: installLocal
      ? 'Integration complete. Restart Plex Media Server so patched plugins load.'
      : 'Plex library linked remotely. Install plugins on the Plex machine and run vault locally for sync.',
  };
}

function getIntegrationStatus() {
  const paths = plexPatches.resolvePaths();
  const manifestPath = paths.libraryPath
    ? require('path').join(paths.libraryPath, '.vault-plex-integration.json')
    : null;
  let manifest = null;
  if (manifestPath && require('fs').existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(require('fs').readFileSync(manifestPath, 'utf8'));
    } catch {
      manifest = null;
    }
  }
  return {
    paths,
    manifest,
    plugins_installed: require('fs').existsSync(require('path').join(paths.pluginsDir, 'GitHubVaultAgent.bundle')),
  };
}

module.exports = {
  integratePlex,
  getIntegrationStatus,
};
