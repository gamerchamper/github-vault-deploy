const fs = require('fs');
const path = require('path');
const diskCache = require('./disk-cache');
const mp4 = require('./mp4');

const cacheDir = diskCache.cacheDir;

function cachePath(userId, fileId) {
  return path.join(cacheDir, `${userId}_${fileId}.bin`);
}

function metaPath(userId, fileId) {
  return path.join(cacheDir, `${userId}_${fileId}.json`);
}

function get(userId, fileId) {
  const cPath = cachePath(userId, fileId);
  const mPath = metaPath(userId, fileId);
  if (!fs.existsSync(cPath) || !fs.existsSync(mPath)) return null;

  diskCache.touch(userId, fileId, 'decrypted');
  return { path: cPath, meta: JSON.parse(fs.readFileSync(mPath, 'utf8')) };
}

function put(userId, fileId, buffer, file) {
  const cPath = cachePath(userId, fileId);
  const mPath = metaPath(userId, fileId);
  const binName = `${userId}_${fileId}.bin`;
  const jsonName = `${userId}_${fileId}.json`;

  diskCache.removeType(userId, fileId, 'decrypted');
  diskCache.prepareSpace(buffer.length, diskCache.entryId(userId, fileId, 'decrypted'));
  fs.writeFileSync(cPath, buffer);
  fs.writeFileSync(mPath, JSON.stringify({
    cached_at: Date.now(),
    size: buffer.length,
    name: file.name,
    mime_type: file.mime_type,
  }));

  diskCache.register({
    userId,
    fileId,
    type: 'decrypted',
    files: [binName, jsonName],
    name: file.name,
  });

  return { path: cPath, meta: { size: buffer.length, name: file.name, mime_type: file.mime_type } };
}

async function enrichMp4Meta(cPath, meta) {
  if (!mp4.isMp4(meta.name, meta.mime_type)) return meta;

  try {
    meta.duration_sec = await mp4.probeDuration(cPath);
  } catch { /* ignore */ }

  return meta;
}

async function registerFromPath(userId, fileId, srcPath, file) {
  const cPath = cachePath(userId, fileId);
  const mPath = metaPath(userId, fileId);
  const binName = `${userId}_${fileId}.bin`;
  const jsonName = `${userId}_${fileId}.json`;

  diskCache.removeType(userId, fileId, 'decrypted');
  const size = fs.statSync(srcPath).size;
  diskCache.prepareSpace(size, diskCache.entryId(userId, fileId, 'decrypted'));
  if (fs.existsSync(cPath)) fs.unlinkSync(cPath);
  fs.renameSync(srcPath, cPath);

  let meta = {
    cached_at: Date.now(),
    size,
    name: file.name,
    mime_type: file.mime_type,
  };
  meta = await enrichMp4Meta(cPath, meta);
  fs.writeFileSync(mPath, JSON.stringify(meta));

  diskCache.register({
    userId,
    fileId,
    type: 'decrypted',
    files: [binName, jsonName],
    name: file.name,
  });

  if (mp4.isMp4(file.name, file.mime_type)) {
    require('./stream-cache').ensureFaststartFromBin(userId, file, cPath).catch((err) => {
      console.warn(`Faststart build deferred (${fileId}):`, err.message);
    });
  }

  return { path: cPath, meta };
}

function remove(userId, fileId) {
  diskCache.removeByFile(userId, fileId);

  for (const p of [cachePath(userId, fileId), metaPath(userId, fileId)]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  const base = path.join(cacheDir, `${userId}_${fileId}`);
  for (const suffix of ['.raw.mp4', '.faststart.mp4', '.faststart.json', '_stream.bin']) {
    const p = `${base}${suffix}`;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

module.exports = {
  get,
  put,
  registerFromPath,
  remove,
  cacheDir,
};
