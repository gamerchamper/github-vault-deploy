const express = require('express');
const { saveConfig } = require('../config');
const store = require('../services/store');
const vaultUpstream = require('../services/vault-upstream');
const manifestSync = require('../services/manifest-sync');
const plexGuard = require('../services/plex-guard');
const scheduler = require('../services/scheduler');
const { authMiddleware } = require('./plex-api');

function createDashboardRouter(getConfig) {
  const router = express.Router();

  router.get('/api/status', (req, res) => {
    const config = getConfig();
    const audit = plexGuard.auditLibrary(config);
    const status = store.readStatus(config);
    res.json({
      agent_url: config.agent_url,
      api_key: config.api_key,
      vault_url: config.vault_url,
      vault_api_key: config.vault_api_key || '',
      vault_configured: vaultUpstream.vaultConfigured(config),
      vault_online: status.vault_online,
      plex_library_path: config.plex_library_path,
      plex_server_url: config.plex_server_url,
      plex_token: config.plex_token || '',
      plex_section_key: config.plex_section_key,
      sync_interval_minutes: config.sync_interval_minutes,
      auto_sync: config.auto_sync,
      auto_repair: config.auto_repair,
      auto_plugin: config.auto_plugin,
      plex_running: status.plex_running,
      last_sync_at: status.last_sync_at,
      last_sync_error: status.last_sync_error,
      last_sync_source: status.last_sync_source,
      last_repair_at: status.last_repair_at,
      last_repair_ready: status.last_repair_ready,
      playback: audit,
      events: (status.events || []).slice(0, 40),
    });
  });

  router.post('/api/config', express.json(), (req, res) => {
    const allowed = [
      'vault_url', 'vault_api_key', 'plex_library_path', 'plex_server_url',
      'plex_token', 'plex_section_key', 'sync_interval_minutes',
      'auto_sync', 'auto_repair', 'auto_plugin',
    ];
    const secretKeys = new Set(['vault_api_key', 'plex_token']);
    const patch = {};
    for (const key of allowed) {
      if (req.body?.[key] === undefined) continue;
      if (secretKeys.has(key) && req.body[key] === '') continue;
      patch[key] = req.body[key];
    }
    const config = require('../agent').applyConfigPatch(patch);
    res.json({ ok: true, config: {
      vault_url: config.vault_url,
      vault_api_key: config.vault_api_key || '',
      plex_library_path: config.plex_library_path,
      plex_server_url: config.plex_server_url,
      plex_token: config.plex_token || '',
      plex_section_key: config.plex_section_key,
      sync_interval_minutes: config.sync_interval_minutes,
      auto_sync: config.auto_sync,
      auto_repair: config.auto_repair,
      auto_plugin: config.auto_plugin,
      api_key: config.api_key,
    } });
  });

  router.post('/api/sync', authMiddleware(getConfig), async (req, res) => {
    const config = getConfig();
    const result = await manifestSync.runSync(config, { forceRefresh: true });
    if (config.plex_token && config.plex_section_key) {
      await plexGuard.refreshPlexLibrary(config);
      await new Promise((r) => setTimeout(r, 12000));
    }
    const repair = plexGuard.repairLibrary(config);
    res.json({ sync: result, repair });
  });

  router.post('/api/repair', authMiddleware(getConfig), (req, res) => {
    const config = getConfig();
    const repair = plexGuard.repairLibrary(config);
    res.json(repair);
  });

  router.post('/api/plugins', authMiddleware(getConfig), (req, res) => {
    const config = getConfig();
    res.json(plexGuard.ensurePlugins(config));
  });

  router.post('/api/ping-vault', authMiddleware(getConfig), async (req, res) => {
    res.json(await vaultUpstream.pingVault(getConfig()));
  });

  router.post('/api/regenerate-key', authMiddleware(getConfig), (req, res) => {
    const config = getConfig();
    const { generateApiKey } = require('../config');
    config.api_key = generateApiKey();
    saveConfig(config);
    plexGuard.ensurePlugins(config);
    res.json({ ok: true, api_key: config.api_key });
  });

  router.post('/api/maintenance', authMiddleware(getConfig), async (req, res) => {
    res.json(await plexGuard.fullMaintenance(getConfig()));
  });

  return router;
}

module.exports = { createDashboardRouter };
