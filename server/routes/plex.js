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

module.exports = router;
