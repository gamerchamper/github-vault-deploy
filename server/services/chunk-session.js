const fs = require('fs');
const path = require('path');
const nodeCrypto = require('crypto');
const crypto = require('./crypto');
const github = require('./github');
const accounts = require('./accounts');
const cache = require('./cache');
const { createAdaptivePool } = require('./adaptive-concurrency');
const rateLimit = require('./github-rate-limit');

const CONCURRENCY = 8;
const SESSION_TTL_MS = 30 * 60 * 1000;

const sessions = new Map();

function viewKey(view) {
  if (!view || view.type === 'primary') return 'primary';
  return `${view.type}:${view.accountId}`;
}

function sessionKey(userId, fileId, view = null) {
  return `${userId}:${fileId}:${viewKey(view)}`;
}

function parseRange(header, totalSize) {
  if (!header || !header.startsWith('bytes=')) {
    return { start: 0, end: totalSize - 1 };
  }

  const spec = header.replace(/bytes=/, '');
  const dash = spec.indexOf('-');
  const left = spec.slice(0, dash);
  const right = spec.slice(dash + 1);

  if (left === '' && right !== '') {
    const suffix = parseInt(right, 10);
    return { start: Math.max(0, totalSize - suffix), end: totalSize - 1 };
  }

  const start = parseInt(left, 10);
  let end = right !== '' ? parseInt(right, 10) : totalSize - 1;
  if (!Number.isFinite(start) || start < 0) return { start: 0, end: totalSize - 1 };
  if (!Number.isFinite(end) || end >= totalSize) end = totalSize - 1;
  return { start, end };
}

function buildChunkMap(chunks) {
  let offset = 0;
  return chunks.map((chunk) => {
    const plainSize = chunk.plain_size || chunk.size;
    const byteStart = offset;
    offset += plainSize;
    return { ...chunk, plainSize, byteStart, byteEnd: offset - 1 };
  });
}

function chunksInRange(chunkMap, rangeStart, rangeEnd) {
  return chunkMap.filter((c) => c.byteEnd >= rangeStart && c.byteStart <= rangeEnd);
}

function downloadPoolOptions(user) {
  const tokenKey = user?.access_token ? rateLimit.keyForToken(user.access_token) : null;
  const recommended = tokenKey ? rateLimit.getRecommendedConcurrency(tokenKey, 8) : 8;
  return {
    max: 12,
    initial: recommended,
    getMax: tokenKey ? () => rateLimit.getRecommendedConcurrency(tokenKey, 8) : null,
  };
}

async function mapConcurrent(items, limit, fn) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

function safeFsyncSync(fd) {
  if (fd == null) return;
  try {
    fs.fsyncSync(fd);
  } catch (err) {
    if (err.code !== 'EINVAL' && err.code !== 'EOPNOTSUPP') throw err;
  }
}

const streamViewers = new Map();

class ChunkSession {
  constructor(userId, fileId, file, chunkMap, fileKey, user, view = null) {
    this.userId = userId;
    this.fileId = fileId;
    this.file = file;
    this.chunkMap = chunkMap;
    this.fileKey = fileKey;
    this.view = view;
    this.octokit = github.createClient(user.access_token);
    this.onDisk = new Set();
    this.pending = new Map();
    this.spillPath = path.join(cache.cacheDir, `${userId}_${fileId}_stream.bin`);
    this.spillFd = fs.openSync(this.spillPath, 'w+');
    this.finalized = false;
    this.finalizing = false;
    this.finalizePromise = null;
    this.status = {
      progress: 0,
      stage: 'streaming',
      segments: 0,
      total_segments: chunkMap.length,
      mode: 'incremental',
      bytes_ready: 0,
    };
    this.lastAccess = Date.now();
    this.aborted = false;
    this.downloadPool = createAdaptivePool(chunkMap.length, downloadPoolOptions(user));
    this.downloadPool.start();
  }

  touch() {
    this.lastAccess = Date.now();
  }

