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
    }
    finally {
        processing = false;
    }
}
async function uploadEntry(entry, settings) {
    const absPath = path_1.default.join(settings.syncRootPath, entry.localRelPath);
    const api = new api_client_1.VaultApiClient({ serverUrl: settings.serverUrl, apiKey: settings.apiKey });
    queueRepo.updateQueueEntry(entry.id, { status: 'hashing', startedAt: new Date().toISOString() });
    emitProgress(entry.id, entry.localRelPath, 'hashing', 0);
    const hash = await (0, hasher_1.computeFileHash)(absPath).catch(() => null);
    if (!hash || hash !== entry.localHash) {
        const retry = entry.retryCount + 1;
        if (retry > entry.maxRetries) {
            queueRepo.updateQueueEntry(entry.id, { status: 'error', error: 'Hash mismatch after max retries', retryCount: retry });
            fileTreeRepo.upsertFile((0, database_1.getDatabase)(), {
                fileId: entry.fileId,
                localRelPath: entry.localRelPath,
                remotePath: null,
                name: path_1.default.basename(entry.localRelPath),
                size: entry.size,
                mimeType: entry.mimeType,
                isFolder: false,
                localMtimeMs: null,
                localHash: entry.localHash,
                remoteHash: null,
                remoteUpdatedAt: null,
                syncStatus: 'error',
                syncTaskId: null,
                syncError: 'Hash mismatch',
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
    const planResult = await api.listFiles('/', 1, 0);
    queueRepo.updateQueueEntry(entry.id, { status: 'done', percent: 100, completedAt: new Date().toISOString() });
    fileTreeRepo.upsertFile((0, database_1.getDatabase)(), {
        fileId: entry.fileId,
        localRelPath: entry.localRelPath,
        remotePath: entry.localRelPath ? `/${entry.localRelPath.replace(/\\/g, '/')}` : null,
        name: path_1.default.basename(entry.localRelPath),
        size: entry.size,
        mimeType: entry.mimeType,
        isFolder: false,
        localMtimeMs: fs_1.default.statSync(absPath).mtimeMs,
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
function emitProgress(id, localRelPath, status, percent) {
    if (onProgress)
        onProgress({ id, localRelPath, status, percent });
}
//# sourceMappingURL=upload-queue.js.map