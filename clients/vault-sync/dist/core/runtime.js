"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectWatchRoots = collectWatchRoots;
exports.restartWatchers = restartWatchers;
exports.onRemoteConfigApplied = onRemoteConfigApplied;
exports.getDefaultDataDir = getDefaultDataDir;
exports.getDefaultSyncRoot = getDefaultSyncRoot;
exports.ensureDataDir = ensureDataDir;
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const os_1 = __importDefault(require("os"));
const settings_repo_1 = require("../db/settings-repo");
const sync_mappings_1 = require("../services/sync-mappings");
const file_watcher_1 = require("./file-watcher");
const sync_engine_1 = require("./sync-engine");
const upload_queue_1 = require("./upload-queue");
const folder_sync_1 = require("./folder-sync");
const logger_1 = require("../services/logger");
function collectWatchRoots() {
    const settings = (0, settings_repo_1.getSettings)();
    const roots = [];
    if (settings.syncRootPath)
        roots.push(settings.syncRootPath);
    for (const mapping of (0, sync_mappings_1.getEnabledAdditionalFolders)(settings)) {
        roots.push(mapping.localPath);
    }
    return roots;
}
function restartWatchers() {
    (0, file_watcher_1.startAllWatchers)(collectWatchRoots(), (absPath) => {
        const s = (0, settings_repo_1.getSettings)();
        return (0, sync_mappings_1.resolveAbsPathToStored)(s, absPath);
    }, (event, filePath) => {
        (0, sync_engine_1.handleWatcherEvent)(event, filePath).catch((err) => {
            logger_1.logger.warn('watcher', `Event failed (${event} ${filePath}): ${err instanceof Error ? err.message : String(err)}`);
        });
    });
}
async function onRemoteConfigApplied() {
    (0, upload_queue_1.resetFolderCache)();
    restartWatchers();
    try {
        await (0, folder_sync_1.registerAdditionalFolderRoots)();
    }
    catch (err) {
        logger_1.logger.warn('agent', `Folder root registration failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const settings = (0, settings_repo_1.getSettings)();
    for (const folder of (0, sync_mappings_1.getEnabledAdditionalFolders)(settings)) {
        (0, sync_engine_1.scanAdditionalFolderNow)(folder.id).catch(() => { });
    }
    (0, upload_queue_1.kickQueue)();
    (0, sync_engine_1.stopSyncLoop)();
    (0, sync_engine_1.startSyncLoop)().catch(() => { });
}
function getDefaultDataDir() {
    return process.env.VAULT_SYNC_DATA_DIR || path_1.default.join(os_1.default.homedir(), '.vault-sync');
}
function getDefaultSyncRoot() {
    return process.env.VAULT_SYNC_ROOT || path_1.default.join(os_1.default.homedir(), 'GitHub Vault');
}
function ensureDataDir(dataDir) {
    fs_1.default.mkdirSync(dataDir, { recursive: true });
}
//# sourceMappingURL=runtime.js.map