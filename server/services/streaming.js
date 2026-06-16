const fs = require('fs');
const path = require('path');
const storage = require('./storage');
const { isChunkMode } = storage;
const cache = require('./cache');
const crypto = require('./crypto');
const db = require('../db/database');
const mp4 = require('./mp4');
const streamCache = require('./stream-cache');
const mediaCache = require('./media-cache-headers');
const {
  parseRange,
  getOrCreateChunkSession,
  getOrCreateLegacySession,
  getSessionStatus,
} = require('./chunk-session');

const jobs = new Map();

function jobKey(userId, fileId) {
  return `${userId}:${fileId}`;
}

const EXT_MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
};

function streamMimeType(file) {
  if (mp4.isMp4(file?.name, file?.mime_type)) return 'video/mp4';
  const ext = path.extname(String(file?.name || '')).toLowerCase();
  if (ext && EXT_MIME[ext]) return EXT_MIME[ext];
  if (file?.mime_type && file.mime_type !== 'application/octet-stream') return file.mime_type;
  return 'application/octet-stream';
}

/** Plex/ffprobe probe remote URLs; they need valid headers and a ready MP4 bootstrap. */
function isRemoteMediaClient(req) {
  if (!req) return false;
  const ua = String(req?.get?.('user-agent') || req?.headers?.['user-agent'] || '');
  if (/Plex|Lavf|ffprobe|libmpv|VideoLAN|MediaServer|ExoPlayerLib|stagefright|Datahunter|Player|AppleCoreMedia/i.test(ua)) {
    return true;
  }
  if (req?.headers?.['x-plex-token'] || req?.headers?.['x-plex-product']) return true;
  if (req?.headers?.range) return true;
  return false;
}

async function ensureFaststartForRemoteClient(req, userId, file, chunks, fileKey, user, status = null) {
  let faststart = streamCache.getFaststart(userId, file.id, file.size);
  if (faststart) return faststart;

  const cached = cache.get(userId, file.id);
  if (cached) {
    return streamCache.ensureFaststartFromBin(userId, file, cached.path, status);
  }

  return streamCache.ensureFaststartCache(userId, file, chunks, fileKey, user, status);
}

async function waitForFaststartReady(userId, file, chunks, fileKey, user, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let faststart = streamCache.getFaststart(userId, file.id, file.size);
    if (faststart) return faststart;
    try {
      faststart = await ensureFaststartForRemoteClient(null, userId, file, chunks, fileKey, user);
      if (faststart) return faststart;
    } catch (err) {
      console.warn(`[stream] faststart build retry (${file.id}): ${err.message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`Faststart not ready for file ${file.id}`);
}

function serveStreamHead(res, file, contentLength = null) {
  const mimeType = streamMimeType(file);
  const length = contentLength != null ? contentLength : file.size;
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Content-Length', String(length));
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(file.name)}"`);
  mediaCache.setMediaCacheHeaders(res);
  res.status(200).end();
}

async function waitForServePath(session, start, end, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await session.ensureRange(start, end);
    } catch {
      // keep polling
    }
    const filePath = session.servePath || session.spillPath;
    if (filePath && fs.existsSync(filePath)) return filePath;
    await new Promise((r) => setTimeout(r, 500));
  }
  const filePath = session.servePath || session.spillPath;
  return filePath && fs.existsSync(filePath) ? filePath : null;
}

function attachDuration(status, userId, fileId) {
  let durationSec = streamCache.getDurationSec(userId, fileId)
    || cache.get(userId, fileId)?.meta?.duration_sec;
  if (!durationSec) {
    const row = db.prepare(
      'SELECT COALESCE(SUM(duration), 0) AS total FROM hls_segments WHERE file_id = ?'
    ).get(fileId);
    if (row?.total > 0) durationSec = row.total;
  }
  if (durationSec) status.duration_sec = durationSec;
  return status;
}

