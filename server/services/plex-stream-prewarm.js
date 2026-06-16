const db = require('../db/database');
const cache = require('./cache');
const mp4 = require('./mp4');
const streamCache = require('./stream-cache');
const streaming = require('./streaming');
const storage = require('./storage');
const { isChunkMode } = storage;

const running = new Set();

async function prewarmFile(userId, fileId) {
  const key = `${userId}:${fileId}`;
  if (running.has(key)) return;
  running.add(key);

  try {
    const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(fileId, userId);
    if (!file || file.is_folder || !mp4.isMp4(file.name, file.mime_type)) return;

    const existing = streamCache.getFaststart(userId, fileId, file.size);
    if (existing) return;

    const cached = cache.get(userId, fileId);
    if (cached) {
      await streamCache.ensureFaststartFromBin(userId, file, cached.path, null);
      return;
    }

    const chunks = db.prepare(
      'SELECT c.*, r.full_name, r.default_branch FROM chunks c JOIN storage_repos r ON c.repo_id = r.id WHERE c.file_id = ? ORDER BY c.chunk_index'
    ).all(fileId);
    if (!isChunkMode(file, chunks)) return;

    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    const fileKey = await streaming.getFileKey(userId, file);
    await streamCache.ensureFaststartCache(userId, file, chunks, fileKey, user, null);
  } catch (err) {
    console.warn(`[plex-prewarm] ${fileId}: ${err.message}`);
  } finally {
    running.delete(key);
  }
}

async function prewarmFiles(userId, fileIds, { concurrency = 2 } = {}) {
  const unique = [...new Set((fileIds || []).filter(Boolean))];
  if (!unique.length) return;

  for (let i = 0; i < unique.length; i += concurrency) {
    const batch = unique.slice(i, i + concurrency);
    await Promise.all(batch.map((fileId) => prewarmFile(userId, fileId)));
  }
}

function prewarmFilesBackground(userId, fileIds, options = {}) {
  prewarmFiles(userId, fileIds, options).catch((err) => {
    console.warn(`[plex-prewarm] background run failed: ${err.message}`);
  });
}

module.exports = {
  prewarmFile,
  prewarmFiles,
  prewarmFilesBackground,
};
