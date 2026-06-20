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
exports.ensureSyncContainerOnServer = ensureSyncContainerOnServer;
exports.syncLocalFolder = syncLocalFolder;
exports.syncLocalOnlyFolders = syncLocalOnlyFolders;
exports.registerAdditionalFolderRoots = registerAdditionalFolderRoots;
const fs_1 = __importDefault(require("fs"));
const database_1 = require("../db/database");
const fileTreeRepo = __importStar(require("../db/file-tree-repo"));
const settings_repo_1 = require("../db/settings-repo");
const api_client_1 = require("./api-client");
const remote_listing_cache_1 = require("./remote-listing-cache");
const logger_1 = require("../services/logger");
const paths_1 = require("../services/paths");
const sync_mappings_1 = require("../services/sync-mappings");
function parseFolderPayload(folder) {
    if (!folder || typeof folder !== 'object')
        return null;
    const f = folder;
    const id = f.id;
    const name = f.name;
    const remotePath = f.path;
    if (!id || !name || !remotePath)
        return null;
    return { id, name, path: remotePath };
}
function upsertSyncedFolder(folderRel, remote) {
    fileTreeRepo.upsertFile((0, database_1.getDatabase)(), {
        fileId: remote.id,
        localRelPath: folderRel,
        remotePath: remote.path,
        name: remote.name,
        size: 0,
        mimeType: null,
        isFolder: true,
        localMtimeMs: null,
        localHash: null,
        remoteHash: null,
        remoteUpdatedAt: new Date().toISOString(),
        syncStatus: 'synced',
        syncTaskId: null,
        syncError: null,
    });
}
function upsertLocalOnlyFolder(folderRel, name) {
    fileTreeRepo.upsertFile((0, database_1.getDatabase)(), {
        fileId: null,
        localRelPath: folderRel,
        remotePath: null,
        name,
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
async function resolveRemoteFolder(remoteCache, parentRemote, name) {
    const match = await remoteCache.findFolderByName(parentRemote, name);
    if (!match)
        return null;
    return { id: match.id, name: match.name, path: match.path };
}
async function createRemoteFolder(api, remoteCache, parentRemote, name, folderRel) {
    const result = await api.createFolder(name, parentRemote);
    if (result.ok) {
        const folder = parseFolderPayload(result.value.folder);
        if (folder) {
            remoteCache.invalidate(parentRemote);
            return folder;
        }
        logger_1.logger.warn('sync', `Failed to create folder "${folderRel}": Invalid folder response`);
        return null;
    }
    const msg = result.error.message;
    if (/already exists/i.test(msg)) {
        remoteCache.invalidate(parentRemote);
        const existing = await resolveRemoteFolder(remoteCache, parentRemote, name);
        if (existing)
            return existing;
    }
    logger_1.logger.warn('sync', `Failed to create folder "${folderRel}": ${msg}`);
    return null;
}
async function ensureRemotePath(api, remoteCache, remotePath) {
    const normalized = remotePath.replace(/\\/g, '/');
    if (normalized === '/' || !normalized)
        return true;
    const segments = normalized.replace(/^\//, '').split('/').filter(Boolean);
    let current = '/';
    for (const seg of segments) {
        let remote = await resolveRemoteFolder(remoteCache, current, seg);
        if (!remote) {
            remote = await createRemoteFolder(api, remoteCache, current, seg, normalized);
        }
        if (!remote)
            return false;
        current = remote.path;
    }
    return true;
}
/** Ensure the server has /Sync Folder before syncing additional PC folders. */
async function ensureSyncContainerOnServer(api) {
    const settings = (0, settings_repo_1.getSettings)();
    if (!settings.serverUrl || !settings.apiKey)
        return false;
    const client = api ?? new api_client_1.VaultApiClient({ serverUrl: settings.serverUrl, apiKey: settings.apiKey });
    const cache = new remote_listing_cache_1.RemoteListingCache(client);
    return ensureRemotePath(client, cache, `/${sync_mappings_1.SYNC_CONTAINER_NAME}`);
}
/** Ensure a local folder path exists on the server (creates parents as needed). */
async function syncLocalFolder(relPath, remoteCache) {
    const settings = (0, settings_repo_1.getSettings)();
    if (!settings.serverUrl || !settings.apiKey)
        return false;
    const normalized = (0, paths_1.normalizeRelPath)(relPath);
    if (!normalized && !(0, sync_mappings_1.isAdditionalStoredRel)(relPath))
        return false;
    const absPath = (0, sync_mappings_1.absPathFromStored)(settings, normalized);
    if (!absPath)
        return false;
    try {
        if (!fs_1.default.existsSync(absPath) || !fs_1.default.statSync(absPath).isDirectory())
            return false;
    }
    catch {
        return false;
    }
    const api = new api_client_1.VaultApiClient({ serverUrl: settings.serverUrl, apiKey: settings.apiKey });
    const cache = remoteCache ?? new remote_listing_cache_1.RemoteListingCache(api);
    const mappingId = (0, sync_mappings_1.mappingIdFromStored)(normalized);
    const segments = (0, sync_mappings_1.relWithinSegments)(normalized);
    if (mappingId) {
        const mapping = (0, sync_mappings_1.findMapping)(settings, mappingId);
        if (!mapping)
            return false;
        await ensureRemotePath(api, cache, `/${sync_mappings_1.SYNC_CONTAINER_NAME}`);
        await ensureRemotePath(api, cache, (0, sync_mappings_1.remotePrefixForFolderName)(mapping.name));
    }
    let builtRel = mappingId ? `@sync/${mappingId}` : '';
    let builtRemote = mappingId
        ? (0, sync_mappings_1.remotePrefixForFolderName)((0, sync_mappings_1.findMapping)(settings, mappingId).name)
        : '/';
    let allOk = true;
    for (const seg of segments) {
        builtRel = builtRel ? `${builtRel}/${seg}` : (mappingId ? `@sync/${mappingId}/${seg}` : seg);
        const parentRemote = builtRemote;
        const existing = fileTreeRepo.getFileByRelPath(builtRel);
        if (existing?.fileId && existing.syncStatus === 'synced') {
            builtRemote = existing.remotePath || `${parentRemote}/${seg}`.replace(/\/+/g, '/');
            continue;
        }
        let remote = await resolveRemoteFolder(cache, parentRemote, seg);
        if (!remote) {
            remote = await createRemoteFolder(api, cache, parentRemote, seg, builtRel);
        }
        if (remote) {
            upsertSyncedFolder(builtRel, remote);
            builtRemote = remote.path;
            logger_1.logger.info('sync', `Folder on server: ${builtRel}`);
        }
        else {
            upsertLocalOnlyFolder(builtRel, seg);
            allOk = false;
        }
    }
    if (mappingId && segments.length === 0) {
        const mapping = (0, sync_mappings_1.findMapping)(settings, mappingId);
        if (mapping) {
            const stored = `@sync/${mappingId}`;
            let remote = await resolveRemoteFolder(cache, `/${sync_mappings_1.SYNC_CONTAINER_NAME}`, mapping.name);
            if (!remote) {
                remote = await createRemoteFolder(api, cache, `/${sync_mappings_1.SYNC_CONTAINER_NAME}`, mapping.name, stored);
            }
            if (remote)
                upsertSyncedFolder(stored, remote);
            else
                allOk = false;
        }
    }
    return allOk;
}
/** Sync all local-only folders (parents before children). */
async function syncLocalOnlyFolders(remoteCache) {
    const settings = (0, settings_repo_1.getSettings)();
    if (!settings.serverUrl || !settings.apiKey)
        return 0;
    const api = new api_client_1.VaultApiClient({ serverUrl: settings.serverUrl, apiKey: settings.apiKey });
    const cache = remoteCache ?? new remote_listing_cache_1.RemoteListingCache(api);
    const folders = fileTreeRepo.getFilesByStatus('local_only')
        .filter((f) => f.isFolder)
        .sort((a, b) => (0, paths_1.normalizeRelPath)(a.localRelPath).split('/').length - (0, paths_1.normalizeRelPath)(b.localRelPath).split('/').length);
    let synced = 0;
    for (const folder of folders) {
        const absPath = (0, sync_mappings_1.absPathFromStored)(settings, folder.localRelPath);
        if (!absPath || !fs_1.default.existsSync(absPath))
            continue;
        const ok = await syncLocalFolder(folder.localRelPath, cache);
        if (ok)
            synced += 1;
    }
    if (synced > 0) {
        logger_1.logger.info('sync', `Synced ${synced} local folder(s) to server`);
    }
    return synced;
}
async function registerAdditionalFolderRoots() {
    const settings = (0, settings_repo_1.getSettings)();
    const db = (0, database_1.getDatabase)();
    for (const mapping of settings.additionalSyncFolders || []) {
        if (!mapping.enabled || !mapping.localPath)
            continue;
        const stored = `@sync/${mapping.id}`;
        const existing = fileTreeRepo.getFileByRelPath(stored);
        if (!existing) {
            fileTreeRepo.upsertFile(db, {
                fileId: null,
                localRelPath: stored,
                remotePath: (0, sync_mappings_1.remotePrefixForFolderName)(mapping.name),
                name: mapping.name,
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
    }
}
//# sourceMappingURL=folder-sync.js.map