function getStatus(userId, fileId) {
  const key = jobKey(userId, fileId);
  const file = db.prepare('SELECT chunk_count FROM files WHERE id = ? AND user_id = ?').get(fileId, userId);
  const totalChunks = file?.chunk_count || 0;

  const fileMeta = db.prepare('SELECT size, name, mime_type FROM files WHERE id = ? AND user_id = ?').get(fileId, userId);
  const faststart = fileMeta && streamCache.getFaststart(userId, fileId, fileMeta.size);
  if (faststart) {
    return attachDuration({
      ready: true,
      progress: 100,
      stage: 'ready',
      segments: totalChunks,
      total_segments: totalChunks,
      buffered: true,
      mode: 'faststart',
      use_hls: false,
    }, userId, fileId);
  }

  const cached = cache.get(userId, fileId);
  if (cached) {
    return attachDuration({
      ready: true,
      progress: 100,
      stage: 'ready',
      segments: totalChunks,
      total_segments: totalChunks,
      buffered: true,
      mode: 'cached',
      use_hls: false,
    }, userId, fileId);
  }

  const hlsStream = require('./hls-stream');
  const hlsStatus = hlsStream.getHlsStatus(userId, fileId);

  const sessionStatus = getSessionStatus(userId, fileId);
  if (sessionStatus) {
    const bytesReady = sessionStatus.bytes_ready || 0;
    const moovReady = !!sessionStatus.moov_ready || !!hlsStatus?.moov_ready;
    const hlsReady = !!hlsStatus?.hls_ready;
    const canPlay = sessionStatus.stage === 'ready' || bytesReady > 0 || moovReady || hlsReady;
    return attachDuration({
      ...sessionStatus,
      ...hlsStatus,
      ready: canPlay,
      total_segments: sessionStatus.total_segments || totalChunks,
      buffered: !!sessionStatus.buffered || sessionStatus.stage === 'ready' || hlsReady,
      mode: sessionStatus.mode || 'sequential',
      bytes_ready: bytesReady,
      use_hls: sessionStatus.mode === 'hls' || !!hlsStatus?.hls_ready,
    }, userId, fileId);
  }

  if (hlsStatus) {
    return attachDuration({
      ready: hlsStatus.playable,
      progress: 0,
      stage: hlsStatus.hls_ready ? 'ready' : 'streaming',
      segments: hlsStatus.hls_segments || 0,
      total_segments: totalChunks,
      buffered: hlsStatus.hls_ready,
      mode: 'hls',
      bytes_ready: 0,
      ...hlsStatus,
      use_hls: true,
    }, userId, fileId);
  }

  const job = jobs.get(key);
  if (job) {
    const status = attachDuration({ ...job.status, ready: false }, userId, fileId);
    if (!status.total_segments && totalChunks) status.total_segments = totalChunks;
    return status;
  }

  return attachDuration({
    ready: false,
    progress: 0,
    stage: 'streaming',
    segments: 0,
    total_segments: totalChunks,
    buffered: false,
    mode: 'idle',
  }, userId, fileId);
}

async function getFileKey(userId, file) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  let encryptionMeta = file.encryption_meta ? JSON.parse(file.encryption_meta) : null;
  if (!encryptionMeta) {
    const metadata = require('./metadata');
    const manifest = await metadata.getFileManifest(userId, file.id);
    if (manifest?.encryption) encryptionMeta = manifest.encryption;
  }
  if (!encryptionMeta) throw new Error('Missing encryption metadata');
  const masterKey = crypto.getMasterKey(user);
  return crypto.deserializeEncryption(encryptionMeta, masterKey);
}

