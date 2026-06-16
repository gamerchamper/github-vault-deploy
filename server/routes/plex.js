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
      patchBundled: req.body?.patch_bundled !== false,
      runInitialSync: req.body?.run_initial_sync !== false,
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

router.post('/sync', async (req, res) => {
  try {
    const plexAutoSync = require('../services/plex-auto-sync');
    const result = await plexAutoSync.runSyncForUser(req.user.id, req, { force: true });
    res.json({ success: true, ...result });
  } catch (err) {
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

module.exports = router;
