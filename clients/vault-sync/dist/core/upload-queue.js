"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.setProgressHandler = setProgressHandler;
exports.startProcessing = startProcessing;
exports.stopProcessing = stopProcessing;
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const database_1 = require("../db/database");
const queueRepo = __importStar(require("../db/queue-repo"));
const fileTreeRepo = __importStar(require("../db/file-tree-repo"));
const settings_repo_1 = require("../db/settings-repo");
const api_client_1 = require("./api-client");
const hasher_1 = require("../services/hasher");
const logger_1 = require("../services/logger");
const CHUNK_SIZE = 1024 * 1024;
const MAX_FILE_SIZE_SIMPLE = 50 * 1024 * 1024;
let processing = false;
let processingTimer = null;
let onProgress = null;
function setProgressHandler(handler) {
    onProgress = handler;
}
function startProcessing(intervalMs = 5000) {
    stopProcessing();
    processingTimer = setInterval(() => {
        if (!processing)
            processNext();
    }, intervalMs);
    processNext();
    logger_1.logger.info('upload-queue', 'Queue processor started');
}
function stopProcessing() {
    if (processingTimer) {
        clearInterval(processingTimer);
        processingTimer = null;
    }
    processing = false;
    logger_1.logger.info('upload-queue', 'Queue processor stopped');
}
async function processNext() {
    if (processing)
        return;
    const settings = (0, settings_repo_1.getSettings)();
    if (!settings.serverUrl || !settings.apiKey)
        return;
    const active = queueRepo.getActiveCount();
    if (active >= settings.uploadConcurrency)
        return;
    const pending = queueRepo.getPendingEntries(1);
    if (!pending.length)
        return;
    processing = true;
    const entry = pending[0];
    try {
        await uploadEntry(entry, settings);
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger_1.logger.error('upload-queue', `Upload failed for ${entry.localRelPath}: ${msg}`);
        queueRepo.updateQueueEntry(entry.id, { status: 'pending', error: msg, retryCount: entry.retryCount + 1 });
        emitProgress(entry.id, entry.localRelPath, 'pending', 0);
    }
    finally {
        processing = false;
        setTimeout(() => processNext(), 1000);
    }
}
async function uploadEntry(entry, settings) {
    const absPath = path_1.default.join(settings.syncRootPath, entry.localRelPath);
    if (!fs_1.default.existsSync(absPath)) {
        queueRepo.updateQueueEntry(entry.id, { status: 'error', error: 'File no longer exists' });
        return;
    }
    const stat = fs_1.default.statSync(absPath);
    if (stat.size !== entry.size) {
        queueRepo.updateQueueEntry(entry.id, { status: 'pending', error: 'File size changed, will re-queue' });
        return;
    }
    const api = new api_client_1.VaultApiClient({ serverUrl: settings.serverUrl, apiKey: settings.apiKey });
    queueRepo.updateQueueEntry(entry.id, { status: 'hashing', startedAt: new Date().toISOString() });
    emitProgress(entry.id, entry.localRelPath, 'hashing', 0);
    const hash = await (0, hasher_1.computeFileHash)(absPath).catch(() => null);
    if (!hash || hash !== entry.localHash) {
        const retry = entry.retryCount + 1;
        if (retry > entry.maxRetries) {
            queueRepo.updateQueueEntry(entry.id, { status: 'error', error: 'Hash mismatch', retryCount: retry });
            fileTreeRepo.upsertFile((0, database_1.getDatabase)(), {
                fileId: null, localRelPath: entry.localRelPath, remotePath: null,
                name: path_1.default.basename(entry.localRelPath), size: entry.size, mimeType: entry.mimeType || null,
                isFolder: false, localMtimeMs: stat.mtimeMs, localHash: hash,
                remoteHash: null, remoteUpdatedAt: null, syncStatus: 'error', syncTaskId: null, syncError: 'Hash mismatch',
            });
            emitProgress(entry.id, entry.localRelPath, 'error', 0);
            return;
        }
        queueRepo.updateQueueEntry(entry.id, { status: 'pending', retryCount: retry, error: 'Hash mismatch, will retry' });
        emitProgress(entry.id, entry.localRelPath, 'pending', 0);
        return;
    }
    queueRepo.updateQueueEntry(entry.id, { status: 'uploading' });
    emitProgress(entry.id, entry.localRelPath, 'uploading', 0);
    const fileName = path_1.default.basename(entry.localRelPath);
    if (stat.size <= MAX_FILE_SIZE_SIMPLE) {
        await uploadSimple(entry, api, absPath, fileName, hash, stat);
    }
    else {
        await uploadChunked(entry, api, absPath, fileName, hash, stat);
    }
}
async function uploadSimple(entry, api, absPath, fileName, hash, stat) {
    const buf = fs_1.default.readFileSync(absPath);
    const result = await api.uploadFile(buf, fileName, '/', CHUNK_SIZE);
    if (!result.ok) {
        throw new Error(`Upload failed: ${result.error.message}`);
    }
    const jobId = result.value.jobId;
    for (let i = 0; i < 60; i++) {
        await sleep(2000);
        const progress = await api.getUploadProgress(jobId);
        if (!progress.ok)
            continue;
        const p = progress.value;
        emitProgress(entry.id, entry.localRelPath, 'uploading', p.percent || 0);
        if (p.status === 'done') {
            finalizeSuccess(entry, fileName, hash, stat, null);
            return;
        }
        if (p.status === 'error') {
            throw new Error(p.error || 'Upload failed on server');
        }
    }
    throw new Error('Upload timed out waiting for server completion');
}
async function uploadChunked(entry, api, absPath, fileName, hash, stat) {
    const mimeType = entry.mimeType || guessMime(fileName);
    const initResult = await api.uploadInit(fileName, '/', stat.size, mimeType);
    if (!initResult.ok) {
        throw new Error(`Upload init failed: ${initResult.error.message}`);
    }
    const { fileId, jobId, totalChunks, chunkSize } = initResult.value;
    queueRepo.updateQueueEntry(entry.id, { fileId, taskId: jobId });
    const fileHandle = await fs_1.default.promises.open(absPath, 'r');
    let lastPercent = 0;
    try {
        for (let i = 0; i < totalChunks; i++) {
            const offset = i * chunkSize;
            const size = Math.min(chunkSize, stat.size - offset);
            const chunkBuf = Buffer.alloc(size);
            await fileHandle.read(chunkBuf, 0, size, offset);
            const chunkResult = await api.uploadChunk(fileId, i, chunkBuf, jobId);
            if (!chunkResult.ok) {
                throw new Error(`Chunk ${i} upload failed: ${chunkResult.error.message}`);
            }
            const pct = Math.round((chunkResult.value.chunksDone / chunkResult.value.totalChunks) * 100);
            if (pct !== lastPercent) {
                lastPercent = pct;
                emitProgress(entry.id, entry.localRelPath, 'uploading', pct);
            }
        }
    }
    finally {
        await fileHandle.close();
    }
    const completeResult = await api.uploadComplete(fileId, jobId);
    if (!completeResult.ok) {
        throw new Error(`Upload complete failed: ${completeResult.error.message}`);
    }
    finalizeSuccess(entry, fileName, hash, stat, completeResult.value.id);
}
function finalizeSuccess(entry, fileName, hash, stat, remoteFileId) {
    const remotePath = '/' + entry.localRelPath.replace(/\\/g, '/');
    queueRepo.updateQueueEntry(entry.id, { status: 'done', percent: 100, completedAt: new Date().toISOString() });
    fileTreeRepo.upsertFile((0, database_1.getDatabase)(), {
        fileId: remoteFileId,
        localRelPath: entry.localRelPath,
        remotePath,
        name: fileName,
        size: stat.size,
        mimeType: null,
        isFolder: false,
        localMtimeMs: stat.mtimeMs,
        localHash: hash,
        remoteHash: hash,
        remoteUpdatedAt: new Date().toISOString(),
        syncStatus: 'synced',
        syncTaskId: null,
        syncError: null,
    });
    emitProgress(entry.id, entry.localRelPath, 'done', 100);
    logger_1.logger.info('upload-queue', `Upload complete: ${entry.localRelPath}`);
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function guessMime(fileName) {
    const ext = path_1.default.extname(fileName).toLowerCase();
    const map = {
        '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.mkv': 'video/x-matroska',
        '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.mov': 'video/quicktime',
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.pdf': 'application/pdf', '.zip': 'application/zip',
        '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
        '.m4a': 'audio/mp4', '.aac': 'audio/aac',
    };
    return map[ext] || 'application/octet-stream';
}
function emitProgress(id, localRelPath, status, percent) {
    if (onProgress)
        onProgress({ id, localRelPath, status, percent });
}
//# sourceMappingURL=upload-queue.js.map