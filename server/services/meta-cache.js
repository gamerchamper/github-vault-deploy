const fs = require('fs');
const path = require('path');
const diskCache = require('./disk-cache');

const cacheDir = diskCache.cacheDir;

function fileName(userId, fileId) {
  return `${userId}_${fileId}.manifest.json`;
}

function filePath(userId, fileId) {
  return path.join(cacheDir, fileName(userId, fileId));
}

function get(userId, fileId, fileUpdatedAt = null) {
  const p = filePath(userId, fileId);
  if (!fs.existsSync(p)) return null;

  try {
    const wrapper = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (fileUpdatedAt && wrapper.file_updated_at && wrapper.file_updated_at !== fileUpdatedAt) {
      return null;
    }
    diskCache.touch(userId, fileId, 'manifest');
    return wrapper.manifest || null;
  } catch {
    return null;
  }
}

function put(userId, fileId, manifest, { name = null, fileUpdatedAt = null } = {}) {
  if (!manifest) return null;
  const fname = fileName(userId, fileId);
  const p = path.join(cacheDir, fname);
  const payload = JSON.stringify({
    manifest,
    file_updated_at: fileUpdatedAt,
    cached_at: Date.now(),
  });
  const entryId = diskCache.entryId(userId, fileId, 'manifest');

  diskCache.removeType(userId, fileId, 'manifest');
  diskCache.prepareSpace(Buffer.byteLength(payload), entryId);
  fs.writeFileSync(p, payload);

  diskCache.register({
    userId,
    fileId,
    type: 'manifest',
    files: [fname],
    name,
  });

  return manifest;
}

function remove(userId, fileId) {
  diskCache.removeType(userId, fileId, 'manifest');
  const p = filePath(userId, fileId);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

module.exports = { get, put, remove };
