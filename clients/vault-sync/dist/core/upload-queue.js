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
const logger_1 = require("../services/logger");
const POLL_INTERVAL_MS = 1000;
const MAX_PART_RETRIES = 12;
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
        await uploadEntrySeamless(entry, settings);
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
function computeChunkSize(fileSize) {
    if (fileSize < 50 * 1024 * 1024)
        return 1024 * 1024;
    if (fileSize < 500 * 1024 * 1024)
        return 2 * 1024 * 1024;
    if (fileSize < 2 * 1024 * 1024 * 1024)
        return 5 * 1024 * 1024;
    return 10 * 1024 * 1024;
}
function guessMimeType(fileName) {
    const ext = path_1.default.extname(fileName).toLowerCase();
    const map = {
        '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
        '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.m4v': 'video/x-m4v',
        '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav',
        '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
        '.json': 'application/json', '.txt': 'text/plain', '.zip': 'application/zip',
    };
    return map[ext] || 'application/octet-stream';
}
function parentPathFromRel(localRelPath) {
    const normalized = localRelPath.replace(/\\/g, '/');
    const idx = normalized.lastIndexOf('/');
    if (idx < 0)
        return '/';
    return '/' + normalized.slice(0, idx);
}
async function ensureFolderOnServer(api, parentPath) {
    if (parentPath === '/' || !parentPath)
        return;
    const segments = parentPath.replace(/^\//, '').split('/').filter(Boolean);
    let current = '/';
    for (const seg of segments) {
        const result = await api.createFolder(seg, current);
        if (!result.ok) {
            const msg = result.error.message || `HTTP ${result.error.status}`;
            if (msg.includes('already exists')) {
                logger_1.logger.info('upload-queue', `Folder exists: ${current === '/' ? '/' + seg : current + '/' + seg}`);
            }
            else {
                logger_1.logger.warn('upload-queue', `Folder create "${seg}" in "${current}" failed: ${msg}`);
            }
        }
        else {
            logger_1.logger.info('upload-queue', `Created folder: ${current === '/' ? '/' + seg : current + '/' + seg}`);
        }
        current = current === '/' ? '/' + seg : current + '/' + seg;
    }
}
async function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function uploadEntrySeamless(entry, settings) {
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
    const fileName = path_1.default.basename(entry.localRelPath);
    const parentPath = parentPathFromRel(entry.localRelPath);
    const mimeType = entry.mimeType || guessMimeType(fileName);
    const chunkSize = computeChunkSize(stat.size);
    if (parentPath && parentPath !== '/') {
        await ensureFolderOnServer(api, parentPath);
    }
    queueRepo.updateQueueEntry(entry.id, { status: 'uploading', startedAt: new Date().toISOString() });
    emitProgress(entry.id, entry.localRelPath, 'uploading', 0);
    const initResult = await api.seamlessInit({
        fileName,
        parentPath,
        size: stat.size,
        mimeType,
        chunkSize,
        fileId: entry.fileId || undefined,
        taskId: entry.taskId || undefined,
    });
    if (!initResult.ok) {
        throw new Error(`Seamless init failed: ${initResult.error.message}`);
    }
    const { fileId, jobId, totalParts, partSize } = initResult.value;
    queueRepo.updateQueueEntry(entry.id, { fileId, taskId: jobId });
    logger_1.logger.info('upload-queue', `Seamless upload started: ${entry.localRelPath} — ${totalParts} parts`);
    let statusResult = await api.seamlessStatus(fileId);
    let nextPart = 0;
    if (statusResult.ok && statusResult.value.stagingComplete) {
        logger_1.logger.info('upload-queue', `Server cache already complete for ${entry.localRelPath}, resuming processing`);
        await api.resumeTask(jobId).catch(() => { });
        await api.seamlessResume(fileId, jobId);
        return waitForServerProcessing(entry, api, jobId, fileName, stat);
    }
    else if (statusResult.ok && statusResult.value.nextPart) {
        nextPart = statusResult.value.nextPart;
    }
    let uploadedBytes = 0;
    let partsDone = nextPart;
    const startTime = Date.now();
    for (let partIndex = nextPart; partIndex < totalParts; partIndex++) {
        const start = partIndex * partSize;
        const length = Math.min(partSize, stat.size - start);
        const buffer = Buffer.alloc(length);
        const fd = await fs_1.default.promises.open(absPath, 'r');
        try {
            await fd.read(buffer, 0, length, start);
        }
        finally {
            await fd.close();
        }
        let lastErr;
        let success = false;
        for (let attempt = 1; attempt <= MAX_PART_RETRIES; attempt++) {
            try {
                const partResult = await api.seamlessPart(fileId, partIndex, buffer, jobId);
                if (!partResult.ok) {
                    if (partResult.error.status === 409) {
                        throw new Error('Upload paused on server');
                    }
                    lastErr = new Error(partResult.error.message);
                }
                else {
                    uploadedBytes += buffer.length;
                    partsDone = Math.max(partsDone, partResult.value.partsDone || partIndex + 1);
                    const elapsed = (Date.now() - startTime) / 1000;
                    const speed = elapsed > 0 ? uploadedBytes / elapsed : 0;
                    const pct = Math.round((partsDone / totalParts) * 35);
                    emitProgress(entry.id, entry.localRelPath, 'uploading', pct);
                    success = true;
                    break;
                }
            }
            catch (e) {
                lastErr = e;
                if (e instanceof Error && e.message.includes('paused'))
                    throw e;
            }
            await sleep(Math.min(2000 * attempt, 15000));
        }
        if (!success) {
            throw lastErr instanceof Error ? lastErr : new Error(`Part ${partIndex} upload failed`);
        }
    }
    const completeResult = await api.seamlessComplete(fileId, jobId);
    if (!completeResult.ok) {
        throw new Error(`Seamless complete failed: ${completeResult.error.message}`);
    }
    logger_1.logger.info('upload-queue', `All parts cached for ${entry.localRelPath}, waiting for server processing`);
    return waitForServerProcessing(entry, api, jobId, fileName, stat);
}
async function waitForServerProcessing(entry, api, jobId, fileName, stat) {
    for (;;) {
        await sleep(POLL_INTERVAL_MS);
        const taskResult = await api.getTask(jobId);
        if (!taskResult.ok)
            continue;
        const task = taskResult.value;
        const pct = task.percent || 0;
        emitProgress(entry.id, entry.localRelPath, 'uploading', pct);
        if (task.status === 'done') {
            finalizeSuccess(entry, fileName, stat, task.fileId || null);
            return;
        }
        if (task.status === 'error') {
            throw new Error(task.error || 'Server processing failed');
        }
        if (task.status === 'cancelled') {
            throw new Error('Upload cancelled on server');
        }
    }
}
function finalizeSuccess(entry, fileName, stat, remoteFileId) {
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
        localHash: null,
        remoteHash: null,
        remoteUpdatedAt: new Date().toISOString(),
        syncStatus: 'synced',
        syncTaskId: null,
        syncError: null,
    });
    emitProgress(entry.id, entry.localRelPath, 'done', 100);
    logger_1.logger.info('upload-queue', `Upload complete: ${entry.localRelPath}`);
}
function emitProgress(id, localRelPath, status, percent) {
    if (onProgress)
        onProgress({ id, localRelPath, status, percent });
}
//# sourceMappingURL=upload-queue.js.map