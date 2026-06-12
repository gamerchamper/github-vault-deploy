const crypto = require('crypto');
const db = require('../db/database');

const ALGORITHM = 'sha256';

function hashBuffer(buffer) {
  return crypto.createHash(ALGORITHM).update(buffer).digest('hex');
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash(ALGORITHM);
    const fs = require('fs');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function hashChunks(chunks, chunkSize) {
  const hash = crypto.createHash(ALGORITHM);
  for (let i = 0; i < chunks.length; i++) {
    hash.update(String(i).padStart(8, '0'));
    hash.update(String(chunkSize));
  }
  return hash.digest('hex');
}

function findDuplicate(userId, contentHash) {
  if (!contentHash) return null;
  return db.prepare(`
    SELECT id, name, path, size, mime_type, created_at
    FROM files
    WHERE user_id = ? AND content_hash = ? AND is_folder = 0
      AND (upload_status IS NULL OR upload_status = 'ready')
    ORDER BY created_at DESC
    LIMIT 1
  `).get(userId, contentHash);
}

function storeHash(fileId, contentHash, algorithm = ALGORITHM) {
  db.prepare(`
    UPDATE files SET content_hash = ?, content_algorithm = ?
    WHERE id = ?
  `).run(contentHash, algorithm, fileId);
}

function verifyChunks(fileId) {
  const chunks = db.prepare(`
    SELECT chunk_index, sha, size, plain_size FROM chunks WHERE file_id = ? ORDER BY chunk_index
  `).all(fileId);
  if (!chunks.length) return { valid: false, reason: 'No chunks found', chunks: [] };

  const missing = chunks.filter(c => !c.sha || c.sha === 'pending');
  if (missing.length) {
    return { valid: false, reason: `${missing.length} chunk(s) missing SHA`, chunks: missing.map(c => c.chunk_index) };
  }
  return { valid: true, total: chunks.length, status: 'All chunks have valid SHAs' };
}

module.exports = { hashBuffer, hashFile, hashChunks, findDuplicate, storeHash, verifyChunks, ALGORITHM };
