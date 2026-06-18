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
exports.getSyncState = getSyncState;
exports.onSyncStateChange = onSyncStateChange;
exports.startSyncLoop = startSyncLoop;
exports.stopSyncLoop = stopSyncLoop;
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const database_1 = require("../db/database");
const fileTreeRepo = __importStar(require("../db/file-tree-repo"));
const queueRepo = __importStar(require("../db/queue-repo"));
const settings_repo_1 = require("../db/settings-repo");
const api_client_1 = require("./api-client");
const hasher_1 = require("../services/hasher");
const logger_1 = require("../services/logger");
let running = false;
let syncTimer = null;
let currentState = { status: 'idle', lastSyncAt: null, lastError: null, pendingUploads: 0, pendingDownloads: 0, conflictCount: 0, totalFiles: 0 };
let onStateChange = null;
function getSyncState() {
    return { ...currentState };
}
function onSyncStateChange(cb) {
    onStateChange = cb;
}
function emitState(partial) {
    currentState = { ...currentState, ...partial };
    if (onStateChange)
        onStateChange(currentState);
}
async function startSyncLoop() {
    const settings = (0, settings_repo_1.getSettings)();
    if (!settings.syncEnabled || !settings.serverUrl || !settings.apiKey) {
        logger_1.logger.warn('sync', 'Sync not started — missing config');
        return;
    }
    running = true;
    logger_1.logger.info('sync', 'Sync loop started');
    await runSyncCycle();
    syncTimer = setInterval(async () => {
        if (!running)
            return;
        await runSyncCycle();
    }, settings.syncIntervalSeconds * 1000);
}
function stopSyncLoop() {
    running = false;
    if (syncTimer) {
        clearInterval(syncTimer);
        syncTimer = null;
    }
    emitState({ status: 'idle' });
    logger_1.logger.info('sync', 'Sync loop stopped');
}
async function runSyncCycle() {
    const settings = (0, settings_repo_1.getSettings)();
    if (!settings.serverUrl || !settings.apiKey) {
        emitState({ status: 'idle', lastError: 'Not authenticated' });
        return;
    }
    emitState({ status: 'syncing' });
    const api = new api_client_1.VaultApiClient({ serverUrl: settings.serverUrl, apiKey: settings.apiKey });
    logger_1.logger.info('sync', 'Starting sync cycle');
    try {
        await syncRemoteMetadata(api, settings.syncRootPath);
        await scanLocalFiles(settings.syncRootPath);
        updateCounts();
        (0, settings_repo_1.updateSettings)({ lastSyncCursor: new Date().toISOString() });
        emitState({ status: 'idle', lastSyncAt: new Date().toISOString(), lastError: null });
        logger_1.logger.info('sync', 'Sync cycle complete');
    }
    catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logger_1.logger.error('sync', `Sync cycle failed: ${msg}`);
        emitState({ status: 'error', lastError: msg });
    }
}
async function syncRemoteMetadata(api, syncRoot) {
    const db = (0, database_1.getDatabase)();
    async function walkFolder(folderPath) {
        const result = await api.listFiles(folderPath, 500, 0);
        if (!result.ok) {
            logger_1.logger.error('sync', `Failed to list ${folderPath}: ${result.error.message}`);
            return;
        }
        for (const file of result.value.files) {
            const isFolder = !!(file.isFolder || file.is_folder);
            const localRel = isFolder
                ? file.path.slice(1) + (file.path === '/' ? '' : '/')
                : file.path.slice(1);
            const normalizedRel = localRel.replace(/\//g, path_1.default.sep);
            const absPath = path_1.default.join(syncRoot, normalizedRel);
            const existing = fileTreeRepo.getFileByRelPath(normalizedRel);
            const syncEntry = {
                fileId: file.id,
                localRelPath: normalizedRel,
                remotePath: file.path,
                name: file.name,
                size: file.size,
                mimeType: file.mimeType,
                isFolder,
                localMtimeMs: existing?.localMtimeMs ?? null,
                localHash: existing?.localHash ?? null,
                remoteHash: file.contentHash,
                remoteUpdatedAt: file.updatedAt,
                syncStatus: existing ? existing.syncStatus : 'remote_only',
                syncTaskId: existing?.syncTaskId ?? null,
                syncError: null,
            };
            fileTreeRepo.upsertFile(db, syncEntry);
            if (!isFolder && !existing) {
                if (!fs_1.default.existsSync(absPath)) {
                    logger_1.logger.info('sync', `New remote file: ${normalizedRel} (needs download)`);
                }
            }
        }
        if (result.value.hasMore && result.value.nextOffset !== undefined) {
            const next = await api.listFiles(folderPath, 500, result.value.nextOffset);
            if (next.ok) {
                for (const file of next.value.files) {
                    const isFolderPg = !!(file.isFolder || file.is_folder);
                    const localRel = file.path.slice(1);
                    const normalizedRel = localRel.replace(/\//g, path_1.default.sep);
                    const existing = fileTreeRepo.getFileByRelPath(normalizedRel);
                    fileTreeRepo.upsertFile(db, {
                        fileId: file.id,
                        localRelPath: normalizedRel,
                        remotePath: file.path,
                        name: file.name,
                        size: file.size,
                        mimeType: file.mimeType,
                        isFolder: isFolderPg,
                        localMtimeMs: existing?.localMtimeMs ?? null,
                        localHash: existing?.localHash ?? null,
                        remoteHash: file.contentHash,
                        remoteUpdatedAt: file.updatedAt,
                        syncStatus: existing ? existing.syncStatus : 'remote_only',
                        syncTaskId: existing?.syncTaskId ?? null,
                        syncError: null,
                    });
                }
            }
        }
        for (const file of result.value.files) {
            const isFolder = !!(file.isFolder || file.is_folder);
            if (isFolder) {
                await walkFolder(file.path);
            }
        }
    }
    await walkFolder('/');
}
async function scanLocalFiles(syncRoot) {
    const db = (0, database_1.getDatabase)();
    const known = new Set(fileTreeRepo.getAllFiles().map((f) => f.localRelPath));
    const seen = new Set();
    function walk(dir, relDir) {
        let entries;
        try {
            entries = fs_1.default.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (entry.name.startsWith('.vault-'))
                continue;
            if (entry.name.startsWith('~$'))
                continue;
            if (entry.name.endsWith('.tmp') || entry.name.endsWith('.part') || entry.name.endsWith('.crdownload'))
                continue;
            const relPath = relDir ? path_1.default.join(relDir, entry.name) : entry.name;
            seen.add(relPath);
            if (entry.isDirectory()) {
                const existing = fileTreeRepo.getFileByRelPath(relPath);
                if (!existing) {
                    fileTreeRepo.upsertFile(db, {
                        fileId: null,
                        localRelPath: relPath,
                        remotePath: null,
                        name: entry.name,
                        size: 0,
                        mimeType: null,
                        isFolder: true,
                        localMtimeMs: null,
                        localHash: null,
                        remoteHash: null,
                        remoteUpdatedAt: null,
                        syncStatus: 'local_only',
                        syncTaskId: null,
                        syncError: null,
                    });
                }
                else {
                    fileTreeRepo.upsertFile(db, { ...existing, isFolder: true });
                }
                walk(path_1.default.join(dir, entry.name), relPath);
            }
            else {
                validateAndQueueFile(dir, entry.name, relPath);
            }
        }
    }
    walk(syncRoot, '');
    for (const filePath of known) {
        if (!seen.has(filePath)) {
            const existing = fileTreeRepo.getFileByRelPath(filePath);
            if (existing && existing.syncStatus === 'synced') {
                logger_1.logger.info('sync', `Local file deleted: ${filePath}`);
                fileTreeRepo.upsertFile(db, { ...existing, syncStatus: 'deleted' });
            }
        }
    }
}
async function validateAndQueueFile(dir, name, relPath) {
    const absPath = path_1.default.join(dir, name);
    const existing = fileTreeRepo.getFileByRelPath(relPath);
    let stat;
    try {
        stat = fs_1.default.statSync(absPath);
    }
    catch {
        return;
    }
    if (!existing || existing.syncStatus === 'local_only') {
        const hash = await (0, hasher_1.computeFileHash)(absPath).catch(() => null);
        if (!hash)
            return;
        const dupEntry = fileTreeRepo.getFileByHash(hash);
        if (dupEntry && dupEntry.fileId && dupEntry.syncStatus === 'synced') {
            logger_1.logger.info('sync', `Duplicate by hash: ${relPath} matches ${dupEntry.localRelPath}`);
            fileTreeRepo.upsertFile((0, database_1.getDatabase)(), {
                fileId: dupEntry.fileId,
                localRelPath: relPath,
                remotePath: dupEntry.remotePath,
                name,
                size: stat.size,
                mimeType: existing?.mimeType ?? null,
                isFolder: false,
                localMtimeMs: stat.mtimeMs,
                localHash: hash,
                remoteHash: dupEntry.remoteHash,
                remoteUpdatedAt: dupEntry.remoteUpdatedAt,
                syncStatus: 'synced',
                syncTaskId: null,
                syncError: null,
            });
            return;
        }
        if (existing?.syncStatus === 'synced' && existing.localHash === hash)
            return;
        logger_1.logger.info('sync', `New/modified file: ${relPath}`);
        fileTreeRepo.upsertFile((0, database_1.getDatabase)(), {
            fileId: existing?.fileId ?? null,
            localRelPath: relPath,
            remotePath: existing?.remotePath ?? null,
            name,
            size: stat.size,
            mimeType: existing?.mimeType ?? null,
            isFolder: false,
            localMtimeMs: stat.mtimeMs,
            localHash: hash,
            remoteHash: existing?.remoteHash ?? null,
            remoteUpdatedAt: existing?.remoteUpdatedAt ?? null,
            syncStatus: 'local_only',
            syncTaskId: null,
            syncError: null,
        });
        queueRepo.addToQueue({
            fileId: existing?.fileId ?? null,
            localRelPath: relPath,
            localHash: hash,
            size: stat.size,
            mimeType: existing?.mimeType ?? null,
            status: 'pending',
            uploadMode: 'seamless',
            percent: 0,
            error: null,
            retryCount: 0,
            maxRetries: 100,
            taskId: null,
            sessionJson: null,
            priority: 0,
        });
    }
}
function updateCounts() {
    const counts = fileTreeRepo.getSyncStatusCounts();
    const queueCount = queueRepo.getActiveCount();
    emitState({
        totalFiles: counts.total,
        pendingUploads: counts.localOnly + queueCount,
        pendingDownloads: 0,
        conflictCount: counts.conflict,
    });
}
//# sourceMappingURL=sync-engine.js.map