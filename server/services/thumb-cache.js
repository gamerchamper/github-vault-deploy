const fs = require('fs');
const path = require('path');
const diskCache = require('./disk-cache');

const cacheDir = diskCache.cacheDir;

function fileName(userId, fileId) {
  return `${userId}_${fileId}.thumb.jpg`;
}

function filePath(userId, fileId) {
  return path.join(cacheDir, fileName(userId, fileId));
}

function get(userId, fileId) {
  const p = filePath(userId, fileId);
  if (!fs.existsSync(p)) return null;
  diskCache.touch(userId, fileId, 'thumbnail');
  return fs.readFileSync(p);
}

function put(userId, fileId, buffer, name = null) {
  if (!buffer?.length) return null;
  const fname = fileName(userId, fileId);
  const p = path.join(cacheDir, fname);
  const entryId = diskCache.entryId(userId, fileId, 'thumbnail');

  diskCache.removeType(userId, fileId, 'thumbnail');
  diskCache.prepareSpace(buffer.length, entryId);
  fs.writeFileSync(p, buffer);

  diskCache.register({
    userId,
    fileId,
    type: 'thumbnail',
    files: [fname],
    name,
  });

  return buffer;
}

function remove(userId, fileId) {
  diskCache.removeType(userId, fileId, 'thumbnail');
  const p = filePath(userId, fileId);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function has(userId, fileId) {
  return fs.existsSync(filePath(userId, fileId));
}

module.exports = { get, put, remove, has };