  abort() {
    if (this.aborted) return;
    this.aborted = true;
    this.onChunkReady = null;
    if (this.downloadPool) this.downloadPool.stop();
    if (!this.finalized && !this.finalizing) {
      if (this.spillFd != null) {
        try { fs.closeSync(this.spillFd); } catch { /* ignore */ }
        this.spillFd = null;
      }
      if (this.spillPath && fs.existsSync(this.spillPath)) {
        try { fs.unlinkSync(this.spillPath); } catch { /* ignore */ }
        this.spillPath = null;
      }
    }
  }

  contiguousBytesReady() {
    let ready = 0;
    for (const chunk of this.chunkMap) {
      if (!this.onDisk.has(chunk.chunk_index)) break;
      ready = chunk.byteEnd + 1;
    }
    return ready;
  }

  updateStatus() {
    this.status.segments = this.onDisk.size;
    this.status.bytes_ready = this.contiguousBytesReady();
    this.status.progress = Math.round((this.onDisk.size / this.chunkMap.length) * 100);
    if (this.onDisk.size === this.chunkMap.length && !this.finalized && !this.finalizing) {
      this.status.stage = 'caching';
      this.status.progress = Math.min(99, this.status.progress);
      this.finalizeToCache().then(() => {
        this.status.stage = 'ready';
        this.status.progress = 100;
        this.status.buffered = true;
      }).catch((err) => {
        console.warn(`Stream cache finalize failed (${this.fileId}):`, err.message);
        this.status.stage = 'ready';
        this.status.progress = 100;
      });
    }
  }

  async finalizeToCache() {
    if (this.finalized) return;
    if (this.finalizePromise) return this.finalizePromise;

    this.finalizing = true;
    this.finalizePromise = (async () => {
      try {
        if (this.spillFd != null) {
          safeFsyncSync(this.spillFd);
        }
        const entry = await cache.registerFromPath(this.userId, this.fileId, this.spillPath, this.file);
        this.servePath = entry.path;
        this.spillPath = null;
        if (this.spillFd != null) {
          fs.closeSync(this.spillFd);
          this.spillFd = null;
        }
        this.finalized = true;
        return entry;
      } catch (err) {
        this.finalizePromise = null;
        throw err;
      } finally {
        this.finalizing = false;
      }
    })();

    return this.finalizePromise;
  }

  async waitForRange(rangeStart, rangeEnd) {
    const needed = chunksInRange(this.chunkMap, rangeStart, rangeEnd);
    if (needed.every((c) => this.onDisk.has(c.chunk_index))) return;

    await Promise.all(needed.map((chunk) => this.fetchChunk(chunk.chunk_index)));
  }

  async fetchChunk(index) {
    if (this.onDisk.has(index)) return true;
    if (this.pending.has(index)) return this.pending.get(index);

    const promise = this._fetchChunk(index);
    this.pending.set(index, promise);
    return promise;
  }

  async _fetchChunk(index) {
    if (this.aborted) return false;
    await this.downloadPool.acquire();
    try {
      if (this.aborted || this.onDisk.has(index)) return !this.aborted;

      const chunk = this.chunkMap[index];
      const enc = await accounts.downloadChunkForView(this.userId, chunk, this.view);
      if (this.aborted) return false;

      const dec = crypto.decryptChunk(enc, this.fileKey, chunk.chunk_iv, chunk.chunk_tag);
      if (this.spillFd == null) {
        if (this.onDisk.has(index)) return true;
        if (this.finalizePromise) {
          await this.finalizePromise.catch(() => {});
          if (this.finalized) return this.onDisk.has(index);
        }
        if (this.finalized && this.servePath) return this.onDisk.has(index);
        if (this.aborted) return false;
        throw new Error('Stream buffer unavailable');
      }
      fs.writeSync(this.spillFd, dec, 0, dec.length, chunk.byteStart);
      this.downloadPool.recordBytes(dec.length);
      this.onDisk.add(index);
      this.updateStatus();
      if (this.onChunkReady) this.onChunkReady(index);
      return true;
    } finally {
      this.downloadPool.release();
      this.pending.delete(index);
    }
  }

