const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const db = require('../db/database');
const cache = require('./cache');
const mp4 = require('./mp4');
const mp4Atoms = require('./mp4-atoms');
const streaming = require('./streaming');
const { recordBytes } = require('./bandwidth');
const {
  getOrCreateChunkSession,
  buildChunkMap,
} = require('./chunk-session');
const { isChunkMode } = require('./storage');

const execFileAsync = promisify(execFile);

const hlsSessions = new Map();
const HLS_SESSION_TTL_MS = 30 * 60 * 1000;

function hlsKey(userId, fileId, view = null) {
  const viewPart = !view || view.type === 'primary' ? 'primary' : `${view.type}:${view.accountId}`;
  return `${userId}:${fileId}:${viewPart}`;
}

function hlsDir(userId, fileId) {
  return path.join(cache.cacheDir, `${userId}_${fileId}_hls`);
}

class HlsSession {
  constructor(userId, file, chunks, fileKey, user, view = null) {
    this.userId = userId;
    this.file = file;
    this.chunks = chunks;
    this.chunkMap = buildChunkMap(chunks);
    this.fileKey = fileKey;
    this.user = user;
    this.view = view;
    this.dir = hlsDir(userId, file.id);
    this.segments = new Map();
    this.generating = new Set();
    this.moov = null;
    this.durationSec = null;
    this.lastAccess = Date.now();
    this.backgroundStarted = false;
    this.segmentPipeline = null;
    this.aborted = false;
    this.failedSegments = new Map();
    this.retryTimer = null;

    fs.mkdirSync(this.dir, { recursive: true });

    this.session = getOrCreateChunkSession(userId, file, chunks, fileKey, user, view);
    this.session.status.mode = 'hls';

    this.session.prefetchMp4Bootstrap();
    this.startBackgroundDownload();

    this._onChunkHook = () => this.onChunkActivity();
    this.session.onChunkReady = this._onChunkHook;
    this.onChunkActivity();
  }

  touch() {
    this.lastAccess = Date.now();
    this.session.touch();
  }

  startBackgroundDownload() {
    if (this.backgroundStarted || this.aborted) return;
    this.backgroundStarted = true;

    for (const chunk of this.chunkMap) {
      if (!this.session.onDisk.has(chunk.chunk_index) && !this.session.pending.has(chunk.chunk_index)) {
        this.session.fetchChunk(chunk.chunk_index).catch(() => {});
      }
    }
  }

  isContiguousThrough(index) {
    for (let i = 0; i <= index; i++) {
      if (!this.session.onDisk.has(i)) return false;
    }
    return true;
  }

  async getSourcePath() {
    const fromSession = await this.session.resolveReadPath();
    if (fromSession) return fromSession;
    const cached = cache.get(this.userId, this.file.id);
    if (cached?.path && fs.existsSync(cached.path)) return cached.path;
    return null;
  }

  tailChunksOnDisk() {
    const tailCount = Math.max(4, Math.ceil(this.chunkMap.length * 0.08));
    const tailStart = Math.max(0, this.chunkMap.length - tailCount);
    for (let i = tailStart; i < this.chunkMap.length; i++) {
      if (!this.session.onDisk.has(i)) return false;
    }
    return true;
  }

  async tryExtractMoov() {
    if (this.moov) return true;
    if (!this.session.onDisk.has(0)) return false;

    const sourcePath = await this.getSourcePath();
    if (!sourcePath) return false;

    let moov = mp4Atoms.extractMoovFromHead(sourcePath);
    if (!moov) {
      if (!this.tailChunksOnDisk() && !this.session.finalized) return false;
      moov = mp4Atoms.extractMoovFromTail(sourcePath, this.file.size);
    }
    if (!moov) return false;

    this.moov = moov;
    this.session.status.moov_ready = true;

    try {
      const partialPath = await this.buildPartialMp4(this.chunkMap.length - 1);
      this.durationSec = await mp4.probeDuration(partialPath);
      if (this.durationSec) {
        this.session.status.duration_sec = this.durationSec;
      }
    } catch {
      /* duration optional */
    }

    return true;
  }

