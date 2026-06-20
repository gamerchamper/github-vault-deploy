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
const electron_1 = require("electron");
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const database_1 = require("../db/database");
const settings_repo_1 = require("../db/settings-repo");
const queueRepo = __importStar(require("../db/queue-repo"));
const fileTreeRepo = __importStar(require("../db/file-tree-repo"));
const sync_engine_1 = require("../core/sync-engine");
const file_watcher_1 = require("../core/file-watcher");
const upload_queue_1 = require("../core/upload-queue");
const api_client_1 = require("../core/api-client");
const folder_sync_1 = require("../core/folder-sync");
const logger_1 = require("../services/logger");
const hasher_1 = require("../services/hasher");
const agent_client_1 = require("../core/agent-client");
const runtime_1 = require("../core/runtime");
const sync_mappings_1 = require("../services/sync-mappings");
let mainWindow = null;
let tray = null;
let dataDir;
let stopAgentClient = null;
function getDefaultDataDir() {
    const userData = electron_1.app.getPath('userData');
    const dir = path_1.default.join(userData, 'vault-sync-data');
    fs_1.default.mkdirSync(dir, { recursive: true });
    return dir;
}
function getDefaultSyncRoot() {
    return path_1.default.join(electron_1.app.getPath('home'), 'GitHub Vault');
}
electron_1.app.setAppUserModelId('com.github-vault.sync');
const gotTheLock = electron_1.app.requestSingleInstanceLock();
if (!gotTheLock) {
    electron_1.app.quit();
}
else {
    electron_1.app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized())
                mainWindow.restore();
            mainWindow.focus();
        }
    });
}
electron_1.app.whenReady().then(() => {
    dataDir = getDefaultDataDir();
    (0, database_1.openDatabase)(dataDir);
    const queueReset = queueRepo.prepareQueueAfterRestart();
    if (queueReset.deduped > 0 || queueReset.cancelled > 0 || queueReset.sessionsCleared > 0) {
        logger_1.logger.info('main', `Queue cleanup: ${queueReset.deduped} duplicate(s), ${queueReset.cancelled} invalid, ${queueReset.sessionsCleared} stale session(s) cleared`);
    }
    const settings = (0, settings_repo_1.getSettings)();
    if (!settings.syncRootPath) {
        (0, settings_repo_1.updateSettings)({ syncRootPath: getDefaultSyncRoot() });
    }
    setupIPC();
    createTray();
    logger_1.logger.setHandler((level, category, message, details) => {
        if (!mainWindow || mainWindow.isDestroyed())
            return;
        if (level === 'error' || category !== 'sync') {
            mainWindow.webContents.send('log', { level, category, message, details, time: new Date().toISOString() });
        }
    });
    (0, sync_engine_1.onSyncStateChange)((state) => {
        updateTrayMenu(state);
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('sync-state', state);
        }
    });
    (0, upload_queue_1.setProgressHandler)((p) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('upload-progress', p);
        }
    });
    (0, file_watcher_1.startAllWatchers)((0, runtime_1.collectWatchRoots)(), (absPath) => {
        const s = (0, settings_repo_1.getSettings)();
        return (0, sync_mappings_1.resolveAbsPathToStored)(s, absPath);
    }, (event, filePath) => {
        (0, sync_engine_1.handleWatcherEvent)(event, filePath).catch((err) => {
            logger_1.logger.warn('watcher', `Event failed (${event} ${filePath}): ${err instanceof Error ? err.message : String(err)}`);
        });
    });
    (0, upload_queue_1.startProcessing)(2000);
    (0, upload_queue_1.kickQueue)();
    (0, sync_engine_1.startSyncLoop)().catch((err) => logger_1.logger.error('main', `Sync start error: ${err.message}`));
    stopAgentClient = (0, agent_client_1.startAgentClient)({
        onRemoteConfig: () => (0, runtime_1.onRemoteConfigApplied)(),
    });
    logger_1.logger.info('main', 'App started');
});
electron_1.app.on('window-all-closed', () => {
    // Don't quit on window close — keep running in tray
});
electron_1.app.on('before-quit', () => {
    stopAgentClient?.();
    (0, sync_engine_1.stopSyncLoop)();
    (0, file_watcher_1.stopWatcher)();
    (0, upload_queue_1.stopProcessing)();
    (0, database_1.closeDatabase)();
});
function createTray() {
    const icon = electron_1.nativeImage.createEmpty();
    tray = new electron_1.Tray(icon);
    const state = (0, sync_engine_1.getSyncState)();
    updateTrayMenu(state);
    tray.setToolTip('GitHub Vault Sync');
    tray.on('double-click', () => openMainWindow());
}
function updateTrayMenu(state) {
    if (!tray)
        return;
    let statusLine = 'GitHub Vault Sync';
    if (state.status === 'syncing')
        statusLine = '↻ Syncing...';
    else if (state.status === 'error')
        statusLine = '⚠ Error';
    else if (state.status === 'offline')
        statusLine = '⚡ Offline';
    else if (state.status === 'idle')
        statusLine = '✓ Synced';
    const menu = electron_1.Menu.buildFromTemplate([
        { label: statusLine, enabled: false },
        { type: 'separator' },
        {
            label: 'Open GitHub Vault Folder',
            click: () => {
                const settings = (0, settings_repo_1.getSettings)();
                if (settings.syncRootPath)
                    electron_1.shell.openPath(settings.syncRootPath);
            },
        },
        { type: 'separator' },
        {
            label: `Upload queue: ${state.pendingUploads} pending | ${state.conflictCount} conflicts`,
            enabled: false,
        },
        { type: 'separator' },
        {
            label: 'Open Dashboard',
            click: () => openMainWindow(),
        },
        {
            label: 'Settings...',
            click: () => openMainWindow('#settings'),
        },
        { type: 'separator' },
        {
            label: 'Pause Sync',
            type: 'checkbox',
            checked: false,
            click: (mi) => {
                if (mi.checked)
                    (0, sync_engine_1.stopSyncLoop)();
                else
                    (0, sync_engine_1.startSyncLoop)().catch(() => { });
            },
        },
        { type: 'separator' },
        { label: 'Quit', click: () => electron_1.app.quit() },
    ]);
    tray.setContextMenu(menu);
}
function openMainWindow(hash = '') {
    if (mainWindow && !mainWindow.isDestroyed()) {
        if (hash)
            mainWindow.loadFile(path_1.default.join(__dirname, '../renderer/index.html'), { hash });
        mainWindow.show();
        mainWindow.focus();
        return;
    }
    mainWindow = new electron_1.BrowserWindow({
        width: 960,
        height: 680,
        minWidth: 680,
        minHeight: 480,
        title: 'GitHub Vault Sync',
        backgroundColor: '#1a1a2e',
        show: false,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path_1.default.join(__dirname, 'preload.js'),
        },
    });
    mainWindow.loadFile(path_1.default.join(__dirname, '../renderer/index.html'), { hash });
    mainWindow.once('ready-to-show', () => mainWindow.show());
    mainWindow.on('close', (e) => {
        e.preventDefault();
        mainWindow?.hide();
    });
    mainWindow.on('closed', () => { mainWindow = null; });
}
function setupIPC() {
    electron_1.ipcMain.handle('get-settings', () => (0, settings_repo_1.getSettings)());
    electron_1.ipcMain.handle('update-settings', (_event, patch) => {
        (0, settings_repo_1.updateSettings)(patch);
        (0, upload_queue_1.resetFolderCache)();
        (0, runtime_1.restartWatchers)();
        return (0, settings_repo_1.getSettings)();
    });
    electron_1.ipcMain.handle('get-sync-state', () => (0, sync_engine_1.getSyncState)());
    electron_1.ipcMain.handle('rescan-sync', async () => {
        await (0, sync_engine_1.runSyncCycleNow)();
        return (0, sync_engine_1.getSyncState)();
    });
    electron_1.ipcMain.handle('pick-folder', async () => {
        const result = await electron_1.dialog.showOpenDialog({
            properties: ['openDirectory', 'createDirectory'],
            title: 'Select GitHub Vault Sync Folder',
        });
        if (result.canceled || !result.filePaths.length)
            return null;
        return result.filePaths[0];
    });
    electron_1.ipcMain.handle('pick-additional-sync-folder', async () => {
        const result = await electron_1.dialog.showOpenDialog({
            properties: ['openDirectory'],
            title: 'Select folder to sync to Sync Folder on server',
        });
        if (result.canceled || !result.filePaths.length)
            return { ok: false };
        return { ok: true, path: result.filePaths[0] };
    });
    electron_1.ipcMain.handle('add-additional-sync-folder', async (_event, localPath) => {
        if (!localPath || !fs_1.default.existsSync(localPath)) {
            return { ok: false, error: 'Folder not found' };
        }
        const settings = (0, settings_repo_1.getSettings)();
        const conflict = (0, sync_mappings_1.pathsConflict)(settings, localPath);
        if (conflict)
            return { ok: false, error: conflict };
        const folder = (0, sync_mappings_1.createAdditionalFolder)(localPath);
        const next = [...(settings.additionalSyncFolders || []), folder];
        (0, settings_repo_1.updateSettings)({ additionalSyncFolders: next });
        if (settings.serverUrl && settings.apiKey) {
            const api = new api_client_1.VaultApiClient({ serverUrl: settings.serverUrl, apiKey: settings.apiKey });
            await (0, folder_sync_1.ensureSyncContainerOnServer)(api);
        }
        (0, upload_queue_1.resetFolderCache)();
        (0, runtime_1.restartWatchers)();
        await (0, folder_sync_1.registerAdditionalFolderRoots)();
        try {
            await (0, sync_engine_1.scanAdditionalFolderNow)(folder.id);
            (0, upload_queue_1.kickQueue)();
            logger_1.logger.info('main', `Additional folder queued for sync: ${folder.name}`);
        }
        catch (err) {
            logger_1.logger.error('main', `Additional folder scan failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        (0, sync_engine_1.runSyncCycleNow)().catch((err) => {
            logger_1.logger.warn('main', `Sync after add folder: ${err instanceof Error ? err.message : String(err)}`);
        });
        return { ok: true, folder };
    });
    electron_1.ipcMain.handle('remove-additional-sync-folder', (_event, folderId) => {
        const settings = (0, settings_repo_1.getSettings)();
        const next = (settings.additionalSyncFolders || []).filter((f) => f.id !== folderId);
        (0, settings_repo_1.updateSettings)({ additionalSyncFolders: next });
        (0, runtime_1.restartWatchers)();
        return (0, settings_repo_1.getSettings)();
    });
    electron_1.ipcMain.handle('resolve-local-path', (_event, storedRelPath) => {
        const settings = (0, settings_repo_1.getSettings)();
        return (0, sync_mappings_1.absPathFromStored)(settings, storedRelPath.replace(/\\/g, '/')) || null;
    });
    electron_1.ipcMain.handle('test-connection', async (_event, serverUrl, apiKey) => {
        try {
            const api = new api_client_1.VaultApiClient({ serverUrl, apiKey });
            const result = await api.validateAuth();
            if (result.ok && result.value.authenticated) {
                return { ok: true };
            }
            return { ok: false, error: 'Authentication failed' };
        }
        catch (e) {
            return { ok: false, error: e.message };
        }
    });
    electron_1.ipcMain.handle('get-queue', () => queueRepo.getAllQueueEntries());
    electron_1.ipcMain.handle('get-file-tree', async () => {
        await new Promise((resolve) => setImmediate(resolve));
        return fileTreeRepo.getAllFiles();
    });
    electron_1.ipcMain.handle('open-folder', (_event, folderPath) => {
        if (fs_1.default.existsSync(folderPath))
            electron_1.shell.openPath(folderPath);
    });
    electron_1.ipcMain.handle('download-file', async (_event, fileId, localRelPath) => {
        const settings = (0, settings_repo_1.getSettings)();
        if (!settings.serverUrl || !settings.apiKey)
            return { ok: false, error: 'Not authenticated' };
        const api = new api_client_1.VaultApiClient({ serverUrl: settings.serverUrl, apiKey: settings.apiKey });
        const absPath = (0, sync_mappings_1.absPathFromStored)(settings, localRelPath.replace(/\\/g, '/'));
        if (!absPath)
            return { ok: false, error: 'Unknown local path' };
        try {
            const result = await api.downloadFile(fileId, localRelPath);
            if (!result.ok)
                return { ok: false, error: result.error.message };
            const dir = path_1.default.dirname(absPath);
            fs_1.default.mkdirSync(dir, { recursive: true });
            fs_1.default.writeFileSync(absPath, Buffer.from(result.value));
            fileTreeRepo.upsertFile((0, database_1.getDatabase)(), {
                fileId, localRelPath,
                remotePath: '/' + localRelPath.replace(/\\/g, '/'),
                name: path_1.default.basename(localRelPath),
                size: result.value.byteLength,
                mimeType: null, isFolder: false,
                localMtimeMs: fs_1.default.statSync(absPath).mtimeMs,
                localHash: (0, hasher_1.computeBufferHash)(Buffer.from(result.value)),
                remoteHash: null, remoteUpdatedAt: null,
                syncStatus: 'synced', syncTaskId: null, syncError: null,
            });
            return { ok: true, size: result.value.byteLength };
        }
        catch (e) {
            return { ok: false, error: e.message };
        }
    });
}
//# sourceMappingURL=index.js.map