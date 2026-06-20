const express = require('express');
const playlists = require('../services/playlists');

const router = express.Router();

// --- Collections (must be before /:id) ---

router.get('/collections', (req, res) => {
  try {
    res.json({ collections: playlists.listCollections(req.user.id, req) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/collections', (req, res) => {
  try {
    const col = playlists.createCollection(req.user.id, req.body);
    res.status(201).json(col);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/collections/:id', (req, res) => {
  try {
    res.json(playlists.getCollection(req.user.id, req.params.id, req));
  } catch (err) {
    res.status(err.message === 'Collection not found' ? 404 : 500).json({ error: err.message });
  }
});

router.patch('/collections/:id', (req, res) => {
  try {
    res.json(playlists.updateCollection(req.user.id, req.params.id, req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/collections/:id', (req, res) => {
  try {
    res.json(playlists.deleteCollection(req.user.id, req.params.id));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.post('/collections/:id/playlists', (req, res) => {
  try {
    const { playlist_id, position } = req.body;
    res.json(playlists.addPlaylistToCollection(req.user.id, req.params.id, playlist_id, position));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/collections/:id/playlists/:playlistId', (req, res) => {
  try {
    res.json(playlists.removePlaylistFromCollection(req.user.id, req.params.id, req.params.playlistId));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/collections/:id/share', (req, res) => {
  try {
    res.json(playlists.createCollectionShareToken(req.user.id, req.params.id, req));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Playlists ---

router.get('/discover', (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 50);
    res.json({
      continue_watching: playlists.getContinueWatching(req.user.id, limit),
      recent_playlists: playlists.getRecentPlaylists(req.user.id, limit),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/', (req, res) => {
  try {
    res.json({ playlists: playlists.listPlaylists(req.user.id, req) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', (req, res) => {
  try {
    const pl = playlists.createPlaylist(req.user.id, req.body);
    res.status(201).json(pl);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    res.json(playlists.getPlaylist(req.user.id, req.params.id, req));
  } catch (err) {
    res.status(err.message === 'Playlist not found' ? 404 : 500).json({ error: err.message });
  }
});

router.patch('/:id', (req, res) => {
  try {
    res.json(playlists.updatePlaylist(req.user.id, req.params.id, req.body));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    res.json(playlists.deletePlaylist(req.user.id, req.params.id));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

router.post('/:id/duplicate', (req, res) => {
  try {
    res.status(201).json(playlists.duplicatePlaylist(req.user.id, req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/folders', (req, res) => {
  try {
    const { folder_id, include_subfolders, sort_by, sort_order } = req.body;
    res.json(playlists.linkFolder(req.user.id, req.params.id, folder_id, {
      include_subfolders,
      sort_by,
      sort_order,
    }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id/folders/:folderId', (req, res) => {
  try {
    res.json(playlists.unlinkFolder(req.user.id, req.params.id, req.params.folderId));
  } catch (err) {
    res.status(err.message === 'Folder link not found' ? 404 : 400).json({ error: err.message });
  }
});

router.post('/:id/sync', (req, res) => {
  try {
    res.json(playlists.syncPlaylist(req.user.id, req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/items', (req, res) => {
  try {
    const { file_ids, position } = req.body;
    res.json(playlists.addItems(req.user.id, req.params.id, file_ids, { position }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id/items/:fileId', (req, res) => {
  try {
    res.json(playlists.removeItem(req.user.id, req.params.id, req.params.fileId));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/items/remove', (req, res) => {
  try {
    res.json(playlists.removeItems(req.user.id, req.params.id, req.body.file_ids));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/:id/reorder', (req, res) => {
  try {
    res.json(playlists.reorderItems(req.user.id, req.params.id, req.body.file_ids));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/reorder-smart', (req, res) => {
  try {
    const patch = {};
    if (req.body?.sort_regex !== undefined) patch.sort_regex = req.body.sort_regex || null;
    if (req.body?.sort_mode !== undefined) patch.sort_mode = req.body.sort_mode || null;
    if (Object.keys(patch).length) {
      playlists.updatePlaylist(req.user.id, req.params.id, patch);
    }
    res.json(playlists.smartReorderItems(req.user.id, req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/:id/items', (req, res) => {
  try {
    res.json(playlists.updateItemsDisplayNames(req.user.id, req.params.id, req.body.items));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/:id/items/:fileId', (req, res) => {
  try {
    res.json(playlists.updateItemDisplayName(
      req.user.id,
      req.params.id,
      req.params.fileId,
      req.body.display_name,
    ));
  } catch (err) {
    res.status(err.message === 'Playlist not found' || err.message === 'Item not found in playlist' ? 404 : 400)
      .json({ error: err.message });
  }
});

router.post('/:id/share', (req, res) => {
  try {
    res.json(playlists.createShareToken(req.user.id, req.params.id, req));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id/share', (req, res) => {
  try {
    res.json(playlists.revokeShareToken(req.user.id, req.params.id));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:id/progress', (req, res) => {
  try {
    res.json({ progress: playlists.getProgress(req.user.id, req.params.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/progress', (req, res) => {
  try {
    const { file_id, position_seconds, progress_pct, completed } = req.body;
    res.json(playlists.saveProgress(req.user.id, req.params.id, file_id, {
      position_seconds, progress_pct, completed,
    }));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