  async buildPartialMp4(throughIndex) {
    const chunk = this.chunkMap[throughIndex];
    const prefixEnd = chunk.byteEnd + 1;

    await this.session.ensureRange(0, chunk.byteEnd);

    if (this.session.contiguousBytesReady() < prefixEnd) {
      throw new Error(`Waiting for ${prefixEnd} bytes (have ${this.session.contiguousBytesReady()})`);
    }

    if (!this.moov) {
      await this.tryExtractMoov();
      if (!this.moov) throw new Error('moov atom not available yet');
    }

    const sourcePath = await this.getSourcePath();
    if (!sourcePath) throw new Error('Stream buffer unavailable');

    const stat = fs.statSync(sourcePath);
    if (stat.size < prefixEnd) {
      throw new Error(`Stream buffer too short (${stat.size} < ${prefixEnd})`);
    }

    const prefix = await this.session.readRangeAsync(0, prefixEnd - 1);
    if (prefix.length !== prefixEnd) {
      throw new Error(`Short read building partial MP4 (${prefix.length} < ${prefixEnd})`);
    }

    if (!mp4Atoms.patchTruncatedMdat(prefix, prefixEnd)) {
      throw new Error('Could not patch mdat atom in partial MP4');
    }

    const outPath = path.join(this.dir, `partial_${throughIndex}.mp4`);
    fs.writeFileSync(outPath, Buffer.concat([prefix, this.moov.buffer]));
    return outPath;
  }

  segmentDuration(index) {
    if (this.durationSec && this.file.size > 0) {
      const chunk = this.chunkMap[index];
      const chunkBytes = chunk.plainSize;
      return Math.max(0.5, (chunkBytes / this.file.size) * this.durationSec);
    }
    return 6;
  }

  segmentStartTime(index) {
    if (!this.durationSec || this.file.size <= 0) return index * 6;
    const chunk = this.chunkMap[index];
    return (chunk.byteStart / this.file.size) * this.durationSec;
  }

  async transmuxSegment(partialPath, segPath, start, duration) {
    const baseArgs = [
      '-y',
      '-ss', String(Math.max(0, start)),
      '-i', partialPath,
      '-t', String(duration),
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
    ];

    const attempts = [
      [...baseArgs, '-bsf:v', 'h264_mp4toannexb', '-f', 'mpegts', segPath],
      [...baseArgs, '-f', 'mpegts', segPath],
    ];

    let lastErr = null;
    for (const args of attempts) {
      try {
        await execFileAsync('ffmpeg', args, { timeout: 10 * 60 * 1000 });
        if (fs.existsSync(segPath)) return;
      } catch (err) {
        lastErr = err;
        if (fs.existsSync(segPath)) fs.unlinkSync(segPath);
      }
    }

    throw lastErr || new Error('Segment transmux failed');
  }

  recordSegmentFailure(index, err) {
    const prev = this.failedSegments.get(index) || { count: 0, nextRetryAt: 0 };
    const count = prev.count + 1;
    const backoff = Math.min(60000, 2000 * Math.pow(1.5, count - 1));
    this.failedSegments.set(index, {
      count,
      nextRetryAt: Date.now() + backoff,
      lastError: err?.message || String(err),
    });
    if (count <= 3) {
      console.warn(`HLS segment ${index} failed (${this.file.id}):`, err?.message || err);
    }
  }

  canGenerateSegment(index) {
    if (this.aborted) return false;
    const failed = this.failedSegments.get(index);
    if (!failed) return true;
    if (failed.count >= 8) return false;
    return Date.now() >= failed.nextRetryAt;
  }

