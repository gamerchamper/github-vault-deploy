const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { VaultApiError } = require('./api');
const { SessionStore } = require('./session-store');

const MAX_CONCURRENCY = 20;
const DEFAULT_CONCURRENCY = 5;
const MAX_RETRIES_PER_CHUNK = Infinity;
const INIT_RETRY_DELAY_MS = 2000;
const MAX_INIT_RETRY_DELAY_MS = 60000;
const CHUNK_RETRY_DELAY_MS = 5000;
const MAX_CHUNK_RETRY_DELAY_MS = 600000;
const COMPLETE_RETRY_DELAY_MS = 5000;
const MAX_COMPLETE_RETRY_DELAY_MS = 600000;
const PROGRESS_INTERVAL_MS = 500;
const MAX_LOG_LINES = 500;

class UploadEngine {
  constructor(api, opts = {}) {
    this.api = api;
    this.concurrency = Math.min(opts.concurrency || DEFAULT_CONCURRENCY, MAX_CONCURRENCY);
    this.onProgress = opts.onProgress || (() => {});
    this.onLog = opts.onLog || (() => {});
    this.chunkSize = opts.chunkSize || 0;
    this.uploadMode = opts.uploadMode || 'api';
    this.convertHls = !!opts.convertHls;
    this.maxRetriesPerChunk = opts.maxRetriesPerChunk == null ? MAX_RETRIES_PER_CHUNK : opts.maxRetriesPerChunk;
    this.retryDelayMs = opts.retryDelayMs || CHUNK_RETRY_DELAY_MS;
    this.maxRetryDelayMs = opts.maxRetryDelayMs || MAX_CHUNK_RETRY_DELAY_MS;
    this._aborted = false;
    this._inflight = new Set();
    this._feedbackWarnings = new Set();
    this.diagnosticLogs = [];
  }

  _diag(msg, meta = {}) {
    const entry = { t: new Date().toISOString(), msg, ...meta };
    this.diagnosticLogs.push(entry);
    if (this.diagnosticLogs.length > MAX_LOG_LINES) this.diagnosticLogs.shift();
    this._log(`[${entry.t.slice(11, 19)}] ${msg}${Object.keys(meta).length ? ' ' + JSON.stringify(meta) : ''}`);
  }

  abort() {
    this._aborted = true;
    for (const ctrl of this._inflight) {
      try { ctrl.abort(); } catch {}
    }
  }

  _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  _log(msg) {
    this.onLog(msg);
  }

  _computeChunkSize(fileSize) {
    if (this.chunkSize > 0) return this.chunkSize;
    if (fileSize < 50 * 1024 * 1024) return 1024 * 1024;
    if (fileSize < 500 * 1024 * 1024) return 2 * 1024 * 1024;
    if (fileSize < 2 * 1024 * 1024 * 1024) return 5 * 1024 * 1024;
    return 10 * 1024 * 1024;
  }