async function streamChunked(req, res, userId, file, chunks, fileKey, user, { isMp4 = false, view = null } = {}) {
  const mimeType = streamMimeType(file);
  const usePrimaryCache = !view || view.type === 'primary';
  if (usePrimaryCache) {
    if (isMp4) {
      const faststart = streamCache.getFaststart(userId, file.id, file.size);
      if (faststart) {
        return serveRange(req, res, faststart.path, mimeType, file.name, faststart.size);
      }
    }
    const cached = cache.get(userId, file.id);
    if (cached) {
      return serveRange(req, res, cached.path, mimeType, file.name, file.size);
    }
  }

  let { start, end } = parseRange(req.headers.range, file.size);
  const session = getOrCreateChunkSession(userId, file, chunks, fileKey, user, view);
  const key = jobKey(userId, file.id);

  if (isMp4) session.prefetchMp4Bootstrap();

  session.status.mode = 'incremental';
  jobs.set(key, { status: session.status });

  const hasRange = !!req.headers.range;
  if (!isMp4 && !hasRange && file.size > 4 * 1024 * 1024) {
    end = Math.min(end, 4 * 1024 * 1024 - 1);
  }

  session.startBackgroundDownload?.();

  await session.ensureRange(start, end);

  if (usePrimaryCache) {
    if (isMp4) {
      const faststart = streamCache.getFaststart(userId, file.id, file.size);
      if (faststart) {
        return serveRange(req, res, faststart.path, mimeType, file.name, faststart.size);
      }
    }
    const cached = cache.get(userId, file.id);
    if (cached) {
      return serveRange(req, res, cached.path, mimeType, file.name, file.size);
    }
  }

  let filePath = session.servePath || session.spillPath;
  if ((!filePath || !fs.existsSync(filePath)) && isRemoteMediaClient(req)) {
    filePath = await waitForServePath(session, start, end);
  }
  if (!filePath || !fs.existsSync(filePath)) {
    if (!res.headersSent) res.status(503).json({ error: 'Stream buffer not ready — retry shortly' });
    return;
  }

  const safeEnd = Math.min(end, file.size - 1);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mimeType);
  res.setHeader('Cache-Control', mediaCache.mediaCacheControl({ noCache: true }));

  if (hasRange || file.size > 4 * 1024 * 1024) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${safeEnd}/${file.size}`);
    res.setHeader('Content-Length', safeEnd - start + 1);
  } else {
    res.setHeader('Content-Length', safeEnd - start + 1);
  }

  pipeReadStream(res, filePath, start, safeEnd);
  session.prefetch(safeEnd);

  setTimeout(() => jobs.delete(key), 5000);
}

async function streamLegacy(req, res, userId, file, chunks, user, view = null) {
  const encryptionMeta = file.encryption_meta ? JSON.parse(file.encryption_meta) : null;
  if (!encryptionMeta?.iv || !encryptionMeta?.auth_tag) {
    throw new Error('Missing encryption metadata');
  }

  const masterKey = crypto.getMasterKey(user);
  const fileKey = crypto.deserializeEncryption(encryptionMeta, masterKey);
  const session = getOrCreateLegacySession(userId, file, chunks, encryptionMeta, fileKey, user, view);
  const key = jobKey(userId, file.id);

  session.status.mode = 'sequential';
  session.status.total_segments = chunks.length;
  jobs.set(key, { status: session.status });

  try {
    await session.serveRange(req, res);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
  setTimeout(() => jobs.delete(key), 5000);
}

async function streamFile(req, res, userId, fileId, view = null) {
  const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(fileId, userId);
  if (!file || file.is_folder) throw new Error('File not found');

  const mimeType = streamMimeType(file);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const chunks = db.prepare(
    'SELECT c.*, r.full_name, r.default_branch FROM chunks c JOIN storage_repos r ON c.repo_id = r.id WHERE c.file_id = ? ORDER BY c.chunk_index'
  ).all(fileId);
  const usePrimaryCache = !view || view.type === 'primary';
  const isMp4 = mp4.isMp4(file.name, file.mime_type);
  const remote = isRemoteMediaClient(req);

  if (isChunkMode(file, chunks) && usePrimaryCache && isMp4 && remote) {
    const fileKey = await getFileKey(userId, file);
    try {
      const faststart = await waitForFaststartReady(userId, file, chunks, fileKey, user);
      if (req.method === 'HEAD') {
        serveStreamHead(res, file, faststart.size);
        return;
      }
      return serveRange(req, res, faststart.path, mimeType, file.name, faststart.size);
    } catch (err) {
      console.warn(`[stream] remote media client could not get faststart (${fileId}): ${err.message}`);
      if (!res.headersSent) {
        res.setHeader('Retry-After', '30');
        res.status(503).json({ error: err.message });
      }
      return;
    }
  }

  if (req.method === 'HEAD') {
    serveStreamHead(res, file);
    return;
  }

  if (isChunkMode(file, chunks)) {
    const fileKey = await getFileKey(userId, file);

    if (usePrimaryCache && isMp4) {
      let faststart = streamCache.getFaststart(userId, fileId, file.size);
      if (!faststart) {
        const cached = cache.get(userId, fileId);
        if (cached) {
          streamCache.ensureFaststartFromBin(userId, file, cached.path, null).catch((err) => {
            console.warn(`Faststart build deferred (${fileId}):`, err.message);
          });
          return serveRange(req, res, cached.path, mimeType, file.name, file.size);
        }
      }
      if (faststart) {
        return serveRange(req, res, faststart.path, mimeType, file.name, faststart.size);
      }
    }

    if (usePrimaryCache) {
      const cached = cache.get(userId, fileId);
      if (cached) {
        return serveRange(req, res, cached.path, mimeType, file.name, file.size);
      }
    }

    return streamChunked(req, res, userId, file, chunks, fileKey, user, { isMp4, view });
  }

  if (usePrimaryCache) {
    const cached = cache.get(userId, fileId);
    if (cached) {
      return serveRange(req, res, cached.path, mimeType, file.name, file.size);
    }
  }

  return streamLegacy(req, res, userId, file, chunks, user, view);
}

async function streamPublic(req, res, file) {
  const chunks = db.prepare(
    'SELECT c.*, r.full_name, r.default_branch FROM chunks c JOIN storage_repos r ON c.repo_id = r.id WHERE c.file_id = ? ORDER BY c.chunk_index'
  ).all(file.id);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(file.user_id);
  if (isChunkMode(file, chunks)) {
    const fileKey = await getFileKey(file.user_id, file);
    const isMp4 = mp4.isMp4(file.name, file.mime_type);

    if (isMp4) {
      let faststart = streamCache.getFaststart(file.user_id, file.id, file.size);
      if (!faststart) {
        const cached = cache.get(file.user_id, file.id);
        if (cached) {
          streamCache.ensureFaststartFromBin(file.user_id, file, cached.path, null).catch((err) => {
            console.warn(`Faststart build deferred (${file.id}):`, err.message);
          });
          return serveRange(req, res, cached.path, file.mime_type, file.name, file.size);
        }
      }
      if (faststart) {
        return serveRange(req, res, faststart.path, file.mime_type, file.name, faststart.size);
      }
    }

    const cached = cache.get(file.user_id, file.id);
    if (cached) {
      return serveRange(req, res, cached.path, file.mime_type, file.name, file.size);
    }

    return streamChunked(req, res, file.user_id, file, chunks, fileKey, user, { isMp4 });
  }

  const cached = cache.get(file.user_id, file.id);
  if (cached) {
    return serveRange(req, res, cached.path, file.mime_type, file.name, file.size);
  }

  return streamLegacy(req, res, file.user_id, file, chunks, user);
}

function serveRange(req, res, filePath, mimeType, fileName, knownSize, onComplete = null) {
  const size = knownSize || fs.statSync(filePath).size;
  const { start, end } = parseRange(req.headers.range, size);
  const isHead = req.method === 'HEAD';

  const etag = mediaCache.etagFromPath(filePath);
  if (!req.headers.range && mediaCache.sendNotModifiedIfMatch(req, res, etag)) {
    onComplete?.(0);
    return;
  }

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mimeType || 'application/octet-stream');
  mediaCache.setMediaCacheHeaders(res);

  if (!req.headers.range) {
    res.setHeader('Content-Length', size);
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`);
    if (isHead) {
      res.status(200).end();
      onComplete?.(0);
      return;
    }
    pipeReadStream(res, filePath, 0, size - 1, () => onComplete?.(size));
    return;
  }

  if (start >= size) {
    res.status(416).setHeader('Content-Range', `bytes */${size}`);
    res.end();
    onComplete?.(0);
    return;
  }

  const safeEnd = Math.min(end, size - 1);
  const bytesSent = safeEnd - start + 1;
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${safeEnd}/${size}`);
  res.setHeader('Content-Length', bytesSent);
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`);
  if (isHead) {
    res.end();
    onComplete?.(0);
    return;
  }
  pipeReadStream(res, filePath, start, safeEnd, () => onComplete?.(bytesSent));
}

function pipeReadStream(res, filePath, start = 0, end, onComplete = null) {
  if (!fs.existsSync(filePath)) {
    if (!res.headersSent) res.status(404).end();
    onComplete?.(0);
    return;
  }

  const options = end !== undefined ? { start, end } : undefined;
  const stream = fs.createReadStream(filePath, options);
  stream.on('error', (err) => {
    console.error('Stream read error:', err.message);
    if (!res.headersSent) res.status(500).end();
    else res.destroy();
    onComplete?.(0);
  });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
  stream.on('end', () => onComplete?.());
}

module.exports = {
  streamFile,
  streamPublic,
  getStatus,
  getFileKey,
  serveRange,
  streamMimeType,
  serveStreamHead,
};
