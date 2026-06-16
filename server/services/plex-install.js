const apiKeys = require('./api-keys');
const appUrl = require('./app-url');
const userSettings = require('./user-settings');
const plexClient = require('./plex-client');
const plexPatches = require('./plex-patches');
const plexAutoSync = require('./plex-auto-sync');

const LIBRARY_TITLE = 'GitHub Vault';

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
  patchBundled = true,
  runInitialSync = true,
} = {}) {
  const settings = userSettings.getSettings(userId);
  const token = plexToken || userSettings.getPlexToken(userId);
  if (!token) throw new Error('Plex token is required — paste it in Settings or pass plex_token');

  const serverUrl = plexUrl || settings.plex_server_url || plexClient.DEFAULT_PLEX_URL;
  const paths = plexPatches.resolvePaths();
  const libraryPath = plexPatches.ensureVaultLibraryDir(paths.plexDataDir);
  const vaultUrl = appUrl.getAppUrl(req);
  const keyInfo = getOrCreateApiKey(userId);

  if (!keyInfo.key) {
    throw new Error('Could not create Plex integration API key');
  }

  const steps = [];

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
    if (!patchResult.ok) {
      steps.push({
        step: 'bundled_patches_warning',
        ok: false,
        detail: 'Set PLEX_RESOURCES_DIR to your Plex Resources folder if auto-detect failed.',
      });
    }
  }

  await plexClient.testConnection(serverUrl, token);
  steps.push({ step: 'plex_connection', ok: true });

  let libraryResult;
  try {
    libraryResult = await plexClient.ensureLibrarySection(serverUrl, token, libraryPath, {
      title: LIBRARY_TITLE,
      type: 'show',
      agent: 'com.plexapp.agents.none',
      scanner: 'GitHub Vault Scanner',
    });
  } catch (err) {
    libraryResult = await plexClient.ensureLibrarySection(serverUrl, token, libraryPath, {
      title: LIBRARY_TITLE,
      type: 'show',
      agent: 'com.plexapp.agents.none',
      scanner: 'Plex Series Scanner',
    });
    steps.push({ step: 'library_fallback_scanner', ok: true, detail: err.message });
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

  const manifestPath = plexPatches.writeIntegrationManifest(paths.plexDataDir, {
    integrated_at: new Date().toISOString(),
    vault_url: vaultUrl,
    library_path: libraryPath,
    bundled_plugins_dir: paths.bundledPluginsDir,
    plex_data_dir: paths.plexDataDir,
    api_key_id: keyInfo.keyId,
    api_key_preview: keyInfo.key ? `${keyInfo.key.slice(0, 8)}…` : null,
  });
  steps.push({ step: 'manifest', ok: true, path: manifestPath });

  let syncResult = null;
  if (runInitialSync) {
    syncResult = await plexAutoSync.runSyncForUser(userId, req, { force: true });
    steps.push({ step: 'initial_sync', ok: true, stats: syncResult.stats });
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
    restart_plex: true,
    message: 'Integration complete. Restart Plex Media Server so patched plugins load.',
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