  _computeContentHash(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', (err) => {
        this._diag('content_hash_failed', { error: err.message });
        resolve(null);
      });
    });
  }

  _isTransientError(err) {
    if (!err) return true;
    if (err.name === 'AbortError') return false;
    if (err instanceof VaultApiError) {
      if (err.status === 409) return false;
      return err.status === 408 || err.status === 429 || err.status >= 500;
    }
    return true;
  }

  _retryDelay(baseDelay, attempt) {
    const exponential = baseDelay * Math.pow(2, Math.min(attempt - 1, 8));
    const jitter = Math.floor(Math.random() * Math.min(baseDelay, 2000));
    return Math.min(exponential + jitter, this.maxRetryDelayMs);
  }

  _handleFeedback(feedback) {
    const warnings = feedback?.storage?.warnings || [];
    for (const warning of warnings) {
      if (this._feedbackWarnings.has(warning)) continue;
      this._feedbackWarnings.add(warning);
      this._log(`Server feedback: ${warning}`);
    }
  }

  async initSession(filePath, parentPath, fileId, taskId) {
    const stat = fs.statSync(filePath);
    const fileName = path.basename(filePath);
    const mimeType = this._guessMimeType(fileName);
    const cs = this._computeChunkSize(stat.size);

    this.session = SessionStore.create(taskId, {
      name: fileName,
      path: filePath,
      size: stat.size,
      mimeType,
      parentPath,
      chunkSize: cs,
      uploadMode: this.uploadMode,
      convertHls: this.convertHls,
    });
    this.session.fileId = fileId || null;
    SessionStore.save(this.session);

    this.filePath = filePath;
    this.fileSize = stat.size;

    // Compute content hash for duplicate detection (streaming, no memory load)
    this._diag('computing_content_hash', { size: stat.size });
    this.contentHash = await this._computeContentHash(filePath);
    if (this.contentHash) {
      this._diag('content_hash_computed', { hash: this.contentHash.slice(0, 16) + '...' });
    }

    let initResult = null;
    let retries = 0;

    while (!this._aborted) {
      try {
        await this.api.resumeTask(taskId).catch(() => {});
        initResult = await this.api.uploadInit({
          fileName,
          parentPath,
          size: stat.size,
          mimeType,
          chunkSize: cs,
          fileId: this.session.fileId,
          taskId,
          uploadMode: this.uploadMode,
          convertHls: this.convertHls,
        });
        break;
      } catch (err) {
        if (!this._isTransientError(err)) throw err;
        retries++;
        const delay = Math.min(INIT_RETRY_DELAY_MS * Math.pow(2, retries - 1), MAX_INIT_RETRY_DELAY_MS);
        this._log(`Init failed (${err.message}), retrying in ${Math.round(delay / 1000)}s (attempt ${retries})`);
        await this._sleep(delay);
      }
    }

    if (this._aborted) throw new Error('Aborted');
    if (!initResult) throw new Error('Failed to initialize upload session');

    this.session.fileId = initResult.fileId;
    this.session.taskId = initResult.jobId;
    this.session.totalChunks = initResult.totalChunks;
    this.session.chunkSize = initResult.chunkSize || cs;
    this.session.chunksDone = initResult.chunksDone || 0;
    this.session.status = 'uploading';
    this.session.error = null;
    SessionStore.save(this.session);
    this._handleFeedback(initResult.feedback);

    return initResult;
  }

  async resumeSession(taskId) {
    this.session = SessionStore.get(taskId);
    if (!this.session) throw new Error(`No local session found for task ${taskId}`);

    this.filePath = this.session.filePath;
    this.fileSize = this.session.fileSize;

    if (!fs.existsSync(this.filePath)) {
      throw new Error(`Original file not found at ${this.filePath} — select the same file and use --file to override`);
    }

    const stat = fs.statSync(this.filePath);
    if (stat.size !== this.fileSize) {
      throw new Error(`File size mismatch: expected ${this.fileSize} bytes, got ${stat.size}`);
    }

    let initResult = null;
    let retries = 0;

    while (!this._aborted) {
      try {
        await this.api.resumeTask(taskId).catch(() => {});
        initResult = await this.api.uploadInit({
          fileName: this.session.fileName,
          parentPath: this.session.parentPath,
          size: this.fileSize,
          mimeType: this.session.mimeType,
          chunkSize: this.session.chunkSize,
          fileId: this.session.fileId,
          taskId,
          uploadMode: this.session.uploadMode || 'api',
          convertHls: this.session.convertHls,
        });
        break;
      } catch (err) {
        if (!this._isTransientError(err)) throw err;
        retries++;
        const delay = Math.min(INIT_RETRY_DELAY_MS * Math.pow(2, retries - 1), MAX_INIT_RETRY_DELAY_MS);
        this._log(`Resume init failed (${err.message}), retrying in ${Math.round(delay / 1000)}s (attempt ${retries})`);
        await this._sleep(delay);
      }
    }

    if (this._aborted) throw new Error('Aborted');
    if (!initResult) throw new Error('Failed to resume upload session');

    this.session.fileId = initResult.fileId;
    this.session.taskId = initResult.jobId;
    this.session.totalChunks = initResult.totalChunks;
    this.session.chunkSize = initResult.chunkSize || this.session.chunkSize;
    this.session.chunksDone = initResult.chunksDone || 0;
    this.session.status = 'uploading';
    this.session.error = null;
    SessionStore.save(this.session);
    this._handleFeedback(initResult.feedback);

    return initResult;
  }

  async uploadAll() {
    const startChunk = this.session.chunksDone;
    const totalChunks = this.session.totalChunks;
    const chunkSize = this.session.chunkSize;
    const fileId = this.session.fileId;
    const taskId = this.session.taskId;

    if (startChunk >= totalChunks) {
      this._log(`All ${totalChunks} chunks already uploaded`);
      return this._complete(fileId, taskId);
    }

    this._log(`Uploading chunks ${startChunk} to ${totalChunks - 1} (${totalChunks - startChunk} chunks, concurrency=${this.concurrency})`);

    const startTime = Date.now();
    let uploadedBytes = 0;
    let lastProgressTime = 0;
    let currentChunksDone = startChunk;

    const queue = [];
    for (let i = startChunk; i < totalChunks; i++) {
      queue.push(i);
    }

    const reportProgress = () => {
      const elapsed = (Date.now() - startTime) / 1000;
      let speed = 0;
      if (elapsed > 0) speed = uploadedBytes / elapsed;
      this.onProgress({
        chunksDone: currentChunksDone,
        totalChunks,
        percent: totalChunks > 0 ? Math.round((currentChunksDone / totalChunks) * 100) : 0,
        bytesUploaded: uploadedBytes,
        speed,
        elapsed,
        eta: speed > 0 ? ((totalChunks - currentChunksDone) * chunkSize) / speed : 0,
      });
    };

    const uploadOne = async (chunkIndex) => {
      if (this._aborted) return false;
      const controller = new AbortController();
      this._inflight.add(controller);

      try {
        const start = chunkIndex * chunkSize;
        const end = Math.min(start + chunkSize, this.fileSize);
        const buf = Buffer.alloc(end - start);
        await fileHandle.read(buf, 0, buf.length, start);

        let lastErr = null;
        for (let attempt = 1; attempt <= this.maxRetriesPerChunk; attempt++) {
          if (this._aborted) return false;
          try {
            const result = await this.api.uploadChunk(
              fileId, chunkIndex, buf, taskId,
              this.session.uploadMode || 'api', controller.signal
            );
            if (!result.skipped) {
              uploadedBytes += buf.length;
            }
            this._handleFeedback(result.feedback);
            currentChunksDone = Math.max(currentChunksDone, result.chunksDone || 0);
            this.session.chunksDone = currentChunksDone;
            const now = Date.now();
            if (now - lastProgressTime >= PROGRESS_INTERVAL_MS) {
              lastProgressTime = now;
              reportProgress();
              SessionStore.save(this.session);
            }
            return true;
          } catch (err) {
            lastErr = err;
            if (err.name === 'AbortError') return false;
            if (err instanceof VaultApiError && err.status === 409) {
              this._diag('upload_paused_on_server', { chunkIndex });
              return false;
            }
            // Session not found: server may have lost track; re-init
            if (err.message && err.message.includes('Upload session not found')) {
              this._diag('session_not_found_reinit', { chunkIndex, attempt, taskId: this.session.taskId });
              try {
                await this.api.resumeTask(this.session.taskId).catch(() => {});
                const reinit = await this.api.uploadInit({
                  fileName: this.session.fileName,
                  parentPath: this.session.parentPath || '/',
                  size: this.fileSize,
                  mimeType: this.session.mimeType,
                  chunkSize: this.session.chunkSize,
                  fileId: this.session.fileId,
                  taskId: this.session.taskId,
                  uploadMode: this.session.uploadMode || 'api',
                  convertHls: this.session.convertHls,
                });
                this._diag('session_reinit_ok', { fileId: reinit.fileId, chunksDone: reinit.chunksDone });
                this.session.fileId = reinit.fileId;
                this.session.totalChunks = reinit.totalChunks;
                this.session.chunksDone = reinit.chunksDone || 0;
                this.session.status = 'uploading';
                this.session.error = null;
                SessionStore.save(this.session);
                // Retry this chunk immediately after re-init
                attempt--; // don't count this as a failed attempt
                continue;
              } catch (reinitErr) {
                this._diag('session_reinit_failed', { error: reinitErr.message });
                // Fall through to normal retry logic
              }
            }
            if (!this._isTransientError(err)) throw err;
            if (attempt < this.maxRetriesPerChunk) {
              const delay = this._retryDelay(this.retryDelayMs, attempt);
              this.session.status = 'waiting';
              this.session.error = err.message;
              SessionStore.save(this.session);
              this._diag(`chunk_retry`, { chunkIndex, attempt, delay, error: err.message });
              await this._sleep(delay);
              this.session.status = 'uploading';
              this.session.error = null;
              SessionStore.save(this.session);
            }
          }
        }
        throw lastErr || new Error(`Chunk ${chunkIndex} failed after ${this.maxRetriesPerChunk} attempts`);
      } finally {
        this._inflight.delete(controller);
      }
    };

    const errors = [];
    let paused = false;

    const runPool = async () => {
      const active = new Set();
      let idx = 0;
      while (idx < queue.length) {
        if (this._aborted || paused) break;
        while (active.size < this.concurrency && idx < queue.length && !this._aborted) {
          const chunkIdx = queue[idx++];
          const prom = uploadOne(chunkIdx).then(result => {
            active.delete(prom);
            if (result === false) paused = true;
            return result;
          }).catch(err => {
            active.delete(prom);
            errors.push(err);
            return false;
          });
          active.add(prom);
        }
        if (active.size > 0) {
          await Promise.race([...active]);
        }
      }
      if (active.size > 0) {
        const results = await Promise.all([...active]);
        for (const r of results) {
          if (r === false) paused = true;
        }
      }
    };

    let fileHandle;
    try {
      fileHandle = await fs.promises.open(this.filePath, 'r');
      await runPool();
    } finally {
      if (fileHandle) await fileHandle.close().catch(() => {});
    }

    this.session.chunksDone = currentChunksDone;
    SessionStore.save(this.session);

    if (errors.length > 0) {
      this.session.status = 'error';
      this.session.error = errors[0].message;
      SessionStore.save(this.session);
      throw errors[0];
    }

    if (paused || this._aborted) {
      this.session.status = 'paused';
      SessionStore.save(this.session);
      return null;
    }

    reportProgress();
    return this._complete(fileId, taskId);
  }

  async _complete(fileId, taskId) {
    this._log('All chunks uploaded, completing...');
    let previewBuffer = null;

    try {
      const previewSize = Math.min(this.fileSize, 1024 * 1024);
      const fd = fs.openSync(this.filePath, 'r');
      previewBuffer = Buffer.alloc(previewSize);
      const bytesRead = fs.readSync(fd, previewBuffer, 0, previewSize, 0);
      fs.closeSync(fd);
      if (bytesRead < previewSize) previewBuffer = previewBuffer.subarray(0, bytesRead);
    } catch {}

    let result = null;
    let attempt = 0;
    while (!this._aborted) {
      attempt++;
      try {
        result = await this.api.uploadComplete(
          fileId, taskId, previewBuffer,
          this.session.uploadMode || 'api',
          this.session.convertHls,
          this.contentHash
        );
        this._handleFeedback(result.feedback);
        break;
      } catch (err) {
        if (!this._isTransientError(err)) throw err;
        if (err.message && err.message.includes('Upload session not found')) {
          this._diag('complete_session_not_found_reinit', { attempt, taskId: this.session.taskId });
          try {
            await this.api.resumeTask(this.session.taskId).catch(() => {});
            const reinit = await this.api.uploadInit({
              fileName: this.session.fileName, parentPath: this.session.parentPath || '/',
              size: this.fileSize, mimeType: this.session.mimeType,
              chunkSize: this.session.chunkSize, fileId: this.session.fileId,
              taskId: this.session.taskId, uploadMode: this.session.uploadMode || 'api',
              convertHls: this.session.convertHls,
            });
            this._diag('complete_reinit_ok', { fileId: reinit.fileId, chunksDone: reinit.chunksDone });
            this.session.fileId = reinit.fileId; this.session.totalChunks = reinit.totalChunks;
            this.session.chunksDone = reinit.chunksDone || 0;
            this.session.status = 'uploading'; this.session.error = null;
            SessionStore.save(this.session);
            continue;
          } catch (reinitErr) {
            this._diag('complete_reinit_failed', { error: reinitErr.message });
          }
        }
        const delay = this._retryDelay(COMPLETE_RETRY_DELAY_MS, attempt);
        this.session.status = 'waiting';
        this.session.error = err.message;
        SessionStore.save(this.session);
        this._diag('complete_retry', { attempt, delay, error: err.message });
        await this._sleep(delay);
      }
    }

    if (this._aborted) throw new Error('Aborted');

    this.session.status = 'done';
    SessionStore.remove(taskId);
    this._log(`Upload complete: ${result.name || 'file'} (${result.id})`);
    return result;
  }

  async status(taskId) {
    const session = SessionStore.get(taskId);
    const remote = await this.api.getTask(taskId).catch(() => null);
    return { session, remote };
  }

  _guessMimeType(fileName) {
    const ext = path.extname(fileName).toLowerCase();
    const map = {
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mkv': 'video/x-matroska',
      '.avi': 'video/x-msvideo',
      '.mov': 'video/quicktime',
      '.m4v': 'video/x-m4v',
      '.ogv': 'video/ogg',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.flac': 'audio/flac',
      '.ogg': 'audio/ogg',
      '.m4a': 'audio/mp4',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf',
      '.zip': 'application/zip',
      '.tar': 'application/x-tar',
      '.gz': 'application/gzip',
      '.json': 'application/json',
      '.txt': 'text/plain',
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
    };
    return map[ext] || 'application/octet-stream';
  }
}

module.exports = { UploadEngine, DEFAULT_CONCURRENCY, MAX_CONCURRENCY };
