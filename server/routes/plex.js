const express = require('express');
const plexBridge = require('../services/plex-bridge');
const playlists = require('../services/playlists');

function mapContinueEntry(entry, req) {
  return plexBridge.mapContinueEntry(entry, req);
}

const router = express.Router();

router.get('/hub', (req, res) => {
  try {
    res.json(plexBridge.getHub(req.user.id, req));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/playlists', (req, res) => {
  try {
    res.json({
      playlists: playlists.listPlaylists(req.user.id, req).map((p) => plexBridge.mapPlaylistSummary(p, req)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/playlists/:id', (req, res) => {
  try {
    res.json(plexBridge.getPlaylist(req.user.id, req.params.id, req));
  } catch (err) {
    res.status(err.message === 'Playlist not found' ? 404 : 500).json({ error: err.message });
  }
});

router.get('/collections', (req, res) => {
  try {
    res.json({
      collections: playlists.listCollections(req.user.id, req).map((c) => plexBridge.mapCollectionSummary(c, req)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/collections/:id', (req, res) => {
  try {
    res.json(plexBridge.getCollection(req.user.id, req.params.id, req));
  } catch (err) {
    res.status(err.message === 'Collection not found' ? 404 : 500).json({ error: err.message });
  }
});

router.get('/continue', (req, res) => {
  try {
    const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);
    const items = playlists.getContinueWatching(req.user.id, limit).map((entry) => mapContinueEntry(entry, req));
    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/integrate', async (req, res) => {
  try {
    const plexInstall = require('../services/plex-install');
    const result = await plexInstall.integratePlex(req.user.id, req, {
      plexUrl: req.body?.plex_server_url,
      plexToken: req.body?.plex_token,
      plexLibraryPath: req.body?.plex_library_path,
      patchBundled: req.body?.patch_bundled !== false,
      runInitialSync: req.body?.run_initial_sync !== false,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/install-agent', async (req, res) => {
  try {
    const plexInstall = require('../services/plex-install');
    const result = await plexInstall.installAgentLocally(req.user.id, req, {
      plexUrl: req.body?.plex_server_url,
      plexToken: req.body?.plex_token,
      plexLibraryPath: req.body?.plex_library_path,
      patchBundled: req.body?.patch_bundled !== false,
      applyAgent: req.body?.apply_agent !== false,
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/integration-status', (req, res) => {
  try {
    const plexInstall = require('../services/plex-install');
    res.json(plexInstall.getIntegrationStatus());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/manifest', async (req, res) => {
  try {
    const plexLibrarySync = require('../services/plex-library-sync');
    const prewarm = req.query.prewarm === '1' || req.query.prewarm === 'true';
    const { manifest, stats } = await plexLibrarySync.buildSyncManifest(req.user.id, req);
    if (prewarm) {
      const warmed = await plexLibrarySync.prewarmManifestFiles(req.user.id, manifest);
      return res.json({ manifest: { ...manifest, stats, prewarm: warmed }, stats });
    }
    res.json({ manifest: { ...manifest, stats }, stats });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/prewarm', async (req, res) => {
  try {
    const plexLibrarySync = require('../services/plex-library-sync');
    const fileIds = Array.isArray(req.body?.file_ids) ? req.body.file_ids : [];
    if (fileIds.length) {
      await require('../services/plex-stream-prewarm').prewarmFiles(req.user.id, fileIds);
      return res.json({ success: true, warmed: fileIds.length, file_ids: fileIds });
    }
    const { manifest } = await plexLibrarySync.buildSyncManifest(req.user.id, req);
    const warmed = await plexLibrarySync.prewarmManifestFiles(req.user.id, manifest);
    res.json({ success: true, ...warmed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/refresh', async (req, res) => {
  try {
    const userSettings = require('../services/user-settings');
    const plexClient = require('../services/plex-client');
    const settings = userSettings.getSettings(req.user.id);
    const token = userSettings.getPlexToken(req.user.id);
    if (!token) return res.status(400).json({ error: 'Save a Plex token in Settings first' });
    let sectionKey = settings.plex_section_key;
    if (!sectionKey && settings.plex_library_path) {
      const match = await plexClient.findLibraryForPath(
        settings.plex_server_url,
        token,
        settings.plex_library_path,
      ) || await plexClient.findLibraryByTitle(settings.plex_server_url, token, 'GitHub Vault');
      sectionKey = match?.key || null;
    }
    if (!sectionKey) return res.status(400).json({ error: 'Could not find GitHub Vault library in Plex' });
    const refresh = await plexClient.refreshLibrary(settings.plex_server_url, token, sectionKey);
    userSettings.markPlexSyncRun(req.user.id, null);
    res.json({ success: true, refresh, section_key: sectionKey });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/sync', async (req, res) => {
  try {
    const plexAutoSync = require('../services/plex-auto-sync');
    const plexLibrarySync = require('../services/plex-library-sync');
    const userSettings = require('../services/user-settings');
    const settings = userSettings.getSettings(req.user.id);

    if (req.body?.local_only || !plexLibrarySync.canWriteLibraryPath(settings.plex_library_path)) {
      const { manifest, stats } = await plexLibrarySync.buildSyncManifest(req.user.id, req);
      return res.json({
        success: true,
        local_sync_required: true,
        manifest: { ...manifest, stats },
        stats,
        message: 'This path is on your PC — vault.arktic.top cannot write there. '
          + 'Click "Write to folder on this PC" and select your GitHub Vault folder.',
      });
    }

    const result = await plexAutoSync.runSyncForUser(req.user.id, req, { force: true });
    res.json({ success: true, ...result });
  } catch (err) {
    if (err.code === 'LOCAL_SYNC_REQUIRED') {
      return res.json({
        success: true,
        local_sync_required: true,
        manifest: { ...err.manifest, stats: err.stats },
        stats: err.stats,
        message: err.message,
      });
    }
    res.status(400).json({ error: err.message });
  }
});

router.post('/test', async (req, res) => {
  try {
    const userSettings = require('../services/user-settings');
    const plexClient = require('../services/plex-client');
    const settings = userSettings.getSettings(req.user.id);
    const token = req.body?.plex_token || userSettings.getPlexToken(req.user.id);
    const plexUrl = req.body?.plex_server_url || settings.plex_server_url;
    if (!token) return res.status(400).json({ error: 'Plex token is required' });
    const identity = await plexClient.testConnection(plexUrl, token);
    const libraries = await plexClient.listLibraries(plexUrl, token);
    res.json({ success: true, identity, libraries });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/verify', async (req, res) => {
  try {
    const userSettings = require('../services/user-settings');
    const plexVerify = require('../services/plex-verify');
    const settings = userSettings.getSettings(req.user.id);
    const result = await plexVerify.verifyIntegration(req.user.id, req, {
      fileId: req.query.file_id || null,
      libraryPath: req.query.library_path || settings.plex_library_path,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stream-test/:fileId', async (req, res) => {
  try {
    const db = require('../db/database');
    const plexStreamTest = require('../services/plex-stream-test');
    const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(req.params.fileId, req.user.id);
    if (!file || file.is_folder) return res.status(404).json({ error: 'File not found' });
    const result = await plexStreamTest.testStreamForPlex(req.user.id, file, req);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/stream-test/:fileId/probe', async (req, res) => {
  try {
    const db = require('../db/database');
    const plexMediaProbe = require('../services/plex-media-probe');
    const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(req.params.fileId, req.user.id);
    if (!file || file.is_folder) return res.status(404).json({ error: 'File not found' });
    const probe = await plexMediaProbe.getProbeInfo(req.user.id, file, req, { allowRemoteProbe: true });
    res.json({
      file_id: file.id,
      probe,
      sidecar: plexMediaProbe.sidecarProbeFields(probe),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/libraries', async (req, res) => {
  try {
    const userSettings = require('../services/user-settings');
    const plexClient = require('../services/plex-client');
    const settings = userSettings.getSettings(req.user.id);
    const token = userSettings.getPlexToken(req.user.id);
    if (!token) return res.status(400).json({ error: 'Save a Plex token in Settings first' });
    const libraries = await plexClient.listLibraries(settings.plex_server_url, token);
    res.json({ libraries });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/agent-status', async (req, res) => {
  try {
    const plexPatches = require('../services/plex-patches');
    const plexClient = require('../services/plex-client');
    const userSettings = require('../services/user-settings');
    const audit = plexPatches.auditPlexLayout();
    const token = userSettings.getPlexToken(req.user.id);
    const settings = userSettings.getSettings(req.user.id);
    let plex = null;
    if (token) {
      plex = await plexClient.getAgentRegistrationStatus(settings.plex_server_url, token);
    }
    res.json({
      ok: audit.runtime.ok && (!plex || plex.agent_applied),
      bundle: audit.appdata_agent,
      runtime: audit.runtime,
      plex,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
