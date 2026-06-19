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
exports.syncLocalFolder = syncLocalFolder;
exports.syncLocalOnlyFolders = syncLocalOnlyFolders;
const fs_1 = __importDefault(require("fs"));
const database_1 = require("../db/database");
const fileTreeRepo = __importStar(require("../db/file-tree-repo"));
const settings_repo_1 = require("../db/settings-repo");
const api_client_1 = require("./api-client");
const remote_listing_cache_1 = require("./remote-listing-cache");
const logger_1 = require("../services/logger");
const paths_1 = require("../services/paths");
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
/** Ensure a local folder path exists on the server (creates parents as needed). */
async function syncLocalFolder(relPath, remoteCache) {
    const settings = (0, settings_repo_1.getSettings)();
    if (!settings.syncRootPath || !settings.serverUrl || !settings.apiKey)
        return false;
    const normalized = (0, paths_1.normalizeRelPath)(relPath);
    if (!normalized)
        return false;
    const absPath = (0, paths_1.toAbsPath)(settings.syncRootPath, normalized);
    try {
        if (!fs_1.default.existsSync(absPath) || !fs_1.default.statSync(absPath).isDirectory())
            return false;
    }
    catch {
        return false;
    }
    const api = new api_client_1.VaultApiClient({ serverUrl: settings.serverUrl, apiKey: settings.apiKey });
    const cache = remoteCache ?? new remote_listing_cache_1.RemoteListingCache(api);
    const segments = normalized.split('/').filter(Boolean);
    let builtRel = '';
    let allOk = true;
    for (const seg of segments) {
        builtRel = builtRel ? `${builtRel}/${seg}` : seg;
        const parentRemote = (0, paths_1.parentPathFromRel)(builtRel);
        const existing = fileTreeRepo.getFileByRelPath(builtRel);
        if (existing?.fileId && existing.syncStatus === 'synced') {
            continue;
        }
        let remote = await resolveRemoteFolder(cache, parentRemote, seg);
        if (!remote) {
            remote = await createRemoteFolder(api, cache, parentRemote, seg, builtRel);
        }
        if (remote) {
            upsertSyncedFolder(builtRel, remote);
            logger_1.logger.info('sync', `Folder on server: ${builtRel}`);
        }
        else {
            upsertLocalOnlyFolder(builtRel, seg);
            allOk = false;
        }
    }
    return allOk;
}
/** Sync all local-only folders (parents before children). */
async function syncLocalOnlyFolders(remoteCache) {
    const settings = (0, settings_repo_1.getSettings)();
    if (!settings.syncRootPath || !settings.serverUrl || !settings.apiKey)
        return 0;
    const api = new api_client_1.VaultApiClient({ serverUrl: settings.serverUrl, apiKey: settings.apiKey });
    const cache = remoteCache ?? new remote_listing_cache_1.RemoteListingCache(api);
    const folders = fileTreeRepo.getFilesByStatus('local_only')
        .filter((f) => f.isFolder)
        .sort((a, b) => (0, paths_1.normalizeRelPath)(a.localRelPath).split('/').length - (0, paths_1.normalizeRelPath)(b.localRelPath).split('/').length);
    let synced = 0;
    for (const folder of folders) {
        const absPath = (0, paths_1.toAbsPath)(settings.syncRootPath, folder.localRelPath);
        if (!fs_1.default.existsSync(absPath))
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
//# sourceMappingURL=folder-sync.js.map