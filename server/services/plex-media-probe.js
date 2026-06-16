const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const cache = require('./cache');
const mp4 = require('./mp4');
const plexBridge = require('./plex-bridge');
const streamCache = require('./stream-cache');

const FFPROBE_UA = 'Lavf/60.16.100';

function readFaststartMeta(userId, fileId) {
  const metaPath = path.join(cache.cacheDir, `${userId}_${fileId}.faststart.json`);
  if (!fs.existsSync(metaPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return null;
  }
}

function probeFromMeta(meta) {
  if (!meta?.probe) return null;
  return { ...meta.probe };
}

function getCachedProbe(userId, fileId, fileSize) {
  const fastMeta = readFaststartMeta(userId, fileId);
  const fromFast = probeFromMeta(fastMeta);
  if (fromFast) return fromFast;

  const cached = cache.get(userId, fileId);
  const fromCache = probeFromMeta(cached?.meta);
  if (fromCache) return fromCache;

  if (fastMeta?.duration_sec) {
    return { duration_sec: fastMeta.duration_sec, container: 'mp4' };
  }
  if (cached?.meta?.duration_sec) {
    return { duration_sec: cached.meta.duration_sec, container: 'mp4' };
  }

  return null;
}

function inferProbeFromFile(file) {
  const name = String(file?.name || file?.display_name || '');
  const mime = String(file?.mime_type || '');
  const probe = {};

  if (mime.startsWith('video/') || mime.startsWith('audio/')) {
    probe.container = mp4.normalizeContainer(null, mime.startsWith('audio/') ? 'mp3' : 'mp4');
  }
  if (/\.mkv$/i.test(name)) probe.container = 'mkv';
  else if (/\.webm$/i.test(name)) probe.container = 'webm';
  else if (/\.mp4$/i.test(name) || mp4.isMp4(name, mime)) probe.container = 'mp4';

  return Object.keys(probe).length ? probe : null;
}

async function probeLocalPath(localPath) {
  return mp4.probeMediaInfo(localPath, { userAgent: FFPROBE_UA });
}

async function probeStreamUrl(streamUrl) {
  return mp4.probeMediaInfo(streamUrl, { userAgent: FFPROBE_UA });
}

async function getProbeInfo(userId, fileOrId, req, { allowRemoteProbe = false } = {}) {
  const file = typeof fileOrId === 'object'
    ? fileOrId
    : db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(fileOrId, userId);
  if (!file || file.is_folder) return null;

  const cached = getCachedProbe(userId, file.id, file.size);
  if (cached?.container && cached?.video_codec) return cached;

  const faststart = streamCache.getFaststart(userId, file.id, file.size);
  if (faststart?.path) {
    try {
      const probed = await probeLocalPath(faststart.path);
      return { ...cached, ...probed };
    } catch {
      // fall through
    }
  }

  const cachedFile = cache.get(userId, file.id);
  if (cachedFile?.path && fs.existsSync(cachedFile.path)) {
    try {
      const probed = await probeLocalPath(cachedFile.path);
      return { ...cached, ...probed };
    } catch {
      // fall through
    }
  }

  if (allowRemoteProbe && req) {
    try {
      const streamUrl = plexBridge.strmUrl(req, {
        id: file.id,
        name: file.name,
        display_name: file.name,
        mime_type: file.mime_type,
        title: file.name,
      });
      const probed = await probeStreamUrl(streamUrl);
      return { ...cached, ...probed };
    } catch {
      // fall through
    }
  }

  return { ...inferProbeFromFile(file), ...cached };
}

function sidecarProbeFields(probe) {
  if (!probe) return {};
  const videoResolution = probe.video_resolution || mp4.videoResolutionLabel(probe.height);
  const fields = {
    container: probe.container || null,
    duration_sec: probe.duration_sec || null,
    video_codec: probe.video_codec || null,
    video_profile: probe.video_profile || null,
    audio_codec: probe.audio_codec || null,
    audio_channels: probe.audio_channels || null,
    width: probe.width || null,
    height: probe.height || null,
    video_resolution: videoResolution || null,
    bitrate: probe.bitrate || null,
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value != null));
}

module.exports = {
  FFPROBE_UA,
  getProbeInfo,
  sidecarProbeFields,
  probeStreamUrl,
  probeLocalPath,
};
