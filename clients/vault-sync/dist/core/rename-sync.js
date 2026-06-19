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
exports.trackPendingRemoval = trackPendingRemoval;
exports.tryResolvePendingRename = tryResolvePendingRename;
exports.applyPathChange = applyPathChange;
exports.applyFolderPathChange = applyFolderPathChange;
exports.detectRenamesFromScan = detectRenamesFromScan;
exports.buildHashIndexKey = buildHashIndexKey;
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const database_1 = require("../db/database");
const fileTreeRepo = __importStar(require("../db/file-tree-repo"));
const queueRepo = __importStar(require("../db/queue-repo"));
const settings_repo_1 = require("../db/settings-repo");
const api_client_1 = require("./api-client");
const hasher_1 = require("../services/hasher");
const logger_1 = require("../services/logger");
const paths_1 = require("../services/paths");
const PENDING_REMOVAL_MS = 20_000;
const pendingRemovals = new Map();
function hashKey(hash, size) {
    return `${hash}:${size}`;
}
function trackPendingRemoval(relPath, isFolder) {
    const normalized = (0, paths_1.normalizeRelPath)(relPath);
    const entry = fileTreeRepo.getFileByRelPath(normalized);
    if (!entry)
        return;
    if (entry.syncStatus === 'deleted' || entry.syncStatus === 'remote_only')
        return;
    const recordedAt = Date.now();
    pendingRemovals.set(normalized, { entry, isFolder, at: recordedAt });
    setTimeout(() => {
        const cur = pendingRemovals.get(normalized);
        if (cur && cur.at === recordedAt)
            pendingRemovals.delete(normalized);
    }, PENDING_REMOVAL_MS);
}
async function tryResolvePendingRename(newRelPath, isFolder) {
    prunePendingRemovals();
    const normalizedNew = (0, paths_1.normalizeRelPath)(newRelPath);
    const settings = (0, settings_repo_1.getSettings)();
    if (!settings.syncRootPath || !settings.serverUrl || !settings.apiKey)
        return false;
    if (isFolder) {
        return tryResolveFolderRename(normalizedNew, settings);
    }
    const absPath = (0, paths_1.toAbsPath)(settings.syncRootPath, normalizedNew);
    let stat;
    try {
        stat = fs_1.default.statSync(absPath);
    }
    catch {
        return false;
    }
    if (stat.size === 0)
        return false;
    const hash = await (0, hasher_1.computeFileHash)(absPath).catch(() => null);
    if (!hash)
        return false;
    for (const [oldPath, pending] of pendingRemovals) {
        if (pending.isFolder)
            continue;
        const oldEntry = pending.entry;
        const oldHash = oldEntry.localHash;
        if (!oldHash && oldEntry.fileId) {
            continue;
        }
        if (oldHash && oldHash === hash && oldEntry.size === stat.size) {
            pendingRemovals.delete(oldPath);
            await applyPathChange(oldEntry, normalizedNew);
            return true;
        }
    }
    const byHash = fileTreeRepo.getFileByHash(hash, normalizedNew);
    if (byHash?.fileId && byHash.syncStatus === 'synced' && (0, paths_1.normalizeRelPath)(byHash.localRelPath) !== normalizedNew) {
        const oldAbs = (0, paths_1.toAbsPath)(settings.syncRootPath, byHash.localRelPath);
        if (!fs_1.default.existsSync(oldAbs)) {
            await applyPathChange(byHash, normalizedNew);
            return true;
        }
    }
    return false;
}
async function tryResolveFolderRename(newFolderRel, settings) {
    const newAbs = (0, paths_1.toAbsPath)(settings.syncRootPath, newFolderRel);
    if (!fs_1.default.statSync(newAbs).isDirectory())
        return false;
    for (const [oldPath, pending] of pendingRemovals) {
        if (!pending.isFolder || !pending.entry.fileId)
            continue;
        if (await folderContentsMatchRename(settings.syncRootPath, oldPath, newFolderRel)) {
            pendingRemovals.delete(oldPath);
            await applyFolderPathChange(pending.entry, newFolderRel);
            return true;
        }
    }
    return false;
}
async function folderContentsMatchRename(syncRoot, oldPrefix, newPrefix) {
    const oldNorm = (0, paths_1.normalizeRelPath)(oldPrefix);
    const newNorm = (0, paths_1.normalizeRelPath)(newPrefix);
    const children = fileTreeRepo.getFilesUnderPrefix(`${oldNorm}/`).filter((f) => !f.isFolder && f.localHash);
    if (children.length === 0)
        return false;
    for (const child of children) {
        const suffix = child.localRelPath.slice(oldNorm.length + 1);
        const candidate = `${newNorm}/${suffix}`;
        const abs = (0, paths_1.toAbsPath)(syncRoot, candidate);
        if (!fs_1.default.existsSync(abs))
            return false;
        const stat = fs_1.default.statSync(abs);
        if (stat.size !== child.size)
            return false;
        if (child.localHash) {
            const hash = await (0, hasher_1.computeFileHash)(abs).catch(() => null);
            if (hash !== child.localHash)
                return false;
        }
    }
    return true;
}
async function applyPathChange(oldEntry, newRelPath) {
    const normalizedNew = (0, paths_1.normalizeRelPath)(newRelPath);
    const normalizedOld = (0, paths_1.normalizeRelPath)(oldEntry.localRelPath);
    if (normalizedOld === normalizedNew)
        return;
    const newName = path_1.default.basename(normalizedNew);
    const settings = (0, settings_repo_1.getSettings)();
    if (oldEntry.fileId && settings.serverUrl && settings.apiKey) {
        const api = new api_client_1.VaultApiClient({ serverUrl: settings.serverUrl, apiKey: settings.apiKey });
        const oldParent = (0, paths_1.parentPathFromRel)(normalizedOld);
        const newParent = (0, paths_1.parentPathFromRel)(normalizedNew);
        if (oldParent !== newParent) {
            const moveResult = await api.moveFile([oldEntry.fileId], newParent);
            if (!moveResult.ok) {
                logger_1.logger.error('sync', `Remote move failed for ${normalizedOld}: ${moveResult.error.message}`);
                return;
            }
        }
        if (oldEntry.name !== newName) {
            const renameResult = await api.renameFile(oldEntry.fileId, newName);
            if (!renameResult.ok) {
                logger_1.logger.error('sync', `Remote rename failed for ${normalizedOld}: ${renameResult.error.message}`);
                return;
            }
        }
    }
    finalizeLocalPathUpdate(oldEntry, normalizedNew, newName);
    logger_1.logger.info('sync', `Renamed: ${normalizedOld} → ${normalizedNew}`);
}
async function applyFolderPathChange(oldFolder, newFolderRel) {
    const normalizedOld = (0, paths_1.normalizeRelPath)(oldFolder.localRelPath);
    const normalizedNew = (0, paths_1.normalizeRelPath)(newFolderRel);
    if (normalizedOld === normalizedNew)
        return;
    const newName = path_1.default.basename(normalizedNew);
    const settings = (0, settings_repo_1.getSettings)();
    if (oldFolder.fileId && settings.serverUrl && settings.apiKey) {
        const api = new api_client_1.VaultApiClient({ serverUrl: settings.serverUrl, apiKey: settings.apiKey });
        const oldParent = (0, paths_1.parentPathFromRel)(normalizedOld);
        const newParent = (0, paths_1.parentPathFromRel)(normalizedNew);
        if (oldParent !== newParent) {
            const moveResult = await api.moveFile([oldFolder.fileId], newParent);
            if (!moveResult.ok) {
                logger_1.logger.error('sync', `Remote folder move failed: ${moveResult.error.message}`);
                return;
            }
        }
        if (oldFolder.name !== newName) {
            const renameResult = await api.renameFile(oldFolder.fileId, newName);
            if (!renameResult.ok) {
                logger_1.logger.error('sync', `Remote folder rename failed: ${renameResult.error.message}`);
                return;
            }
        }
    }
    fileTreeRepo.relocatePathPrefix(normalizedOld, normalizedNew);
    queueRepo.relocateQueuePathPrefix(normalizedOld, normalizedNew);
    logger_1.logger.info('sync', `Folder renamed: ${normalizedOld} → ${normalizedNew}`);
}
function finalizeLocalPathUpdate(oldEntry, newRelPath, newName) {
    const normalizedOld = (0, paths_1.normalizeRelPath)(oldEntry.localRelPath);
    fileTreeRepo.deleteFileEntry(normalizedOld);
    queueRepo.relocateQueuePath(normalizedOld, newRelPath);
    fileTreeRepo.upsertFile((0, database_1.getDatabase)(), {
        ...oldEntry,
        localRelPath: newRelPath,
        remotePath: (0, paths_1.toRemotePath)(newRelPath),
        name: newName,
        syncStatus: oldEntry.fileId ? 'synced' : oldEntry.syncStatus,
        syncError: null,
    });
}
function prunePendingRemovals() {
    const now = Date.now();
    for (const [key, pending] of pendingRemovals) {
        if (now - pending.at > PENDING_REMOVAL_MS)
            pendingRemovals.delete(key);
    }
}
async function detectRenamesFromScan(syncRoot, hashIndex, known, seen) {
    let renamed = 0;
    for (const oldPath of known) {
        if (seen.has(oldPath))
            continue;
        const existing = fileTreeRepo.getFileByRelPath(oldPath);
        if (!existing || existing.isFolder)
            continue;
        if (!existing.localHash || !existing.fileId)
            continue;
        if (fs_1.default.existsSync((0, paths_1.toAbsPath)(syncRoot, oldPath)))
            continue;
        const key = hashKey(existing.localHash, existing.size);
        const newPath = hashIndex.get(key);
        if (!newPath || newPath === oldPath || !seen.has(newPath))
            continue;
        await applyPathChange(existing, newPath);
        renamed += 1;
    }
    for (const oldPath of known) {
        if (seen.has(oldPath))
            continue;
        const existing = fileTreeRepo.getFileByRelPath(oldPath);
        if (!existing?.isFolder || !existing.fileId)
            continue;
        if (fs_1.default.existsSync((0, paths_1.toAbsPath)(syncRoot, oldPath)))
            continue;
        for (const candidate of seen) {
            if (!fs_1.default.statSync((0, paths_1.toAbsPath)(syncRoot, candidate)).isDirectory())
                continue;
            if (await folderContentsMatchRename(syncRoot, oldPath, candidate)) {
                await applyFolderPathChange(existing, candidate);
                renamed += 1;
                break;
            }
        }
    }
    if (renamed > 0) {
        logger_1.logger.info('sync', `Detected ${renamed} rename(s) during scan`);
    }
    return renamed;
}
function buildHashIndexKey(hash, size) {
    return hashKey(hash, size);
}
//# sourceMappingURL=rename-sync.js.map