  async ensureRange(rangeStart, rangeEnd) {
    const needed = chunksInRange(this.chunkMap, rangeStart, rangeEnd);
    await Promise.all(needed.map((chunk) => this.fetchChunk(chunk.chunk_index).catch(() => false)));
  }

  async resolveReadPath() {
    if (this.aborted) return null;
    if (this.servePath && fs.existsSync(this.servePath)) return this.servePath;
    if (this.spillPath && fs.existsSync(this.spillPath)) return this.spillPath;
    if (this.finalizePromise) {
      await this.finalizePromise.catch(() => {});
      if (this.servePath && fs.existsSync(this.servePath)) return this.servePath;
    }
    const cached = cache.get(this.userId, this.fileId);
    if (cached?.path && fs.existsSync(cached.path)) return cached.path;
    return null;
  }

  async readRangeAsync(rangeStart, rangeEnd) {
    const filePath = await this.resolveReadPath();
    if (!filePath) throw new Error('Stream buffer unavailable');

    const len = rangeEnd - rangeStart + 1;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(filePath, 'r');
    try {
      const bytesRead = fs.readSync(fd, buf, 0, len, rangeStart);
      if (bytesRead !== len) {
        throw new Error(`Short read at ${rangeStart}: got ${bytesRead} of ${len} bytes`);
      }
    } finally {
      fs.closeSync(fd);
    }
    return buf;
  }

  readRange(rangeStart, rangeEnd) {
    const len = rangeEnd - rangeStart + 1;
    const buf = Buffer.alloc(len);
    const filePath = this.servePath || this.spillPath;
    if (!filePath) throw new Error('Stream buffer unavailable');

    let bytesRead;
    if (this.spillFd != null) {
      bytesRead = fs.readSync(this.spillFd, buf, 0, len, rangeStart);
    } else {
      const fd = fs.openSync(filePath, 'r');
      try {
        bytesRead = fs.readSync(fd, buf, 0, len, rangeStart);
      } finally {
        fs.closeSync(fd);
      }
    }

    if (bytesRead !== len) {
      throw new Error(`Short read at ${rangeStart}: got ${bytesRead} of ${len} bytes`);
    }
    return buf;
  }

  prefetch(rangeEnd) {
    const aheadEnd = Math.min(this.file.size - 1, rangeEnd + (1024 * 1024 * 4));
    const next = chunksInRange(this.chunkMap, rangeEnd + 1, aheadEnd);
    for (const chunk of next) {
      if (!this.onDisk.has(chunk.chunk_index) && !this.pending.has(chunk.chunk_index)) {
        this.fetchChunk(chunk.chunk_index).catch(() => {});
      }
    }
  }

  prefetchMp4Bootstrap() {
    if (this.mp4Bootstrapped) return;
    this.mp4Bootstrapped = true;

    const headCount = Math.min(4, this.chunkMap.length);
    for (let i = 0; i < headCount; i++) {
      this.fetchChunk(i).catch(() => {});
    }

    const tailCount = Math.max(8, Math.ceil(this.chunkMap.length * 0.1));
    const tailStart = Math.max(0, this.chunkMap.length - Math.min(tailCount, this.chunkMap.length));
    for (let i = tailStart; i < this.chunkMap.length; i++) {
      if (i < headCount) continue;
      this.fetchChunk(i).catch(() => {});
    }
  }

  startBackgroundDownload() {
    for (const chunk of this.chunkMap) {
      if (!this.onDisk.has(chunk.chunk_index) && !this.pending.has(chunk.chunk_index)) {
        this.fetchChunk(chunk.chunk_index).catch(() => {});
      }
    }
  }
}

