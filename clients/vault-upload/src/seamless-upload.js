const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { VaultApiError } = require('./api');
const { SessionStore } = require('./session-store');

const DEFAULT_PART_CONCURRENCY = 8;
const MAX_PART_CONCURRENCY = 16;
const POLL_INTERVAL_MS = 1000;
const DEFAULT_CHUNK_SIZE = 921600;

function guessMimeType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  const map = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.mov': 'video/quicktime',
    '.avi': 'video/x-msvideo',
    '.m4v': 'video/x-m4v',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.pdf': 'application/pdf',
    '.json': 'application/json',
    '.txt': 'text/plain',
  };
  return map[ext] || 'application/octet-stream';
}

class SeamlessUploadEngine {
  constructor(api, opts = {}) {
    this.api = api;
    this.concurrency = Math.min(
      opts.concurrency || DEFAULT_PART_CONCURRENCY,
      MAX_PART_CONCURRENCY
    );
    this.chunkSize = opts.chunkSize || 0;
    this.convertHls = !!opts.convertHls;
    this.onProgress = opts.onProgress || (() => {});
    this.onLog = opts.onLog || (() => {});
    this._aborted = false;
    this.session = null;
    this.filePath = null;
    this.fileSize = 0;
  }

  abort() {
    this._aborted = true;
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

  _reportProgress(partial) {
    this.onProgress({
      chunksDone: 0,
      totalChunks: 0,
      percent: 0,
      bytesUploaded: 0,
      speed: 0,
      phase: 'receiving',
      ...partial,
    });
  }

  async initSession(filePath, parentPath = '/', taskId = null) {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);

    const stat = fs.statSync(resolved);
    const fileName = path.basename(resolved);
    const id = taskId || SessionStore.generateTaskId();

    this.filePath = resolved;
    this.fileSize = stat.size;
    this.session = SessionStore.create(id, {
      path: resolved,
      name: fileName,
      size: stat.size,
      mimeType: guessMimeType(fileName),
      parentPath: parentPath || '/',
      chunkSize: this._computeChunkSize(stat.size),
      uploadMode: 'seamless',
      convertHls: this.convertHls,
    });

    return this._initOnServer();
  }

  async resumeSession(taskId) {
    const session = SessionStore.get(taskId);
    if (!session) throw new Error(`No local session found for ${taskId}`);
    if (session.uploadMode !== 'seamless') {
      throw new Error('Session is not a seamless upload');
    }

    const resolved = path.resolve(session.filePath || '');
    if (!fs.existsSync(resolved)) {
      throw new Error(`File not found: ${resolved}`);
    }
    const stat = fs.statSync(resolved);
    if (stat.size !== session.fileSize) {
      throw new Error('Local file size does not match the interrupted upload');
    }

    this.filePath = resolved;
    this.fileSize = stat.size;
    this.session = session;
    this.convertHls = !!session.convertHls;

    if (session.fileId) {
      const status = await this.api.seamlessStatus(session.fileId).catch(() => null);
      if (status?.stagingComplete) {
        await this.api.resumeTask(taskId).catch(() => {});
        await this.api.seamlessResume(session.fileId, taskId, this.convertHls);
        this._log('Server cache complete — resuming server processing');
        return {
          fileId: session.fileId,
          jobId: taskId,
          totalParts: status.totalParts,
          nextPart: status.totalParts,
          stagingComplete: true,
        };
      }
    }

    return this._initOnServer();
  }

  async _initOnServer() {
    const init = await this.api.seamlessInit({
      fileName: this.session.fileName,
      parentPath: this.session.parentPath,
      size: this.fileSize,
      mimeType: this.session.mimeType,
      chunkSize: this.session.chunkSize,
      fileId: this.session.fileId || undefined,
      taskId: this.session.taskId,
      convertHls: this.convertHls,
    });

    this.session.fileId = init.fileId;
    this.session.taskId = init.jobId;
    this.session.totalParts = init.totalParts;
    this.session.partSize = init.partSize;
    this.session.totalChunks = init.totalChunks || 0;
    this.session.status = 'uploading';
    this.session.error = null;
    SessionStore.save(this.session);

    this._log(`Seamless upload started — ${init.totalParts} part(s) to server cache`);
    return init;
  }

