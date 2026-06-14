const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const storage = require('./storage');
const thumbnails = require('./thumbnails');

const SEAMLESS_DIR = path.join(__dirname, '../../data/seamless-uploads');
const PART_MB = parseInt(process.env.SEAMLESS_PART_MB || '16', 10);
const SEAMLESS_PART_SIZE = Math.max(4, PART_MB) * 1024 * 1024;
const MAX_RECEIVE_PERCENT = 35;
const MAX_PROCESS_PERCENT = 90;
const RETRY_MAX = 12;
const RETRY_BASE_MS = 2000;

const processing = new Set();

function stagingPath(userId, fileId) {
  return path.join(SEAMLESS_DIR, String(userId), fileId, 'source');
}

function stagingDir(userId, fileId) {
  return path.dirname(stagingPath(userId, fileId));
}

function ensureStagingDir(userId, fileId) {
  const dir = stagingDir(userId, fileId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getStagingPathIfExists(userId, fileId) {
  const p = stagingPath(userId, fileId);
  return fs.existsSync(p) ? p : null;
}

function cleanupStaging(userId, fileId) {
  try {
    fs.rmSync(stagingDir(userId, fileId), { recursive: true, force: true });
  } catch {}
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  if (!msg) return true;
  const permanent = [
    'invalid part',
    'upload session not found',
    'file does not match',
    'no storage repositories',
    'not enough storage',
    'user not found',
    'encryption not initialized',
    'ffmpeg is required',
    'invalid chunk index',
    'chunk blob is',
    'a file with this name already exists',
  ];
  return !permanent.some((p) => msg.includes(p));
}

function readStagingRange(staging, start, length) {
  const fd = fs.openSync(staging, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, start);
    return n === length ? buf : buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

function partCount(fileSize) {
  return Math.ceil(fileSize / SEAMLESS_PART_SIZE) || 1;
}

function loadReceivedParts(task) {
  const raw = task?.seamlessPartsReceived;
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.map((n) => parseInt(n, 10)).filter(Number.isFinite));
}

function saveReceivedParts(taskId, userId, parts) {
  const tasks = require('./tasks');
  tasks.update(taskId, userId, {
    seamlessPartsReceived: [...parts].sort((a, b) => a - b),
    seamlessPartsDone: parts.size,
  });
}

async function initSeamlessUpload(userId, params) {
  const {
    fileName,
    parentPath,
    size,
    mimeType,
    chunkSize,
    fileId: resumeFileId,
    convertHls = false,
    taskId: existingTaskId,
  } = params;

  const session = await storage.initUploadSession(userId, {
    fileName,
    parentPath,
    size: parseInt(size, 10),
    mimeType,
    chunkSize: parseInt(chunkSize, 10) || storage.CHUNK_SIZE,
    fileId: resumeFileId,
    convertHls,
  });

  const fileId = session.fileId;
  const totalParts = partCount(parseInt(size, 10));
  ensureStagingDir(userId, fileId);
  const dest = stagingPath(userId, fileId);
  if (!fs.existsSync(dest)) {
    const fd = fs.openSync(dest, 'w');
    try {
      if (parseInt(size, 10) > 0) {
        try { fs.truncateSync(fd, parseInt(size, 10)); } catch {}
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  const jobId = existingTaskId || uuidv4();
  const tasks = require('./tasks');
  const existing = existingTaskId ? tasks.get(existingTaskId, userId) : null;
  const received = loadReceivedParts(existing);
  const partsDone = received.size;

  if (existing) {
    tasks.update(jobId, userId, {
      status: 'processing',
      phase: partsDone >= totalParts ? 'processing' : 'receiving',
      error: null,
      title: fileName,
      fileId,
      uploadMode: 'seamless',
      seamlessPartSize: SEAMLESS_PART_SIZE,
      seamlessPartsTotal: totalParts,
      seamlessPartsDone: partsDone,
      seamlessPartsReceived: [...received],
      chunksTotal: session.totalChunks,
      chunksDone: session.chunksDone,
      percent: partsDone >= totalParts
        ? MAX_RECEIVE_PERCENT
        : Math.round((partsDone / totalParts) * MAX_RECEIVE_PERCENT),
      fileSize: parseInt(size, 10),
      mimeType: mimeType || 'application/octet-stream',
      parentPath: parentPath || '/',
      chunkSize: session.chunkSize,
      convertHls: !!convertHls,
      resumable: true,
    });
  } else {
    tasks.create(userId, {
      id: jobId,
      type: 'upload',
      title: fileName,
      payload: {
        fileName,
        resumable: true,
        fileId,
        uploadMode: 'seamless',
        seamlessPartSize: SEAMLESS_PART_SIZE,
        seamlessPartsTotal: totalParts,
        seamlessPartsDone: partsDone,
        seamlessPartsReceived: [...received],
        chunksTotal: session.totalChunks,
        chunksDone: session.chunksDone,
        fileSize: parseInt(size, 10),
        mimeType: mimeType || 'application/octet-stream',
        parentPath: parentPath || '/',
        chunkSize: session.chunkSize,
        convertHls: !!convertHls,
      },
    });
    tasks.update(jobId, userId, {
      status: 'processing',
      phase: 'receiving',
      percent: 0,
    });
  }

  tasks.appendLog(jobId, userId, `Seamless upload started — ${totalParts} part(s) to server cache`);

  return {
    ...session,
    jobId,
    uploadMode: 'seamless',
    partSize: SEAMLESS_PART_SIZE,
    totalParts,
    partsDone,
    nextPart: findNextPart(received, totalParts),
    percent: partsDone >= totalParts
      ? MAX_RECEIVE_PERCENT
      : Math.round((partsDone / totalParts) * MAX_RECEIVE_PERCENT),
  };
}

function findNextPart(received, totalParts) {
  for (let i = 0; i < totalParts; i++) {
    if (!received.has(i)) return i;
  }
  return totalParts;
}

async function writeSeamlessPart(userId, fileId, partIndex, buffer, taskId) {
  const file = db.prepare(
    "SELECT * FROM files WHERE id = ? AND user_id = ? AND upload_status IN ('uploading', 'failed')"
  ).get(fileId, userId);
  if (!file) throw new Error('Upload session not found');

  const idx = parseInt(partIndex, 10);
  const totalParts = partCount(file.size);
  if (!Number.isFinite(idx) || idx < 0 || idx >= totalParts) {
    throw new Error('Invalid part index');
  }

  const tasks = require('./tasks');
  let received = new Set();
  if (taskId) {
    const task = tasks.get(taskId, userId);
    received = loadReceivedParts(task);
    if (received.has(idx)) {
      return {
        skipped: true,
        partIndex: idx,
        partsDone: received.size,
        totalParts,
        nextPart: findNextPart(received, totalParts),
        percent: Math.round((received.size / totalParts) * MAX_RECEIVE_PERCENT),
      };
    }
  }

  const dest = stagingPath(userId, fileId);
  if (!fs.existsSync(dest)) throw new Error('Seamless staging file missing — restart upload');

  const offset = idx * SEAMLESS_PART_SIZE;
  const fd = fs.openSync(dest, 'r+');
  try {
    fs.writeSync(fd, buffer, 0, buffer.length, offset);
  } finally {
    fs.closeSync(fd);
  }

  if (taskId) {
    const task = tasks.get(taskId, userId);
    received = loadReceivedParts(task);
    received.add(idx);
    saveReceivedParts(taskId, userId, received);
    const partsDone = received.size;
    tasks.update(taskId, userId, {
      status: 'processing',
      phase: partsDone >= totalParts ? 'processing' : 'receiving',
      seamlessPartsDone: partsDone,
      seamlessPartsTotal: totalParts,
      percent: partsDone >= totalParts
        ? MAX_RECEIVE_PERCENT
        : Math.round((partsDone / totalParts) * MAX_RECEIVE_PERCENT),
      lastLog: `Received part ${idx + 1}/${totalParts} on server cache`,
    });
    tasks.appendLog(taskId, userId, `Cached part ${idx + 1}/${totalParts} (${(buffer.length / 1024 / 1024).toFixed(1)} MB)`);
  }

  return {
    skipped: false,
    partIndex: idx,
    partsDone: received.size,
    totalParts,
    nextPart: findNextPart(received, totalParts),
    percent: taskId
      ? Math.round((received.size / totalParts) * MAX_RECEIVE_PERCENT)
      : 0,
  };
}

function verifyStagingComplete(userId, fileId, file, task) {
  const dest = stagingPath(userId, fileId);
  if (!fs.existsSync(dest)) throw new Error('Seamless staging file missing');
  const stat = fs.statSync(dest);
  if (stat.size < file.size) {
    throw new Error(`File incomplete on server cache (${stat.size}/${file.size} bytes)`);
  }
  const totalParts = partCount(file.size);
  if (task) {
    const received = loadReceivedParts(task);
    if (received.size < totalParts) {
      throw new Error(`Server cache incomplete (${received.size}/${totalParts} parts received)`);
    }
  }
}

function readPreviewBuffer(staging, file) {
  const limit = thumbnails.previewByteLimit(file.mime_type, file.name, file.size);
  if (!limit || !fs.existsSync(staging)) return null;
  const len = Math.min(limit, file.size, fs.statSync(staging).size);
  if (len <= 0) return null;
  return readStagingRange(staging, 0, len);
}

async function uploadChunksFromStaging(userId, fileId, file, staging, encryptChunkSize, taskId) {
  const { createAdaptivePool, mapAdaptive } = require('./adaptive-concurrency');
  const total = file.chunk_count;
  const uploaded = new Set(storage.getUploadedChunkIndices(fileId));
  const pending = [];
  for (let i = 0; i < total; i++) {
    if (!uploaded.has(i)) pending.push(i);
  }
  if (!pending.length) return { chunksDone: total, totalChunks: total };

  const tasks = require('./tasks');
  const pool = createAdaptivePool(pending.length, { max: 32, initial: 24 });

  await mapAdaptive(pending, pool, async (chunkIndex) => {
    const start = chunkIndex * encryptChunkSize;
    const len = Math.min(encryptChunkSize, file.size - start);
    const buffer = readStagingRange(staging, start, len);

    let attempt = 0;
    while (attempt < RETRY_MAX) {
      try {
        await storage.uploadPlainChunk(
          userId,
          fileId,
          chunkIndex,
          buffer,
          'api',
          taskId ? { taskId, userId } : null
        );
        break;
      } catch (err) {
        attempt += 1;
        if (!isTransientError(err) || attempt >= RETRY_MAX) throw err;
        const wait = RETRY_BASE_MS * Math.min(attempt, 6);
        if (taskId) {
          tasks.appendLog(taskId, userId, `Chunk ${chunkIndex} retry ${attempt}/${RETRY_MAX}: ${err.message}`);
        }
        await sleep(wait);
      }
    }

    const chunksDone = storage.getUploadedChunkCount(fileId);
    const pct = MAX_RECEIVE_PERCENT + Math.round((chunksDone / total) * (MAX_PROCESS_PERCENT - MAX_RECEIVE_PERCENT));
    if (taskId) {
      tasks.update(taskId, userId, {
        phase: 'upload',
        chunksDone,
        chunksTotal: total,
        percent: pct,
        lastLog: `Encrypted & uploaded chunk ${chunksDone}/${total} from server cache`,
      });
    }
  });

  return {
    chunksDone: storage.getUploadedChunkCount(fileId),
    totalChunks: total,
  };
}

async function runPipelineOnce(userId, fileId, taskId, { convertHls }) {
  const tasks = require('./tasks');
  const file = db.prepare(
    "SELECT * FROM files WHERE id = ? AND user_id = ? AND upload_status IN ('uploading', 'failed')"
  ).get(fileId, userId);
  if (!file) throw new Error('Upload session not found');

  const staging = stagingPath(userId, fileId);
  const task = taskId ? tasks.get(taskId, userId) : null;
  verifyStagingComplete(userId, fileId, file, task);

  const encryptChunkSize = storage.getChunkSizeForFile(fileId, file);
  tasks.update(taskId, userId, {
    status: 'processing',
    phase: 'upload',
    percent: MAX_RECEIVE_PERCENT,
    lastLog: 'Processing from server cache — encrypting and uploading to GitHub...',
  });
  tasks.appendLog(taskId, userId, 'Server took over — uploading encrypted chunks with auto-retry');

  await uploadChunksFromStaging(userId, fileId, file, staging, encryptChunkSize, taskId);

  const chunksDone = storage.getUploadedChunkCount(fileId);
  if (chunksDone < file.chunk_count) {
    throw new Error(`Upload incomplete: ${chunksDone}/${file.chunk_count} chunks after processing`);
  }

  const preview = readPreviewBuffer(staging, file);
  const onProgress = (patch) => {
    const pct = typeof patch.percent === 'number'
      ? Math.max(MAX_PROCESS_PERCENT, Math.min(99, patch.percent))
      : undefined;
    tasks.update(taskId, userId, { ...patch, percent: pct ?? undefined });
    if (patch.lastLog) tasks.appendLog(taskId, userId, patch.lastLog);
  };

  const result = await storage.finalizeUpload(
    userId,
    fileId,
    preview,
    onProgress,
    'api',
    { taskId, userId }
  );

  if (convertHls) {
    const hlsConvert = require('./hls-convert');
    const ffmpegOk = await hlsConvert.isFfmpegAvailable();
    if (!ffmpegOk) {
      tasks.appendLog(taskId, userId, 'HLS skipped — FFmpeg not available on server');
    } else {
      const hlsTaskId = uuidv4();
      tasks.create(userId, {
        id: hlsTaskId,
        type: 'hls-convert',
        title: `Converting ${file.name} to HLS...`,
        payload: { fileId, fileName: file.name, resumable: false, seamlessSource: true },
      });
      tasks.update(taskId, userId, { hlsTaskId, phase: 'hls-convert' });
      tasks.appendLog(taskId, userId, 'Starting HLS conversion from server cache...');

      await hlsConvert.convertFile(userId, fileId, (p) => {
        tasks.update(hlsTaskId, userId, { ...p, status: 'processing' });
        if (p.lastLog) tasks.appendLog(hlsTaskId, userId, p.lastLog);
      }, hlsTaskId, { localSourcePath: staging });

      tasks.update(hlsTaskId, userId, { status: 'done', percent: 100, phase: 'done' });
      tasks.appendLog(taskId, userId, 'HLS conversion complete');
    }
  }

  cleanupStaging(userId, fileId);
  tasks.update(taskId, userId, {
    status: 'done',
    phase: 'done',
    percent: 100,
    resumable: false,
    lastLog: 'Seamless upload complete',
  });

  return result;
}

async function processPipeline(userId, fileId, taskId, options = {}) {
  const key = `${userId}:${fileId}`;
  if (processing.has(key)) return null;
  processing.add(key);

  const tasks = require('./tasks');
  let attempt = 0;

  try {
    while (attempt < RETRY_MAX) {
      try {
        return await runPipelineOnce(userId, fileId, taskId, options);
      } catch (err) {
        attempt += 1;
        if (!isTransientError(err) || attempt >= RETRY_MAX) {
          tasks.update(taskId, userId, {
            status: 'error',
            error: err.message,
            resumable: true,
            lastLog: err.message,
          });
          tasks.appendLog(taskId, userId, `Seamless pipeline failed: ${err.message}`);
          throw err;
        }
        const wait = RETRY_BASE_MS * Math.min(attempt, 8);
        tasks.appendLog(taskId, userId, `Auto-retry ${attempt}/${RETRY_MAX} in ${Math.round(wait / 1000)}s: ${err.message}`);
        tasks.update(taskId, userId, {
          status: 'processing',
          phase: 'upload',
          error: null,
          pauseReason: `Retrying in ${Math.round(wait / 1000)}s...`,
        });
        await sleep(wait);
      }
    }
  } finally {
    processing.delete(key);
  }
  return null;
}

async function completeSeamlessReceive(userId, fileId, taskId, options = {}) {
  const file = db.prepare(
    "SELECT * FROM files WHERE id = ? AND user_id = ? AND upload_status IN ('uploading', 'failed')"
  ).get(fileId, userId);
  if (!file) throw new Error('Upload session not found');

  const tasks = require('./tasks');
  const task = taskId ? tasks.get(taskId, userId) : null;
  verifyStagingComplete(userId, fileId, file, task);

  if (task?.status === 'done') {
    return { success: true, done: true, fileId, taskId };
  }

  const key = `${userId}:${fileId}`;
  if (processing.has(key)) {
    return { success: true, processing: true, fileId, taskId, alreadyRunning: true };
  }

  const convertHls = options.convertHls ?? !!task?.convertHls;

  tasks.update(taskId, userId, {
    status: 'processing',
    phase: 'processing',
    percent: MAX_RECEIVE_PERCENT,
    seamlessPartsDone: task?.seamlessPartsTotal || partCount(file.size),
    lastLog: 'File cached on server — starting automatic processing',
  });
  tasks.appendLog(taskId, userId, 'Client upload complete; server is processing automatically');

  setImmediate(() => {
    processPipeline(userId, fileId, taskId, { convertHls }).catch((err) => {
      console.error(`[Seamless] Pipeline failed for ${fileId}:`, err.message);
    });
  });

  return { success: true, processing: true, fileId, taskId };
}

function getSeamlessStatus(userId, fileId) {
  const file = db.prepare(
    "SELECT * FROM files WHERE id = ? AND user_id = ? AND upload_status IN ('uploading', 'failed')"
  ).get(fileId, userId);
  if (!file) return null;

  const dest = stagingPath(userId, fileId);
  const stat = fs.existsSync(dest) ? fs.statSync(dest) : null;
  const totalParts = partCount(file.size);
  const chunksDone = storage.getUploadedChunkCount(fileId);
  const tasks = require('./tasks');

  let received = new Set();
  let taskId = null;
  const taskRow = db.prepare(`
    SELECT id, payload FROM tasks
    WHERE user_id = ? AND type = 'upload' AND payload LIKE ?
    ORDER BY created_at DESC LIMIT 1
  `).get(userId, `%"fileId":"${fileId}"%`);
  if (taskRow) {
    taskId = taskRow.id;
    const live = tasks.get(taskRow.id, userId);
    if (live) {
      received = loadReceivedParts(live);
    } else {
      let payload = {};
      try { payload = JSON.parse(taskRow.payload || '{}'); } catch {}
      received = loadReceivedParts({ seamlessPartsReceived: payload.seamlessPartsReceived });
    }
  }

  const missingParts = [];
  for (let i = 0; i < totalParts; i++) {
    if (!received.has(i)) missingParts.push(i);
  }

  return {
    fileId,
    fileName: file.name,
    fileSize: file.size,
    taskId,
    stagingBytes: stat?.size || 0,
    stagingComplete: received.size >= totalParts,
    totalParts,
    partSize: SEAMLESS_PART_SIZE,
    partsDone: received.size,
    missingParts,
    nextPart: findNextPart(received, totalParts),
    totalChunks: file.chunk_count,
    chunksDone,
    nextChunk: (() => {
      const indices = storage.getUploadedChunkIndices(fileId);
      const set = new Set(indices);
      for (let i = 0; i < file.chunk_count; i++) {
        if (!set.has(i)) return i;
      }
      return file.chunk_count;
    })(),
  };
}

function resumePendingOnStartup() {
  if (!fs.existsSync(SEAMLESS_DIR)) return 0;
  let resumed = 0;
  const tasks = require('./tasks');

  const rows = db.prepare(`
    SELECT id, user_id, name, size, upload_status FROM files
    WHERE upload_status IN ('uploading', 'failed')
  `).all();

  for (const file of rows) {
    const staging = stagingPath(file.user_id, file.id);
    if (!fs.existsSync(staging)) continue;
    const stat = fs.statSync(staging);
    if (stat.size < file.size) continue;

    const taskRow = db.prepare(`
      SELECT id, payload FROM tasks
      WHERE user_id = ? AND type = 'upload' AND status IN ('processing', 'error', 'paused')
        AND payload LIKE ?
      ORDER BY created_at DESC LIMIT 1
    `).get(file.user_id, `%"fileId":"${file.id}"%`);

    if (!taskRow) continue;
    let payload = {};
    try { payload = JSON.parse(taskRow.payload || '{}'); } catch {}
    if (payload.uploadMode !== 'seamless') continue;

    const live = tasks.get(taskRow.id, file.user_id);
    const received = loadReceivedParts(live || { seamlessPartsReceived: payload.seamlessPartsReceived });
    if (received.size < partCount(file.size)) continue;

    const chunksDone = storage.getUploadedChunkCount(file.id);
    if (chunksDone >= file.chunk_count && file.upload_status === 'ready') continue;

    tasks.update(taskRow.id, file.user_id, {
      status: 'processing',
      phase: 'processing',
      error: null,
      resumable: true,
      lastLog: 'Resuming seamless processing after server restart',
    });
    tasks.appendLog(taskRow.id, file.user_id, 'Auto-resuming seamless pipeline from server cache');

    setImmediate(() => {
      processPipeline(file.user_id, file.id, taskRow.id, {
        convertHls: !!payload.convertHls,
      }).catch((err) => {
        console.error(`[Seamless] Resume failed for ${file.id}:`, err.message);
      });
    });
    resumed += 1;
  }
  if (resumed > 0) console.log(`[Seamless] Resumed ${resumed} upload(s) from server cache`);
  return resumed;
}

module.exports = {
  SEAMLESS_PART_SIZE,
  stagingPath,
  getStagingPathIfExists,
  cleanupStaging,
  initSeamlessUpload,
  writeSeamlessPart,
  completeSeamlessReceive,
  processPipeline,
  getSeamlessStatus,
  resumePendingOnStartup,
  partCount,
  findNextPart,
};