  scheduleSegmentWork(delayMs = 1000) {
    if (this.aborted || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.onChunkActivity();
    }, delayMs);
  }

  async generateSegment(index) {
    if (this.aborted) return;
    if (this.segments.has(index) || this.generating.has(index)) return;
    if (!this.isContiguousThrough(index)) return;
    if (!this.canGenerateSegment(index)) return;

    this.generating.add(index);
    const partialPath = path.join(this.dir, `partial_${index}.mp4`);
    const segPath = path.join(this.dir, `segment_${index}.ts`);

    try {
      await this.tryExtractMoov();
      if (!this.moov) return;

      await this.buildPartialMp4(index);
      const start = this.segmentStartTime(index);
      const duration = this.segmentDuration(index);

      await this.transmuxSegment(partialPath, segPath, start, duration);

      this.segments.set(index, {
        path: segPath,
        duration,
      });
      this.failedSegments.delete(index);

      this.session.status.hls_segments = this.segments.size;
    } catch (err) {
      if (fs.existsSync(partialPath)) {
        try { fs.unlinkSync(partialPath); } catch { /* ignore */ }
      }
      if (fs.existsSync(segPath)) {
        try { fs.unlinkSync(segPath); } catch { /* ignore */ }
      }
      this.recordSegmentFailure(index, err);
    } finally {
      this.generating.delete(index);
    }
  }

  async processSegmentQueue(lastReady) {
    for (let i = 0; i <= lastReady; i++) {
      if (this.aborted) return;
      if (this.segments.has(i)) continue;
      if (!this.canGenerateSegment(i)) {
        this.scheduleSegmentWork();
        return;
      }
      await this.generateSegment(i);
      if (!this.segments.has(i)) {
        this.scheduleSegmentWork();
        return;
      }
    }
  }

  onChunkActivity() {
    if (this.aborted) return;
    this.tryExtractMoov().catch(() => {});

    if (this.session.finalized || cache.get(this.userId, this.file.id)) {
      this.session.status.stage = 'ready';
      this.session.status.buffered = true;
    }

    let lastReady = -1;
    for (let i = 0; i < this.chunkMap.length; i++) {
      if (!this.isContiguousThrough(i)) break;
      lastReady = i;
    }

    if (lastReady < 0) return;
    if (this.segmentPipeline) return;

    this.segmentPipeline = this.processSegmentQueue(lastReady)
      .catch((err) => {
        console.warn(`HLS segment pipeline error (${this.file.id}):`, err.message);
      })
      .finally(() => {
        this.segmentPipeline = null;
        if (this.aborted) return;

        let nextReady = -1;
        for (let i = 0; i < this.chunkMap.length; i++) {
          if (!this.isContiguousThrough(i)) break;
          nextReady = i;
        }
        if (nextReady < 0) return;

        for (let i = 0; i <= nextReady; i++) {
          if (!this.segments.has(i) && this.canGenerateSegment(i)) {
            this.scheduleSegmentWork(500);
            return;
          }
        }
      });
  }

  highestReadySegment() {
    let highest = -1;
    for (const [index] of this.segments) {
      if (index > highest) highest = index;
    }
    return highest;
  }

  buildPlaylist(baseUrl) {
    const highest = this.highestReadySegment();
    if (highest < 0) {
      return [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:10',
        '#EXT-X-PLAYLIST-TYPE:EVENT',
        '',
      ].join('\n');
    }

    let maxDuration = 10;
    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXT-X-PLAYLIST-TYPE:EVENT',
    ];

    for (let i = 0; i <= highest; i++) {
      const seg = this.segments.get(i);
      if (!seg) continue;
      maxDuration = Math.max(maxDuration, Math.ceil(seg.duration));
      lines.push(`#EXTINF:${seg.duration.toFixed(3)},`);
      lines.push(`${baseUrl}/segment/${i}.ts`);
    }

    lines.splice(2, 0, `#EXT-X-TARGETDURATION:${maxDuration}`);

    const allDone = this.session.onDisk.size === this.chunkMap.length
      && highest === this.chunkMap.length - 1;
    if (allDone) {
      lines.push('#EXT-X-ENDLIST');
    }

    return `${lines.join('\n')}\n`;
  }

  getSegment(index) {
    return this.segments.get(index) || null;
  }

  abort() {
    if (this.aborted) return;
    this.aborted = true;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.session.onChunkReady === this._onChunkHook) {
      this.session.onChunkReady = null;
    }
  }

  getStatus() {
    const highest = this.highestReadySegment();
    return {
      moov_ready: !!this.moov,
      hls_segments: this.segments.size,
      hls_ready: highest >= 0,
      playable: highest >= 0 || (this.session.status.bytes_ready > 0),
    };
  }
}

async function resolveHlsContext(userId, fileId, view = null) {
  const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(fileId, userId);
  if (!file || file.is_folder) return null;

  if (!mp4.isMp4(file.name, file.mime_type)) return null;

  const chunks = db.prepare(
    'SELECT c.*, r.full_name, r.default_branch FROM chunks c JOIN storage_repos r ON c.repo_id = r.id WHERE c.file_id = ? ORDER BY c.chunk_index'
  ).all(fileId);

  if (!isChunkMode(file, chunks) || chunks.length < 2) return null;

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const fileKey = await streaming.getFileKey(userId, file);

  return { file, chunks, fileKey, user };
}

async function getOrCreateHlsSession(userId, fileId, view = null) {
  const key = hlsKey(userId, fileId, view);
  let session = hlsSessions.get(key);
  if (session) {
    session.touch();
    return session;
  }

  const ctx = await resolveHlsContext(userId, fileId, view);
  if (!ctx) return null;

  session = new HlsSession(userId, ctx.file, ctx.chunks, ctx.fileKey, ctx.user, view);
  hlsSessions.set(key, session);
  return session;
}