  async uploadAll() {
    if (!this.session || !this.filePath) {
      throw new Error('Upload session not initialized');
    }

    if (!this.session.fileId) {
      await this._initOnServer();
    }

    const status = await this.api.seamlessStatus(this.session.fileId).catch(() => null);
    if (status?.stagingComplete) {
      await this.api.resumeTask(this.session.taskId).catch(() => {});
      await this.api.seamlessResume(this.session.fileId, this.session.taskId, this.convertHls);
      this._log('Server cache complete — resuming server processing');
      return this._waitForServerProcessing(this.session.taskId);
    }

    const init = {
      fileId: this.session.fileId,
      jobId: this.session.taskId,
      totalParts: this.session.totalParts || status?.totalParts,
      partSize: this.session.partSize || status?.partSize,
      nextPart: status?.nextPart ?? 0,
    };
    if (!init.totalParts || !init.partSize) {
      throw new Error('Seamless upload session is missing part metadata');
    }

    const { fileId, jobId, totalParts, partSize } = init;
    const startPart = init.nextPart ?? 0;
    const partIndices = [];
    for (let i = startPart; i < totalParts; i++) partIndices.push(i);

    const startTime = Date.now();
    let uploadedBytes = 0;
    let partsDone = startPart;

    const uploadPart = async (partIndex) => {
      if (this._aborted) return false;
      const start = partIndex * partSize;
      const length = Math.min(partSize, this.fileSize - start);
      const buffer = Buffer.alloc(length);
      const fd = await fs.promises.open(this.filePath, 'r');
      try {
        await fd.read(buffer, 0, length, start);
      } finally {
        await fd.close();
      }

      let lastErr;
      for (let attempt = 1; attempt <= 12; attempt++) {
        if (this._aborted) return false;
        try {
          const result = await this.api.seamlessPart(fileId, partIndex, buffer, jobId);
          uploadedBytes += buffer.length;
          partsDone = Math.max(partsDone, result.partsDone || partIndex + 1);
          const elapsed = (Date.now() - startTime) / 1000;
          const speed = elapsed > 0 ? uploadedBytes / elapsed : 0;
          this._reportProgress({
            phase: result.partsDone >= totalParts ? 'processing' : 'receiving',
            seamlessPartsDone: result.partsDone,
            seamlessPartsTotal: totalParts,
            chunksDone: result.partsDone,
            totalChunks: totalParts,
            percent: result.percent ?? Math.round((partsDone / totalParts) * 35),
            bytesUploaded: uploadedBytes,
            speed,
          });
          return true;
        } catch (err) {
          lastErr = err;
          if (err instanceof VaultApiError && err.status === 409) return false;
          await this._sleep(Math.min(2000 * attempt, 15000));
        }
      }
      throw lastErr || new Error(`Part ${partIndex} upload failed`);
    };

    await this._runPool(partIndices, this.concurrency, uploadPart);

    await this.api.seamlessComplete(fileId, jobId, this.convertHls);
    this.session.status = 'processing';
    SessionStore.save(this.session);
    this._log('All parts cached on server — processing encrypt/upload/HLS');

    return this._waitForServerProcessing(jobId);
  }

  async _runPool(items, limit, fn) {
    const results = new Array(items.length);
    let idx = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (true) {
        const i = idx++;
        if (i >= items.length) break;
        results[i] = await fn(items[i], i);
      }
    });
    await Promise.all(workers);
    if (results.some((r) => r === false)) {
      throw new Error('Upload paused or aborted');
    }
  }

  async _waitForServerProcessing(taskId) {
    while (!this._aborted) {
      const task = await this.api.getTask(taskId);
      const pct = task.percent || 0;
      this._reportProgress({
        phase: task.phase || 'processing',
        percent: pct,
        chunksDone: task.chunksDone || task.chunks_done || 0,
        totalChunks: task.chunksTotal || task.chunks_total || 0,
        seamlessPartsDone: task.seamlessPartsDone || task.seamless_parts_done,
        seamlessPartsTotal: task.seamlessPartsTotal || task.seamless_parts_total,
      });

      if (task.status === 'done') {
        this.session.status = 'done';
        SessionStore.remove(this.session.taskId);
        return { fileId: this.session.fileId, taskId, status: 'done' };
      }
      if (task.status === 'error') {
        this.session.status = 'error';
        this.session.error = task.error || 'Server processing failed';
        SessionStore.save(this.session);
        throw new Error(this.session.error);
      }
      if (task.status === 'cancelled') {
        throw new Error('Upload cancelled on server');
      }
      await this._sleep(POLL_INTERVAL_MS);
    }
    throw new Error('Upload aborted');
  }
}

module.exports = { SeamlessUploadEngine, DEFAULT_PART_CONCURRENCY, guessMimeType };
