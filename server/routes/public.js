const express = require('express');
const storage = require('../services/storage');
const streaming = require('../services/streaming');
const { recordBytes } = require('../services/bandwidth');
const hlsStream = require('../services/hls-stream');
const sharePresence = require('../services/share-presence');
const geoip = require('../services/geoip');
const appUrl = require('../services/app-url');
const shareEmbed = require('../services/share-embed');
const accounts = require('../services/accounts');
const github = require('../services/github');
const db = require('../db/database');
const playlists = require('../services/playlists');
const mediaCache = require('../services/media-cache-headers');

const router = express.Router();

function sharePublisherMeta(userId, file = null) {
  const user = db.prepare('SELECT username, avatar_url FROM users WHERE id = ?').get(userId);
  return {
    shared_by: user?.username || 'Vault user',
    shared_by_avatar: user?.avatar_url || null,
    shared_at: file?.updated_at || file?.created_at || null,
  };
}

async function clientInfoFromRequest(req) {
  const ip = geoip.getClientIp(req);
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 512);
  const geo = await geoip.lookupGeo(ip);
  return { ip, userAgent, geo };
}

function setPresenceRoomMeta(req, token, shared) {
  sharePresence.setRoomMeta(token, {
    userId: shared.user_id,
    fileId: shared.id,
    fileName: shared.name,
    isFolder: !!shared.is_folder,
    shareUrl: appUrl.publicUrl(req, `/share/${token}`),
  });
}

function requireShareToken(req, res) {
  const item = storage.getSharedByToken(req.params.token);
  if (!item) {
    res.status(404).json({ error: 'Share not found' });
    return null;
  }
  return item;
}

function resolveShareFile(req, res) {
  const fileId = req.query.file || null;
  const file = storage.resolveSharedFile(req.params.token, fileId);
  if (!file) {
    res.status(404).json({ error: 'Share not found' });
    return null;
  }
  return file;
}

function clientStreamOnly(req, res, file) {
  if (!storage.getShareClientStreamEnabled(file.user_id)) return false;
  res.status(410).json({
    error: 'Server streaming disabled — decrypt in browser',
    client_stream: true,
  });
  return true;
}