async function waitForFirstSegment(session, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    session.onChunkActivity();
    await session.tryExtractMoov();
    if (session.highestReadySegment() >= 0) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return session.highestReadySegment() >= 0;
}

async function servePlaylist(req, res, userId, fileId, baseUrl, view = null) {
  const usePrimaryCache = !view || view.type === 'primary';
  if (usePrimaryCache) {
    const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(fileId, userId);
    if (file) {
      const streamCache = require('./stream-cache');
      if (streamCache.getFaststart(userId, fileId, file.size) || cache.get(userId, fileId)) {
        return res.status(404).json({ error: 'HLS not needed — file cached' });
      }
    }
  }

  const session = await getOrCreateHlsSession(userId, fileId, view);
  if (!session) return res.status(404).json({ error: 'HLS not available' });

  session.touch();
  const hasSegment = await waitForFirstSegment(session);

  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Cache-Control', 'no-cache');

  if (!hasSegment) {
    return res.status(503).setHeader('Retry-After', '2')
      .send(Buffer.from('#EXTM3U\n# Waiting for first segment\n', 'utf8'));
  }

  const playlist = session.buildPlaylist(baseUrl);
  res.send(Buffer.from(playlist, 'utf8'));
  recordBytes(userId, fileId, Buffer.byteLength(playlist, 'utf-8'), 'stream');
}

async function serveSegment(req, res, userId, fileId, index, view = null) {
  const session = await getOrCreateHlsSession(userId, fileId, view);
  if (!session) return res.status(404).json({ error: 'HLS not available' });

  session.touch();
  const segIndex = parseInt(index, 10);
  if (!Number.isFinite(segIndex) || segIndex < 0) {
    return res.status(400).json({ error: 'Invalid segment' });
  }

  if (!session.isContiguousThrough(segIndex)) {
    try {
      await session.session.ensureRange(
        session.chunkMap[segIndex].byteStart,
        session.chunkMap[segIndex].byteEnd
      );
    } catch (err) {
      return res.status(503).json({ error: err.message });
    }
  }

  try {
    await session.generateSegment(segIndex);
  } catch (err) {
    console.warn(`HLS serveSegment ${segIndex} (${fileId}):`, err.message);
    return res.status(503).setHeader('Retry-After', '2').json({ error: 'Segment not ready' });
  }

  const seg = session.getSegment(segIndex);
  if (!seg || !fs.existsSync(seg.path)) {
    return res.status(404).json({ error: 'Segment not ready' });
  }

  res.setHeader('Content-Type', 'video/mp2t');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  const segSize = fs.statSync(seg.path).size;
  res.setHeader('Content-Length', segSize);
  fs.createReadStream(seg.path).pipe(res);
  recordBytes(userId, fileId, segSize, 'stream');
}

function getHlsStatus(userId, fileId, view = null) {
  const session = hlsSessions.get(hlsKey(userId, fileId, view));
  return session ? session.getStatus() : null;
}

function cleanupHlsSessions() {
  const now = Date.now();
  for (const [key, session] of hlsSessions) {
    if (now - session.lastAccess > HLS_SESSION_TTL_MS) {
      hlsSessions.delete(key);
    }
  }
}

function disposeHlsSession(userId, fileId, view = null) {
  const key = hlsKey(userId, fileId, view);
  const session = hlsSessions.get(key);
  if (!session) return;
  session.abort();
  hlsSessions.delete(key);
}

function releaseShareStream(userId, fileId, viewerId, view = null) {
  const {
    unregisterStreamViewer,
    disposeStreamSession,
  } = require('./chunk-session');

  const lastViewer = unregisterStreamViewer(userId, fileId, viewerId, view);
  if (!lastViewer) return;
  disposeHlsSession(userId, fileId, view);
  disposeStreamSession(userId, fileId, view);
}

function clearForUser(userId) {
  for (const [key, session] of hlsSessions) {
    if (String(session.userId) !== String(userId)) continue;
    session.abort();
    hlsSessions.delete(key);
  }
}

setInterval(cleanupHlsSessions, 5 * 60 * 1000);

module.exports = {
  getOrCreateHlsSession,
  servePlaylist,
  serveSegment,
  getHlsStatus,
  disposeHlsSession,
  releaseShareStream,
  clearForUser,
  hlsKey,
};
