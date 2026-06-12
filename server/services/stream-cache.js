const fs = require('fs');
const path = require('path');
const github = require('./github');
const crypto = require('./crypto');
const cache = require('./cache');
const diskCache = require('./disk-cache');
const mp4 = require('./mp4');

const building = new Map();

function paths(userId, fileId) {
  const base = path.join(cache.cacheDir, `${userId}_${fileId}`);
  return {
    raw: `${base}.raw.mp4`,
    faststart: `${base}.faststart.mp4`,
    meta: `${base}.faststart.json`,
  };
}

function getFaststart(userId, fileId, expectedSize) {
  const p = paths(userId, fileId);
  if (!fs.existsSync(p.faststart) || !fs.existsSync(p.meta)) return null;

  const meta = JSON.parse(fs.readFileSync(p.meta, 'utf8'));
  const originalSize = meta.original_size ?? meta.size;
  if (originalSize !== expectedSize) return null;

  diskCache.touch(userId, fileId, 'faststart');
  return { path: p.faststart, size: meta.size };
}

function removeFaststart(userId, fileId) {
  diskCache.removeType(userId, fileId, 'faststart');
  const p = paths(userId, fileId);
  for (const file of [p.raw, p.faststart, p.meta]) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

async function materializeRaw(userId, file, chunks, fileKey, user, destPath, onProgress) {
  const octokit = github.createClient(user.access_token);
  const fd = fs.openSync(destPath, 'w');

  try {
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const [owner, repoName] = chunk.full_name.split('/');
      const enc = await github.downloadChunk(
        octokit, owner, repoName, chunk.repo_path, chunk.default_branch
      );
      const dec = crypto.decryptChunk(enc, fileKey, chunk.chunk_iv, chunk.chunk_tag);
      fs.writeSync(fd, dec);
      if (onProgress) onProgress(i + 1, chunks.length);
    }
  } finally {
    fs.closeSync(fd);
  }
}

async function buildFaststartFromBin(userId, file, binPath, status) {
  const p = paths(userId, file.id);

  if (status) {
    status.stage = 'remuxing';
    status.progress = 80;
    status.mode = 'faststart';
  }

  diskCache.prepareSpace(file.size, diskCache.entryId(userId, file.id, 'faststart'));
  await mp4.remuxFaststart(binPath, p.faststart);

  const size = fs.statSync(p.faststart).size;
  const durationSec = await mp4.probeDuration(p.faststart);
  const baseName = `${userId}_${file.id}`;

  fs.writeFileSync(p.meta, JSON.stringify({
    cached_at: Date.now(),
    size,
    original_size: file.size,
    name: file.name,
    duration_sec: durationSec,
    faststart: true,
  }));

  diskCache.register({
    userId,
    fileId: file.id,
    type: 'faststart',
    files: [`${baseName}.faststart.mp4`, `${baseName}.faststart.json`],
    name: file.name,
  });

  if (status) {
    status.stage = 'ready';
    status.progress = 100;
  }

  return { path: p.faststart, size, duration_sec: durationSec };
}

async function ensureFaststartFromBin(userId, file, binPath, status) {
  const existing = getFaststart(userId, file.id, file.size);
  if (existing) return existing;

  const key = `${userId}:${file.id}`;
  if (building.has(key)) return building.get(key);

  const promise = buildFaststartFromBin(userId, file, binPath, status);
  building.set(key, promise);

  try {
    return await promise;
  } finally {
    building.delete(key);
  }
}

async function buildFaststartCache(userId, file, chunks, fileKey, user, status) {
  const p = paths(userId, file.id);

  if (status) {
    status.stage = 'preparing';
    status.progress = 0;
    status.total_segments = chunks.length;
    status.segments = 0;
  }

  diskCache.prepareSpace(file.size * 2, diskCache.entryId(userId, file.id, 'faststart'));

  await materializeRaw(userId, file, chunks, fileKey, user, p.raw, (done, total) => {
    if (status) {
      status.segments = done;
      status.progress = Math.round((done / total) * 70);
    }
  });

  if (status) {
    status.stage = 'remuxing';
    status.progress = 75;
  }

  await mp4.remuxFaststart(p.raw, p.faststart);
  if (fs.existsSync(p.raw)) fs.unlinkSync(p.raw);

  const size = fs.statSync(p.faststart).size;
  const durationSec = await mp4.probeDuration(p.faststart);
  const baseName = `${userId}_${file.id}`;
  fs.writeFileSync(p.meta, JSON.stringify({
    cached_at: Date.now(),
    size,
    original_size: file.size,
    name: file.name,
    duration_sec: durationSec,
    faststart: true,
  }));

  diskCache.prepareSpace(size, diskCache.entryId(userId, file.id, 'faststart'));
  diskCache.register({
    userId,
    fileId: file.id,
    type: 'faststart',
    files: [`${baseName}.faststart.mp4`, `${baseName}.faststart.json`],
    name: file.name,
  });

  if (status) {
    status.stage = 'ready';
    status.progress = 100;
    status.segments = chunks.length;
  }

  return { path: p.faststart, size };
}

async function ensureFaststartCache(userId, file, chunks, fileKey, user, status) {
  const existing = getFaststart(userId, file.id, file.size);
  if (existing) return existing;

  const key = `${userId}:${file.id}`;
  if (building.has(key)) return building.get(key);

  const promise = buildFaststartCache(userId, file, chunks, fileKey, user, status);
  building.set(key, promise);

  try {
    return await promise;
  } finally {
    building.delete(key);
  }
}

function getDurationSec(userId, fileId) {
  const p = paths(userId, fileId);
  if (fs.existsSync(p.meta)) {
    try {
      const meta = JSON.parse(fs.readFileSync(p.meta, 'utf8'));
      if (meta.duration_sec) return meta.duration_sec;
    } catch { /* ignore */ }
  }

  const mPath = path.join(cache.cacheDir, `${userId}_${fileId}.json`);
  if (fs.existsSync(mPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(mPath, 'utf8'));
      if (meta.duration_sec) return meta.duration_sec;
    } catch { /* ignore */ }
  }

  return null;
}

module.exports = {
  getFaststart,
  getDurationSec,
  ensureFaststartCache,
  ensureFaststartFromBin,
  removeFaststart,
};