router.get('/share/:token/info', async (req, res) => {
  try {
    const shared = storage.getSharedByToken(req.params.token);
    if (!shared) return res.status(404).json({ error: 'Share not found' });

    const clientStream = storage.getShareClientStreamEnabled(shared.user_id);
    const fileId = req.query.file || null;

    if (shared.is_folder && fileId) {
      const file = storage.resolveSharedFile(req.params.token, fileId);
      if (!file) return res.status(404).json({ error: 'Share not found' });
      const hlsSegCount = file.has_hls ? (db.prepare('SELECT COUNT(*) as n FROM hls_segments WHERE file_id = ?').get(file.id)?.n || 0) : 0;
      return res.json({
        id: file.id,
        name: file.name,
        size: file.size,
        mime_type: file.mime_type,
        chunk_count: file.chunk_count,
        has_thumbnail: await storage.shareThumbnailAvailable(file),
        is_folder: false,
        parent_folder: shared.name,
        client_stream: clientStream,
        hls_available: !!(file.has_hls),
        hls_segment_count: hlsSegCount,
        ...sharePublisherMeta(shared.user_id, file),
      });
    }

    if (shared.is_folder) {
      const listing = storage.listSharedFolder(req.params.token);
      const fileCount = listing.files.filter((f) => !f.is_folder).length;
      const folderCount = listing.files.filter((f) => f.is_folder).length;
      return res.json({
        name: shared.name,
        is_folder: true,
        path: shared.path,
        file_count: fileCount,
        folder_count: folderCount,
        item_count: listing.files.length,
        client_stream: clientStream,
        ...sharePublisherMeta(shared.user_id, shared),
      });
    }

    const sharedHasHls = !!(shared.has_hls);
    const hlsSegCount = sharedHasHls ? (db.prepare('SELECT COUNT(*) as n FROM hls_segments WHERE file_id = ?').get(shared.id)?.n || 0) : 0;
    res.json({
      id: shared.id,
      name: shared.name,
      size: shared.size,
      mime_type: shared.mime_type,
      chunk_count: shared.chunk_count,
      has_thumbnail: await storage.shareThumbnailAvailable(shared),
      is_folder: false,
      client_stream: clientStream,
      hls_available: sharedHasHls,
      hls_segment_count: hlsSegCount,
      ...sharePublisherMeta(shared.user_id, shared),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/share/:token/list', (req, res) => {
  try {
    const listing = storage.listSharedFolder(req.params.token, req.query.path || null);
    if (!listing) return res.status(404).json({ error: 'Share not found' });
    res.json(listing);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/share/:token/manifest', async (req, res) => {
  try {
    const fileId = req.query.file || null;
    const manifest = await storage.getShareManifest(req.params.token, fileId);
    res.json(manifest);
  } catch (err) {
    res.status(err.message === 'Share not found' ? 404 : 400).json({ error: err.message });
  }
});

router.get('/share/:token/hls', async (req, res) => {
  try {
    const fileId = req.query.file || null;
    const manifest = await storage.getShareManifest(req.params.token, fileId);
    if (!manifest) {
      return res.status(404).json({ error: 'Share not found' });
    }
    if (!manifest.hls_available || !manifest.hls_playlist_url) {
      return res.status(404).json({ error: 'HLS playlist not available' });
    }

    const playlistRes = await fetch(manifest.hls_playlist_url);
    if (!playlistRes.ok) {
      return res.status(502).json({ error: 'Failed to fetch playlist from storage' });
    }
    const content = await playlistRes.text();
    const baseName = (manifest.name || 'media').replace(/\.[^.]+$/, '');
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Content-Disposition', `inline; filename="${encodeURIComponent(baseName)}.m3u8"`);
    res.set('Access-Control-Allow-Origin', '*');
    res.send(Buffer.from(content, 'utf8'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/share/:token/chunk/:index', async (req, res) => {
  try {
    const fileId = req.query.file || null;
    const index = parseInt(req.params.index, 10);
    if (!Number.isFinite(index) || index < 0) {
      return res.status(400).json({ error: 'Invalid chunk index' });
    }
    const { buffer, chunk } = await storage.getShareEncryptedChunk(
      req.params.token,
      fileId,
      index
    );
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('X-Chunk-Index', String(chunk.chunk_index));
    res.setHeader('X-Plain-Size', String(chunk.plain_size || chunk.size));
    mediaCache.setMediaCacheHeaders(res, { scope: 'private' });
    const etag = mediaCache.etagFromParts(req.params.token, fileId, index, chunk.sha || chunk.size);
    if (mediaCache.sendNotModifiedIfMatch(req, res, etag)) return;
    res.send(buffer);
  } catch (err) {
    const code = err.message === 'Share not found' ? 404
      : err.message.includes('disabled') ? 403 : 500;
    res.status(code).json({ error: err.message });
  }
});

router.get('/share/:token/status', (req, res) => {
  try {
    const file = resolveShareFile(req, res);
    if (!file) return;
    res.json(streaming.getStatus(file.user_id, file.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/share/:token/hls/playlist.m3u8', async (req, res) => {
  try {
    const file = resolveShareFile(req, res);
    if (!file) return;
    if (clientStreamOnly(req, res, file)) return;
    const base = `/api/public/share/${req.params.token}/hls`;
    const baseName = (file.name || 'media').replace(/\.[^.]+$/, '');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(baseName)}.m3u8"`);
    await hlsStream.servePlaylist(req, res, file.user_id, file.id, base);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

router.get('/share/:token/hls/github-playlist', async (req, res) => {
  try {
    const fileId = req.query.file || null;
    const manifest = await storage.getShareManifest(req.params.token, fileId);
    if (!manifest || !manifest.hls_available || !manifest.hls_playlist_url) {
      return res.status(404).json({ error: 'HLS playlist not available' });
    }
    res.json({ url: manifest.hls_playlist_url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/share/:token/hls/segment/:index.ts', async (req, res) => {
  try {
    const file = resolveShareFile(req, res);
    if (!file) return;
    if (clientStreamOnly(req, res, file)) return;
    await hlsStream.serveSegment(req, res, file.user_id, file.id, req.params.index);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

router.get('/share/:token/thumbnail', async (req, res) => {
  try {
    const file = resolveShareFile(req, res);
    if (!file) return;

    const thumb = await storage.getShareThumbnail(file);
    if (!thumb) return res.status(404).end();

    const etag = mediaCache.etagFromParts(file.id, file.updated_at || file.created_at, mediaCache.etagFromBuffer(thumb));
    if (mediaCache.sendNotModifiedIfMatch(req, res, etag)) return;

    res.setHeader('Content-Type', 'image/jpeg');
    mediaCache.setMediaCacheHeaders(res, { scope: 'public' });
    res.send(thumb);
  } catch {
    res.status(404).end();
  }
});

router.get('/share/:token/embed/stream', async (req, res) => {
  try {
    const file = resolveShareFile(req, res);
    if (!file) return;
    if (!shareEmbed.isEmbedCrawler(req)) {
      return res.status(403).json({ error: 'Embed stream is for link preview crawlers only' });
    }
    await streaming.streamPublic(req, res, file);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

router.get('/share/:token/stream', async (req, res) => {
  try {
    const file = resolveShareFile(req, res);
    if (!file) return;
    const onFinish = (bytes) => { if (bytes > 0) recordBytes(file.user_id, file.id, bytes, 'stream'); };
    res.on('finish', () => {
      const len = parseInt(res.getHeader('Content-Length') || '0', 10);
      if (len > 0) recordBytes(file.user_id, file.id, len, 'stream');
    });
    await streaming.streamPublic(req, res, file);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

router.post('/share/:token/stream/start', (req, res) => {
  try {
    const file = resolveShareFile(req, res);
    if (!file) return;
    if (storage.getShareClientStreamEnabled(file.user_id)) {
      return res.json({ ok: true, client_stream: true });
    }
    const viewerId = String(req.body?.viewer_id || '').slice(0, 64);
    if (!viewerId) return res.status(400).json({ error: 'viewer_id required' });

    const { registerStreamViewer } = require('../services/chunk-session');
    registerStreamViewer(file.user_id, file.id, viewerId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/share/:token/stream/stop', (req, res) => {
  try {
    const file = resolveShareFile(req, res);
    if (!file) return;
    const viewerId = String(req.body?.viewer_id || '').slice(0, 64);
    if (!viewerId) return res.status(400).json({ error: 'viewer_id required' });

    hlsStream.releaseShareStream(file.user_id, file.id, viewerId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/share/:token/presence/join', async (req, res) => {
  try {
    const shared = requireShareToken(req, res);
    if (!shared) return;
    const viewerId = String(req.body?.viewer_id || '').slice(0, 64);
    if (!viewerId) return res.status(400).json({ error: 'viewer_id required' });

    setPresenceRoomMeta(req, req.params.token, shared);
    const clientInfo = await clientInfoFromRequest(req);
    const viewer = sharePresence.join(req.params.token, viewerId, clientInfo);
    res.json({ viewer, viewers: sharePresence.listViewers(req.params.token) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/share/:token/presence/heartbeat', async (req, res) => {
  try {
    const shared = requireShareToken(req, res);
    if (!shared) return;
    const viewerId = String(req.body?.viewer_id || '').slice(0, 64);
    if (!viewerId) return res.status(400).json({ error: 'viewer_id required' });

    const clientInfo = await clientInfoFromRequest(req);
    const viewer = sharePresence.heartbeat(req.params.token, viewerId, clientInfo);
    if (!viewer) return res.status(404).json({ error: 'Not in room' });
    res.json({ viewers: sharePresence.listViewers(req.params.token) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/share/:token/presence/leave', (req, res) => {
  const viewerId = String(req.body?.viewer_id || '').slice(0, 64);
  if (viewerId) sharePresence.leave(req.params.token, viewerId);
  res.json({ success: true });
});

router.get('/share/:token/presence', (req, res) => {
  if (!requireShareToken(req, res)) return;
  res.json({ viewers: sharePresence.listViewers(req.params.token) });
});

router.get('/share/:token/presence/stream', (req, res) => {
  if (!requireShareToken(req, res)) return;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  sharePresence.subscribe(req.params.token, res);

  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(ping);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(ping);
    sharePresence.unsubscribe(req.params.token, res);
  });
});

// shoutbox
router.get('/share/:token/shoutbox', (req, res) => {
  try {
    const db = require('../db/database');
    const token = req.params.token;
    const fileId = req.query.file || null;
    const since = req.query.since || '0';
    const limit = Math.min(parseInt(req.query.limit) || 100, 200);

    let query = 'SELECT id, viewer_id, viewer_name, message, position, created_at FROM share_shoutbox WHERE share_token = ?';
    const params = [token];

    if (fileId) { query += ' AND file_id = ?'; params.push(fileId); }
    query += ' AND id > ?';
    params.push(since);
    query += ' ORDER BY id ASC LIMIT ?';
    params.push(limit);

    const messages = db.prepare(query).all(...params);
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/share/:token/shoutbox', (req, res) => {
  try {
    const db = require('../db/database');
    const token = req.params.token;
    const { file_id, viewer_id, viewer_name, message, position } = req.body || {};
    if (!viewer_id || !message) return res.status(400).json({ error: 'viewer_id and message required' });
    if (typeof message !== 'string' || message.length > 500) return res.status(400).json({ error: 'Message too long' });
    const safeName = (viewer_name || 'Anonymous').slice(0, 32);
    const result = db.prepare(
      'INSERT INTO share_shoutbox (share_token, file_id, viewer_id, viewer_name, message, position) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(token, file_id || null, viewer_id, safeName, message.trim().slice(0, 500), typeof position === 'number' ? position : null);
    res.json({ id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const downloadSession = require('../services/download-session');

function startPublicDownloadJob(file, sessionId) {
  const db = require('../db/database');
  const meta = db.prepare('SELECT chunk_count FROM files WHERE id = ?').get(file.id);
  const chunks = db.prepare('SELECT COUNT(*) as n FROM chunks WHERE file_id = ?').get(file.id);
  const total = meta?.chunk_count || chunks?.n || 1;
  downloadSession.update(sessionId, { total });

  storage.downloadFileWithProgress(
    file.user_id,
    file.id,
    (fetched, chunkTotal, stage) => {
      downloadSession.update(sessionId, {
        fetched,
        total: chunkTotal || total,
        stage: stage || 'fetching',
      });
    }
  ).then(({ buffer, file: fileMeta }) => {
    downloadSession.complete(sessionId, buffer, fileMeta);
  }).catch((err) => {
    downloadSession.fail(sessionId, err.message);
  });
}

router.post('/share/:token/download/prepare', (req, res) => {
  try {
    const file = resolveShareFile(req, res);
    if (!file) return;

    if (storage.getShareClientStreamEnabled(file.user_id)) {
      return res.status(410).json({
        error: 'Use client-side download',
        client_stream: true,
      });
    }

    const sessionId = downloadSession.create({
      userId: file.user_id,
      fileId: file.id,
      token: req.params.token,
    });
    const session = downloadSession.get(sessionId);
    startPublicDownloadJob(file, sessionId);

    res.json({
      sessionId,
      authToken: session.authToken,
      expiresAt: session.createdAt + downloadSession.TTL_MS,
      total: file.chunk_count || 1,
      fileName: file.name,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/share/:token/download/status/:sessionId', (req, res) => {
  const file = resolveShareFile(req, res);
  if (!file) return;

  const session = downloadSession.get(req.params.sessionId);
  if (!session || session.token !== req.params.token || session.fileId !== file.id) {
    return res.status(404).json({ error: 'Session not found' });
  }
  res.json(downloadSession.toStatus(session));
});

router.get('/share/:token/download', async (req, res) => {
  try {
    const file = resolveShareFile(req, res);
    if (!file) return;

    const sessionId = req.query.session;
    const authToken = req.query.auth;
    if (sessionId) {
      const session = downloadSession.validate(sessionId, authToken);
      if (!session || session.token !== req.params.token || session.fileId !== file.id) {
        return res.status(404).json({ error: 'Download session not found or expired' });
      }
      if (session.error) return res.status(500).json({ error: session.error });
      if (!session.ready || !session.buffer) {
        return res.status(202).json(downloadSession.toStatus(session));
      }

      return downloadSession.sendPreparedFile(res, session, file.mime_type, file.name);
    }

    const { buffer } = await storage.downloadFile(file.user_id, file.id);
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
    recordBytes(file.user_id, file.id, buffer.length, 'download');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Playlist & collection public shares ---

router.get('/playlist/:token', (req, res) => {
  try {
    const playlist = playlists.getByShareToken(req.params.token, req);
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
    res.json(playlist);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/playlist/:token/info', async (req, res) => {
  try {
    const fileId = req.query.file;
    const file = playlists.resolvePlaylistFile(req.params.token, fileId);
    if (!file) return res.status(404).json({ error: 'Not found' });
    const playlist = playlists.getByShareToken(req.params.token);
    const clientStream = storage.getShareClientStreamEnabled(file.user_id);
    const hlsSegCount = file.has_hls
      ? (db.prepare('SELECT COUNT(*) as n FROM hls_segments WHERE file_id = ?').get(file.id)?.n || 0)
      : 0;
    const hlsDuration = file.has_hls
      ? (db.prepare('SELECT COALESCE(SUM(duration), 0) as total FROM hls_segments WHERE file_id = ?').get(file.id)?.total || 0)
      : 0;
    res.json({
      id: file.id,
      name: file.name,
      size: file.size,
      mime_type: file.mime_type,
      chunk_count: file.chunk_count,
      has_thumbnail: await storage.shareThumbnailAvailable(file),
      is_folder: false,
      playlist_id: playlist?.id,
      playlist_title: playlist?.title,
      client_stream: clientStream,
      hls_available: !!file.has_hls,
      hls_segment_count: hlsSegCount,
      hls_duration_sec: Number(hlsDuration) || 0,
      ...sharePublisherMeta(file.user_id, file),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/playlist/:token/thumbnail', async (req, res) => {
  try {
    const file = playlists.resolvePlaylistFile(req.params.token, req.query.file);
    if (!file) return res.status(404).end();
    const thumb = await storage.getShareThumbnail(file);
    if (!thumb) return res.status(404).end();
    const etag = mediaCache.etagFromParts(file.id, file.updated_at || file.created_at, mediaCache.etagFromBuffer(thumb));
    if (mediaCache.sendNotModifiedIfMatch(req, res, etag)) return;
    res.setHeader('Content-Type', 'image/jpeg');
    mediaCache.setMediaCacheHeaders(res, { scope: 'public' });
    res.send(thumb);
  } catch {
    res.status(404).end();
  }
});

router.get('/playlist/:token/stream', async (req, res) => {
  try {
    const fileId = req.query.file;
    const file = playlists.resolvePlaylistFile(req.params.token, fileId);
    if (!file) return res.status(404).json({ error: 'Not found' });
    res.on('finish', () => {
      const len = parseInt(res.getHeader('Content-Length') || '0', 10);
      if (len > 0) recordBytes(file.user_id, file.id, len, 'stream');
    });
    await streaming.streamPublic(req, res, file);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

function resolvePlaylistFile(req, res) {
  const fileId = req.query.file || null;
  if (!fileId) {
    res.status(400).json({ error: 'file query required' });
    return null;
  }
  const file = playlists.resolvePlaylistFile(req.params.token, fileId);
  if (!file) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  return file;
}

router.get('/playlist/:token/manifest', async (req, res) => {
  try {
    const fileId = req.query.file;
    if (!fileId) return res.status(400).json({ error: 'file query required' });
    const manifest = await storage.getPlaylistManifest(req.params.token, fileId);
    res.json(manifest);
  } catch (err) {
    res.status(err.message === 'Share not found' ? 404 : 400).json({ error: err.message });
  }
});

router.get('/playlist/:token/hls', async (req, res) => {
  try {
    const fileId = req.query.file;
    if (!fileId) return res.status(400).json({ error: 'file query required' });
    const manifest = await storage.getPlaylistManifest(req.params.token, fileId);
    if (!manifest?.hls_available || !manifest.hls_playlist_url) {
      return res.status(404).json({ error: 'HLS playlist not available' });
    }
    const playlistRes = await fetch(manifest.hls_playlist_url);
    if (!playlistRes.ok) {
      return res.status(502).json({ error: 'Failed to fetch playlist from storage' });
    }
    const content = await playlistRes.text();
    const baseName = (manifest.name || 'media').replace(/\.[^.]+$/, '');
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Content-Disposition', `inline; filename="${encodeURIComponent(baseName)}.m3u8"`);
    res.set('Access-Control-Allow-Origin', '*');
    res.send(Buffer.from(content, 'utf8'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/playlist/:token/chunk/:index', async (req, res) => {
  try {
    const fileId = req.query.file || null;
    const index = parseInt(req.params.index, 10);
    if (!fileId) return res.status(400).json({ error: 'file query required' });
    if (!Number.isFinite(index) || index < 0) {
      return res.status(400).json({ error: 'Invalid chunk index' });
    }
    const { buffer, chunk } = await storage.getPlaylistEncryptedChunk(
      req.params.token,
      fileId,
      index
    );
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Length', buffer.length);
    res.setHeader('X-Chunk-Index', String(chunk.chunk_index));
    res.setHeader('X-Plain-Size', String(chunk.plain_size || chunk.size));
    mediaCache.setMediaCacheHeaders(res, { scope: 'private' });
    const etag = mediaCache.etagFromParts(req.params.token, fileId, index, chunk.sha || chunk.size);
    if (mediaCache.sendNotModifiedIfMatch(req, res, etag)) return;
    res.send(buffer);
  } catch (err) {
    const code = err.message === 'Share not found' ? 404
      : err.message.includes('disabled') ? 403 : 500;
    res.status(code).json({ error: err.message });
  }
});

router.get('/playlist/:token/status', (req, res) => {
  try {
    const file = resolvePlaylistFile(req, res);
    if (!file) return;
    res.json(streaming.getStatus(file.user_id, file.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/playlist/:token/hls/playlist.m3u8', async (req, res) => {
  try {
    const file = resolvePlaylistFile(req, res);
    if (!file) return;
    if (clientStreamOnly(req, res, file)) return;
    const base = `/api/public/playlist/${req.params.token}/hls`;
    const baseName = (file.name || 'media').replace(/\.[^.]+$/, '');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(baseName)}.m3u8"`);
    await hlsStream.servePlaylist(req, res, file.user_id, file.id, base);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

router.get('/playlist/:token/hls/github-playlist', async (req, res) => {
  try {
    const fileId = req.query.file;
    if (!fileId) return res.status(400).json({ error: 'file query required' });
    const manifest = await storage.getPlaylistManifest(req.params.token, fileId);
    if (!manifest?.hls_available || !manifest.hls_playlist_url) {
      return res.status(404).json({ error: 'HLS playlist not available' });
    }
    res.json({ url: manifest.hls_playlist_url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/playlist/:token/hls/segment/:index.ts', async (req, res) => {
  try {
    const file = resolvePlaylistFile(req, res);
    if (!file) return;
    await hlsStream.serveSegment(req, res, file.user_id, file.id, parseInt(req.params.index, 10));
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

router.post('/playlist/:token/stream/start', (req, res) => {
  try {
    const file = resolvePlaylistFile(req, res);
    if (!file) return;
    if (storage.getShareClientStreamEnabled(file.user_id)) {
      return res.json({ ok: true, client_stream: true });
    }
    const viewerId = String(req.body?.viewer_id || '').slice(0, 64);
    if (!viewerId) return res.status(400).json({ error: 'viewer_id required' });
    const { registerStreamViewer } = require('../services/chunk-session');
    registerStreamViewer(file.user_id, file.id, viewerId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/playlist/:token/stream/stop', (req, res) => {
  try {
    const file = resolvePlaylistFile(req, res);
    if (!file) return;
    const viewerId = String(req.body?.viewer_id || '').slice(0, 64);
    if (!viewerId) return res.status(400).json({ error: 'viewer_id required' });
    const { unregisterStreamViewer } = require('../services/chunk-session');
    unregisterStreamViewer(file.user_id, file.id, viewerId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/playlist/:token/download', async (req, res) => {
  try {
    const file = resolvePlaylistFile(req, res);
    if (!file) return;
    const buffer = await storage.downloadFile(file.user_id, file.id);
    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(file.name)}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
    recordBytes(file.user_id, file.id, buffer.length, 'download');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/playlist/:token/download/prepare', (req, res) => {
  try {
    const file = resolvePlaylistFile(req, res);
    if (!file) return;
    const sessionId = downloadSession.create(file.id);
    startPublicDownloadJob(file, sessionId);
    res.json({ sessionId, total: file.chunk_count || 1 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/playlist/:token/download/status/:sessionId', (req, res) => {
  try {
    const file = resolvePlaylistFile(req, res);
    if (!file) return;
    const status = downloadSession.get(req.params.sessionId);
    if (!status) return res.status(404).json({ error: 'Session not found' });
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/playlist/:token/shoutbox', (req, res) => {
  try {
    const playlist = playlists.getByShareToken(req.params.token);
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
    const token = req.params.token;
    const fileId = req.query.file || null;
    const since = req.query.since || '0';
    const limit = Math.min(parseInt(req.query.limit) || 100, 200);

    let query = 'SELECT id, viewer_id, viewer_name, message, position, created_at FROM share_shoutbox WHERE share_token = ?';
    const params = [token];

    if (fileId) { query += ' AND file_id = ?'; params.push(fileId); }
    query += ' AND id > ?';
    params.push(since);
    query += ' ORDER BY id ASC LIMIT ?';
    params.push(limit);

    const messages = db.prepare(query).all(...params);
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/playlist/:token/shoutbox', (req, res) => {
  try {
    const playlist = playlists.getByShareToken(req.params.token);
    if (!playlist) return res.status(404).json({ error: 'Playlist not found' });
    const token = req.params.token;
    const { file_id, viewer_id, viewer_name, message, position } = req.body || {};
    if (!viewer_id || !message) return res.status(400).json({ error: 'viewer_id and message required' });
    if (typeof message !== 'string' || message.length > 500) return res.status(400).json({ error: 'Message too long' });
    const safeName = (viewer_name || 'Anonymous').slice(0, 32);
    const result = db.prepare(
      'INSERT INTO share_shoutbox (share_token, file_id, viewer_id, viewer_name, message, position) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(token, file_id || null, viewer_id, safeName, message.trim().slice(0, 500), typeof position === 'number' ? position : null);
    res.json({ id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/collection/:token', (req, res) => {
  try {
    const collection = playlists.getCollectionByShareToken(req.params.token, req);
    if (!collection) return res.status(404).json({ error: 'Collection not found' });
    res.json(collection);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
