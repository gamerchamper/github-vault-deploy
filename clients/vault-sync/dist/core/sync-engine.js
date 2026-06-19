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
exports.scanLocalFile = scanLocalFile;
exports.startSyncLoop = startSyncLoop;
exports.stopSyncLoop = stopSyncLoop;
exports.runSyncCycleNow = runSyncCycleNow;
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const database_1 = require("../db/database");
const fileTreeRepo = __importStar(require("../db/file-tree-repo"));
const queueRepo = __importStar(require("../db/queue-repo"));
const settings_repo_1 = require("../db/settings-repo");
const api_client_1 = require("./api-client");
const remote_listing_cache_1 = require("./remote-listing-cache");
const hasher_1 = require("../services/hasher");
const logger_1 = require("../services/logger");
const paths_1 = require("../services/paths");
const YIELD_EVERY_FILES = 20;
const IGNORE_FILE_NAMES = new Set([
    'desktop.ini',
    'thumbs.db',
    '.ds_store',
]);
const IGNORE_FILE_PATTERNS = [
    /^~\$/,
    /\.tmp$/i,
    /\.part$/i,
    /\.crdownload$/i,
    /^\.vault-/,
];
let running = false;
let syncTimer = null;
let cycleRunning = false;
let currentState = { status: 'idle', lastSyncAt: null, lastError: null, pendingUploads: 0, pendingDownloads: 0, conflictCount: 0, totalFiles: 0 };
let onStateChange = null;
function yieldToEventLoop() {
    return new Promise((resolve) => setImmediate(resolve));
}
function shouldIgnoreScanFile(name) {
    if (name.startsWith('.vault-'))
        return true;
    if (name.startsWith('~$'))
        return true;
    if (IGNORE_FILE_NAMES.has(name.toLowerCase()))
        return true;
    return IGNORE_FILE_PATTERNS.some((re) => re.test(name));
}
function getSyncState() {
    return { ...currentState };
}
function onSyncStateChange(cb) {
    onStateChange = cb;
}
/** Scan one file (watcher / manual refresh) and queue if needed. */
async function scanLocalFile(relPath) {
    const settings = (0, settings_repo_1.getSettings)();
    if (!settings.syncRootPath || !settings.serverUrl || !settings.apiKey)
        return;
    const normalized = (0, paths_1.normalizeRelPath)(relPath);
    const absPath = (0, paths_1.toAbsPath)(settings.syncRootPath, normalized);
    if (!fs_1.default.existsSync(absPath) || fs_1.default.statSync(absPath).isDirectory())
        return;
    const api = new api_client_1.VaultApiClient({ serverUrl: settings.serverUrl, apiKey: settings.apiKey });
    const remoteCache = new remote_listing_cache_1.RemoteListingCache(api);
    await validateAndQueueFile(path_1.default.dirname(absPath), path_1.default.basename(absPath), normalized, remoteCache);
    updateCounts();
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
async function runSyncCycleNow() {
    await runSyncCycle();
}
async function runSyncCycle() {
    if (cycleRunning) {
        logger_1.logger.debug('sync', 'Sync cycle skipped — previous cycle still running');
        return;
    }
    const settings = (0, settings_repo_1.getSettings)();
    if (!settings.serverUrl || !settings.apiKey) {
        emitState({ status: 'idle', lastError: 'Not authenticated' });
        return;
    }
    cycleRunning = true;
    emitState({ status: 'syncing' });
    const api = new api_client_1.VaultApiClient({ serverUrl: settings.serverUrl, apiKey: settings.apiKey });
    const remoteCache = new remote_listing_cache_1.RemoteListingCache(api);
    logger_1.logger.info('sync', 'Starting sync cycle');
    try {
        await syncRemoteMetadata(api, settings.syncRootPath);
        await reconcileOutstandingUploads(settings.syncRootPath, remoteCache);
        await scanLocalFiles(settings.syncRootPath, remoteCache);
        await enqueueAllLocalOnly(settings.syncRootPath, remoteCache);
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
    finally {
        cycleRunning = false;
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
            const localRel = file.path === '/' ? '' : file.path.slice(1);
            const normalizedRel = (0, paths_1.normalizeRelPath)(localRel);
            const absPath = (0, paths_1.toAbsPath)(syncRoot, normalizedRel);
            const existing = fileTreeRepo.getFileByRelPath(normalizedRel);
            const existsLocally = fs_1.default.existsSync(absPath) && (isFolder ? fs_1.default.statSync(absPath).isDirectory() : fs_1.default.statSync(absPath).isFile());
            let syncStatus;
            if (isFolder) {
                syncStatus = existsLocally ? 'synced' : 'remote_only';
            }
            else {
                syncStatus = existing?.syncStatus ?? 'remote_only';
                if (existsLocally && existing?.syncStatus === 'synced') {
                    syncStatus = 'synced';
                }
                else if (existsLocally && (syncStatus === 'remote_only' || syncStatus === 'local_only')) {
                    syncStatus = 'synced';
                }
            }
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
                syncStatus,
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
                        syncStatus: existing?.syncStatus === 'synced' ? 'synced' : (existing ? existing.syncStatus : 'remote_only'),
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
    const allFiles = fileTreeRepo.getAllFiles();
    const byName = new Map();
    for (const f of allFiles) {
        const key = (0, paths_1.normalizeRelPath)(f.localRelPath);
        const prev = byName.get(key);
        if (!prev) {
            byName.set(key, f);
        }
        else if (prev.syncStatus === 'local_only' && f.syncStatus !== 'local_only') {
            byName.set(key, f);
        }
    }
    for (const f of allFiles) {
        const key = (0, paths_1.normalizeRelPath)(f.localRelPath);
        const canonical = byName.get(key);
        if (canonical && canonical.localRelPath !== f.localRelPath) {
            fileTreeRepo.deleteFileEntry(f.localRelPath);
        }
    }
}
async function reconcileOutstandingUploads(syncRoot, remoteCache) {
    const db = (0, database_1.getDatabase)();
    let reset = 0;
    const phantoms = fileTreeRepo.getAllFiles().filter((f) => !f.isFolder && f.syncStatus === 'synced' && !f.fileId);
    for (const file of phantoms) {
        fileTreeRepo.upsertFile(db, { ...file, syncStatus: 'local_only', fileId: null, syncError: null });
        reset += 1;
    }
    const localOnly = fileTreeRepo.getFilesByStatus('local_only').filter((f) => !f.isFolder);
    for (const file of localOnly) {
        const absPath = (0, paths_1.toAbsPath)(syncRoot, file.localRelPath);
        if (!fs_1.default.existsSync(absPath))
            continue;
        queueRepo.requeuePathIfFailed(file.localRelPath);
        if (queueRepo.hasActiveQueueEntry(file.localRelPath))
            continue;
        await uploadLocalOnlyFile(absPath, file.localRelPath, file, remoteCache);
    }
    const synced = fileTreeRepo.getFilesByStatus('synced').filter((f) => !f.isFolder && f.fileId);
    for (const file of synced) {
        const absPath = (0, paths_1.toAbsPath)(syncRoot, file.localRelPath);
        if (!fs_1.default.existsSync(absPath))
            continue;
        const parentPath = (0, paths_1.parentPathFromRel)(file.localRelPath);
        const onServer = await remoteCache.hasFileId(parentPath, file.fileId);
        if (onServer === false) {
            fileTreeRepo.upsertFile(db, { ...file, syncStatus: 'local_only', fileId: null, syncError: null });
            reset += 1;
            if (!queueRepo.hasActiveQueueEntry(file.localRelPath)) {
                await validateAndQueueFile(path_1.default.dirname(absPath), path_1.default.basename(absPath), file.localRelPath, remoteCache);
            }
        }
    }
    if (reset > 0) {
        logger_1.logger.info('sync', `Reset ${reset} phantom synced entries — will re-upload`);
    }
}
async function scanLocalFiles(syncRoot, remoteCache) {
    const db = (0, database_1.getDatabase)();
    const known = new Set(fileTreeRepo.getAllFiles().map((f) => f.localRelPath));
    const seen = new Set();
    let scanned = 0;
    async function walk(dir, relDir) {
        let entries;
        try {
            entries = fs_1.default.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            if (shouldIgnoreScanFile(entry.name))
                continue;
            const relPath = relDir ? (0, paths_1.normalizeRelPath)(path_1.default.join(relDir, entry.name)) : entry.name;
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
                await walk(path_1.default.join(dir, entry.name), relPath);
            }
            else {
                scanned += 1;
                if (scanned % YIELD_EVERY_FILES === 0) {
                    await yieldToEventLoop();
                }
                await validateAndQueueFile(dir, entry.name, relPath, remoteCache);
            }
        }
    }
    await walk(syncRoot, '');
    for (const filePath of known) {
        if (!seen.has(filePath)) {
            const existing = fileTreeRepo.getFileByRelPath(filePath);
            if (existing && existing.syncStatus === 'synced' && existing.isFolder) {
                continue;
            }
            if (existing && (existing.syncStatus === 'synced' || existing.syncStatus === 'local_only') && !existing.isFolder) {
                logger_1.logger.info('sync', `Local file deleted: ${filePath}`);
                fileTreeRepo.upsertFile(db, { ...existing, syncStatus: 'deleted' });
            }
        }
    }
}
function markSyncedFromRemote(relPath, name, stat, remote, existing, localHash) {
    fileTreeRepo.upsertFile((0, database_1.getDatabase)(), {
        fileId: remote.id,
        localRelPath: relPath,
        remotePath: remote.path,
        name,
        size: stat.size,
        mimeType: existing?.mimeType ?? remote.mimeType ?? null,
        isFolder: false,
        localMtimeMs: stat.mtimeMs,
        localHash,
        remoteHash: remote.contentHash,
        remoteUpdatedAt: remote.updatedAt,
        syncStatus: 'synced',
        syncTaskId: null,
        syncError: null,
    });
}
async function tryMarkSyncedFromRemote(relPath, name, stat, existing, remoteCache) {
    const parentPath = (0, paths_1.parentPathFromRel)(relPath);
    const remoteMatch = await remoteCache.findByNameAndSize(parentPath, name, stat.size);
    if (!remoteMatch)
        return false;
    const localHash = existing?.localHash
        ?? (existing?.localMtimeMs === stat.mtimeMs
            ? null
            : await (0, hasher_1.computeFileHash)((0, paths_1.toAbsPath)((0, settings_repo_1.getSettings)().syncRootPath, relPath)).catch(() => null));
    markSyncedFromRemote(relPath, name, stat, remoteMatch, existing, localHash);
    return true;
}
async function queueFileForUpload(relPath, name, stat, existing, opts) {
    const settings = (0, settings_repo_1.getSettings)();
    const normalizedRel = (0, paths_1.normalizeRelPath)(relPath);
    const absPath = (0, paths_1.toAbsPath)(settings.syncRootPath, normalizedRel);
    const hash = existing?.localHash ?? await (0, hasher_1.computeFileHash)(absPath).catch(() => null);
    if (!hash) {
        logger_1.logger.warn('sync', `Could not hash file for upload: ${normalizedRel}`);
        return;
    }
    fileTreeRepo.upsertFile((0, database_1.getDatabase)(), {
        fileId: existing?.fileId ?? null,
        localRelPath: normalizedRel,
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
    if (!queueRepo.hasActiveQueueEntry(normalizedRel)) {
        const queueId = queueRepo.addToQueue({
            fileId: existing?.fileId ?? null,
            localRelPath: normalizedRel,
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
            priority: opts.priority ?? 0,
        });
        if (queueId > 0 && opts.logMessage) {
            logger_1.logger.info('sync', `${opts.logMessage}: ${normalizedRel}`);
        }
    }
}
async function uploadLocalOnlyFile(absPath, relPath, existing, remoteCache) {
    let stat;
    try {
        stat = fs_1.default.statSync(absPath);
    }
    catch {
        return;
    }
    if (stat.size === 0)
        return;
    const name = path_1.default.basename(relPath);
    if (await tryMarkSyncedFromRemote(relPath, name, stat, existing, remoteCache)) {
        return;
    }
    await queueFileForUpload(relPath, name, stat, existing, {
        priority: 10,
        logMessage: 'Uploading local-only file',
    });
}
async function enqueueAllLocalOnly(syncRoot, remoteCache) {
    const localOnly = fileTreeRepo.getFilesByStatus('local_only').filter((f) => !f.isFolder);
    let queued = 0;
    let skippedMissing = 0;
    let skippedQueued = 0;
    for (const file of localOnly) {
        const normalizedRel = (0, paths_1.normalizeRelPath)(file.localRelPath);
        const absPath = (0, paths_1.toAbsPath)(syncRoot, normalizedRel);
        if (!fs_1.default.existsSync(absPath)) {
            skippedMissing += 1;
            continue;
        }
        queueRepo.requeuePathIfFailed(normalizedRel);
        if (queueRepo.hasActiveQueueEntry(normalizedRel)) {
            skippedQueued += 1;
            continue;
        }
        const before = queueRepo.hasActiveQueueEntry(normalizedRel);
        await uploadLocalOnlyFile(absPath, normalizedRel, file, remoteCache);
        if (!before && queueRepo.hasActiveQueueEntry(normalizedRel)) {
            queued += 1;
        }
    }
    logger_1.logger.info('sync', `Local-only: ${localOnly.length} file(s), queued ${queued}, already queued ${skippedQueued}, missing ${skippedMissing}`);
}
async function validateAndQueueFile(dir, name, relPath, remoteCache) {
    const absPath = path_1.default.join(dir, name);
    const existing = fileTreeRepo.getFileByRelPath(relPath);
    let stat;
    try {
        stat = fs_1.default.statSync(absPath);
    }
    catch {
        return;
    }
    if (stat.size === 0)
        return;
    if (queueRepo.hasActiveQueueEntry(relPath))
        return;
    if (existing?.syncStatus === 'synced' && existing.fileId && existing.size === stat.size) {
        return;
    }
    if (await tryMarkSyncedFromRemote(relPath, name, stat, existing, remoteCache)) {
        return;
    }
    if (existing?.syncStatus === 'local_only') {
        await queueFileForUpload(relPath, name, stat, existing, {
            priority: 10,
            logMessage: 'Uploading local-only file',
        });
        return;
    }
    if (existing?.syncStatus === 'synced') {
        if (existing.fileId
            && existing.localHash
            && existing.localMtimeMs === stat.mtimeMs
            && existing.size === stat.size) {
            return;
        }
        if (existing.localHash && existing.fileId) {
            const hash = await (0, hasher_1.computeFileHash)(absPath).catch(() => null);
            if (hash && existing.localHash === hash) {
                if (existing.localMtimeMs !== stat.mtimeMs || existing.size !== stat.size) {
                    fileTreeRepo.upsertFile((0, database_1.getDatabase)(), {
                        ...existing,
                        localMtimeMs: stat.mtimeMs,
                        size: stat.size,
                    });
                }
                return;
            }
        }
    }
    const hash = await (0, hasher_1.computeFileHash)(absPath).catch(() => null);
    if (!hash)
        return;
    const dupEntry = fileTreeRepo.getFileByHash(hash, relPath);
    if (dupEntry && dupEntry.fileId && dupEntry.syncStatus === 'synced' && dupEntry.localRelPath !== relPath) {
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
    if (existing?.syncStatus === 'synced' && existing.localHash === hash && existing.fileId) {
        return;
    }
    await queueFileForUpload(relPath, name, stat, existing, {
        logMessage: 'New/modified file',
    });
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