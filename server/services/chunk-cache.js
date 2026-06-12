const fs = require('fs');
const path = require('path');
const diskCache = require('./disk-cache');

const cacheDir = diskCache.cacheDir;

function chunkFileName(userId, chunkId) {
  return `${userId}_chunk_${chunkId}.enc.bin`;
}

function chunkPath(userId, chunkId) {
  return path.join(cacheDir, chunkFileName(userId, chunkId));
}

function get(userId, chunkId) {
  const filePath = chunkPath(userId, chunkId);
  if (!fs.existsSync(filePath)) return null;
  diskCache.touch(userId, String(chunkId), 'encrypted_chunk');
  return fs.readFileSync(filePath);
}

function put(userId, chunkId, buffer) {
  const fileName = chunkFileName(userId, chunkId);
  const filePath = path.join(cacheDir, fileName);
  const id = diskCache.entryId(userId, String(chunkId), 'encrypted_chunk');

  diskCache.removeType(userId, String(chunkId), 'encrypted_chunk');
  diskCache.prepareSpace(buffer.length, id);
  fs.writeFileSync(filePath, buffer);

  diskCache.register({
    userId,
    fileId: String(chunkId),
    type: 'encrypted_chunk',
    files: [fileName],
    name: `chunk:${chunkId}`,
  });

  return buffer;
}

module.exports = { get, put };
