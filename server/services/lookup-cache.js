const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const diskCache = require('./disk-cache');

const cacheDir = diskCache.cacheDir;
const GLOBAL_USER = '_lookup';

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 20);
}

function fileName(key) {
  return `_lookup_${hashKey(key)}.bin`;
}

function filePath(key) {
  return path.join(cacheDir, fileName(key));
}

function get(key) {
  const p = filePath(key);
  if (!fs.existsSync(p)) return null;
  const fileId = hashKey(key);
  diskCache.touch(GLOBAL_USER, fileId, 'lookup');
  return fs.readFileSync(p);
}

function put(key, buffer) {
  if (!buffer?.length) return null;
  const fname = fileName(key);
  const p = path.join(cacheDir, fname);
  const fileId = hashKey(key);
  const entryId = diskCache.entryId(GLOBAL_USER, fileId, 'lookup');

  diskCache.removeType(GLOBAL_USER, fileId, 'lookup');
  diskCache.prepareSpace(buffer.length, entryId);
  fs.writeFileSync(p, buffer);

  diskCache.register({
    userId: GLOBAL_USER,
    fileId,
    type: 'lookup',
    files: [fname],
    name: key.slice(0, 80),
  });

  return buffer;
}

module.exports = { get, put };