class LegacyStreamSession {
  constructor(userId, fileId, file, chunks, encryptionMeta, fileKey, user, view = null) {
    this.userId = userId;
    this.fileId = fileId;
    this.file = file;
    this.chunks = chunks;
    this.encryptionMeta = encryptionMeta;
    this.fileKey = fileKey;
    this.view = view;
    this.octokit = github.createClient(user.access_token);
    this.tempPath = path.join(cache.cacheDir, `${userId}_${fileId}_stream.bin`);
    this.bytesReady = 0;
    this.complete = false;
    this.error = null;
    this.waiters = [];
    this.status = {
      progress: 0,
      stage: 'fetching',
      segments: 0,
      total_segments: chunks.length,
      mode: 'sequential',
      bytes_ready: 0,
    };
    this.lastAccess = Date.now();
    this.downloadPool = createAdaptivePool(chunks.length, downloadPoolOptions(user));
    this.downloadPool.start();
    this.pipeline = this.runPipeline().catch(() => {});
  }

  touch() {
    this.lastAccess = Date.now();
  }

  notify() {
    for (const waiter of this.waiters) waiter();
    this.waiters = [];
  }

  async waitForByte(offset) {
    while (this.bytesReady <= offset && !this.complete && !this.error) {
      await new Promise((resolve) => this.waiters.push(resolve));
    }
    if (this.error) throw this.error;
  }

  async downloadChunkAt(index) {
    await this.downloadPool.acquire();
    try {
      const chunk = this.chunks[index];
      const data = await accounts.downloadChunkForView(this.userId, chunk, this.view);
      this.downloadPool.recordBytes(data.length);
      return data;
    } finally {
      this.downloadPool.release();
    }
  }

  async runPipeline() {
    try {
      if (this.file.chunk_count && this.chunks.length < this.file.chunk_count) {
        throw new Error(
          `File incomplete: only ${this.chunks.length} of ${this.file.chunk_count} chunks found — re-upload required`
        );
      }

      const decipher = nodeCrypto.createDecipheriv(
        'aes-256-gcm',
        this.fileKey,
        Buffer.from(this.encryptionMeta.iv, 'base64')
      );
      decipher.setAuthTag(Buffer.from(this.encryptionMeta.auth_tag, 'base64'));

      const fd = fs.openSync(this.tempPath, 'w+');
      const downloads = new Map();

      for (let i = 0; i < this.chunks.length; i++) {
        if (this.aborted) return;
        const window = Math.max(1, this.downloadPool.limit);
        for (let j = 0; j < window && i + j < this.chunks.length; j++) {
          const idx = i + j;
          if (!downloads.has(idx)) downloads.set(idx, this.downloadChunkAt(idx));
        }

        const enc = await downloads.get(i);
        downloads.delete(i);
        const plain = Buffer.concat([decipher.update(enc)]);

        fs.writeSync(fd, plain, 0, plain.length, this.bytesReady);
        this.bytesReady += plain.length;
        this.status.segments = i + 1;
        this.status.stage = 'streaming';
        this.status.bytes_ready = this.bytesReady;
        this.status.progress = Math.min(99, Math.round((this.bytesReady / this.file.size) * 100));
        this.notify();
      }

      const tail = decipher.final();
      if (tail.length) {
        fs.writeSync(fd, tail, 0, tail.length, this.bytesReady);
        this.bytesReady += tail.length;
      }

      fs.closeSync(fd);
      this.complete = true;
      this.status.stage = 'ready';
      this.status.progress = 100;
      this.status.bytes_ready = this.bytesReady;
      this.notify();

      const entry = await cache.registerFromPath(this.userId, this.fileId, this.tempPath, this.file);
      this.servePath = entry.path;
    } catch (err) {
      this.error = err;
      this.status.stage = 'error';
      this.notify();
    }
  }

  async serveRange(req, res) {
    const { start, end } = parseRange(req.headers.range, this.file.size);
    await this.waitForByte(end);

    const safeEnd = Math.min(end, (this.complete ? this.file.size : this.bytesReady) - 1);
    const filePath = this.servePath || this.tempPath;

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', this.file.mime_type || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, no-cache');

