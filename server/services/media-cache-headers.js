const fs = require('fs');
const crypto = require('crypto');

const MEDIA_MAX_AGE_SEC = Number(process.env.MEDIA_CACHE_MAX_AGE_SEC) || 4 * 3600;
const MEDIA_SWR_SEC = Number(process.env.MEDIA_CACHE_SWR_SEC) || 24 * 3600;
const MEDIA_PLAYLIST_MAX_AGE_SEC = Number(process.env.MEDIA_PLAYLIST_MAX_AGE_SEC) || 300;

function mediaCacheControl({
  scope = 'private',
  maxAgeSec = MEDIA_MAX_AGE_SEC,
  swrSec = MEDIA_SWR_SEC,
  noCache = false,
  noStore = false,
} = {}) {
  if (noStore) return 'no-store';
  if (noCache) return 'no-cache, must-revalidate';
  const parts = [scope, `max-age=${maxAgeSec}`];
  if (swrSec > 0) parts.push(`stale-while-revalidate=${swrSec}`);
  parts.push('must-revalidate');
  return parts.join(', ');
}

function setMediaCacheHeaders(res, options = {}) {
  res.setHeader('Cache-Control', mediaCacheControl(options));
}

function setPlaylistCacheHeaders(res) {
  res.setHeader('Cache-Control', mediaCacheControl({
    scope: 'private',
    maxAgeSec: MEDIA_PLAYLIST_MAX_AGE_SEC,
    swrSec: 0,
  }));
}

function etagFromStat(stat) {
  if (!stat) return null;
  return `${Math.floor(stat.mtimeMs)}-${stat.size}`;
}

function etagFromPath(filePath) {
  try {
    return etagFromStat(fs.statSync(filePath));
  } catch {
    return null;
  }
}

function etagFromBuffer(buffer) {
  if (!buffer || !buffer.length) return null;
  return crypto.createHash('sha1').update(buffer).digest('hex');
}

function etagFromParts(...parts) {
  return crypto.createHash('sha1').update(parts.filter(Boolean).join(':')).digest('hex');
}

function sendNotModifiedIfMatch(req, res, etag) {
  if (!etag) return false;
  const value = `"${etag}"`;
  res.setHeader('ETag', value);
  const incoming = req.headers['if-none-match'];
  if (incoming && incoming.split(',').map((v) => v.trim()).includes(value)) {
    res.status(304).end();
    return true;
  }
  return false;
}

module.exports = {
  MEDIA_MAX_AGE_SEC,
  MEDIA_SWR_SEC,
  MEDIA_PLAYLIST_MAX_AGE_SEC,
  mediaCacheControl,
  setMediaCacheHeaders,
  setPlaylistCacheHeaders,
  etagFromStat,
  etagFromPath,
  etagFromBuffer,
  etagFromParts,
  sendNotModifiedIfMatch,
};