    if (req.headers.range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${safeEnd}/${this.file.size}`);
      res.setHeader('Content-Length', safeEnd - start + 1);
    } else {
      res.setHeader('Content-Length', safeEnd - start + 1);
    }

    if (!fs.existsSync(filePath)) {
      if (!res.headersSent) res.status(410).json({ error: 'Stream cache expired — refresh and try again' });
      return;
    }

    const stream = fs.createReadStream(filePath, { start, end: safeEnd });
    stream.on('error', (err) => {
      console.error('Stream read error:', err.message);
      if (!res.headersSent) res.status(500).end();
      else res.destroy();
    });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }
}

function getOrCreateChunkSession(userId, file, chunks, fileKey, user, view = null) {
  const key = sessionKey(userId, file.id, view);
  let session = sessions.get(key);
  if (!session) {
    session = new ChunkSession(userId, file.id, file, buildChunkMap(chunks), fileKey, user, view);
    sessions.set(key, session);
  }
  session.touch();
  return session;
}

function getOrCreateLegacySession(userId, file, chunks, encryptionMeta, fileKey, user, view = null) {
  const key = sessionKey(userId, file.id, view);
  let session = sessions.get(key);
  if (!session || !(session instanceof LegacyStreamSession)) {
    session = new LegacyStreamSession(userId, file.id, file, chunks, encryptionMeta, fileKey, user, view);
    sessions.set(key, session);
  }
  session.touch();
  return session;
}

function getSessionStatus(userId, fileId, view = null) {
  const session = sessions.get(sessionKey(userId, fileId, view));
  return session ? session.status : null;
}

function cleanupSessions() {
  const now = Date.now();
  for (const [key, session] of sessions) {
    if (now - session.lastAccess > SESSION_TTL_MS) {
      if (session.downloadPool) session.downloadPool.stop();
      if (session.spillFd != null) {
        try { fs.closeSync(session.spillFd); } catch { /* ignore */ }
      }
      if (session.spillPath && fs.existsSync(session.spillPath) && !session.finalized) {
        try { fs.unlinkSync(session.spillPath); } catch { /* ignore */ }
      }
      if (session.tempPath && fs.existsSync(session.tempPath)) {
        try { fs.unlinkSync(session.tempPath); } catch { /* ignore */ }
      }
      sessions.delete(key);
    }
  }
}

setInterval(cleanupSessions, 5 * 60 * 1000);

function clearForUser(userId) {
  const prefix = `${userId}:`;
  for (const [key, session] of sessions) {
    if (!key.startsWith(prefix)) continue;
    if (session.downloadPool) session.downloadPool.stop();
    if (session.spillFd != null) {
      try { fs.closeSync(session.spillFd); } catch { /* ignore */ }
    }
    sessions.delete(key);
  }
  for (const [key, viewers] of streamViewers) {
    if (key.startsWith(prefix)) streamViewers.delete(key);
  }
}

function registerStreamViewer(userId, fileId, viewerId, view = null) {
  const key = sessionKey(userId, fileId, view);
  if (!streamViewers.has(key)) streamViewers.set(key, new Set());
  streamViewers.get(key).add(viewerId);
}

function unregisterStreamViewer(userId, fileId, viewerId, view = null) {
  const key = sessionKey(userId, fileId, view);
  const viewers = streamViewers.get(key);
  if (!viewers) return false;
  viewers.delete(viewerId);
  if (viewers.size > 0) return false;
  streamViewers.delete(key);
  return true;
}

function disposeStreamSession(userId, fileId, view = null) {
  const key = sessionKey(userId, fileId, view);
  const session = sessions.get(key);
  if (session instanceof ChunkSession) {
    session.abort();
    if (!session.finalized) sessions.delete(key);
  } else if (session instanceof LegacyStreamSession) {
    session.aborted = true;
    if (session.downloadPool) session.downloadPool.stop();
    sessions.delete(key);
  }
  streamViewers.delete(key);
}

module.exports = {
  parseRange,
  buildChunkMap,
  chunksInRange,
  ChunkSession,
  LegacyStreamSession,
  getOrCreateChunkSession,
  getOrCreateLegacySession,
  getSessionStatus,
  clearForUser,
  registerStreamViewer,
  unregisterStreamViewer,
  disposeStreamSession,
  mapConcurrent,
  CONCURRENCY,
  sessionKey,
};
