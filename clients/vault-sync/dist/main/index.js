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
const logger_1 = require("../services/logger");
const hasher_1 = require("../services/hasher");
let mainWindow = null;
let tray = null;
let dataDir;
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
    (0, file_watcher_1.startWatcher)(settings.syncRootPath, (event, filePath) => {
        (0, sync_engine_1.handleWatcherEvent)(event, filePath).catch((err) => {
            logger_1.logger.warn('watcher', `Event failed (${event} ${filePath}): ${err instanceof Error ? err.message : String(err)}`);
        });
    });
    (0, upload_queue_1.startProcessing)(2000);
    (0, upload_queue_1.kickQueue)();
    (0, sync_engine_1.startSyncLoop)().catch((err) => logger_1.logger.error('main', `Sync start error: ${err.message}`));
    logger_1.logger.info('main', 'App started');
});
electron_1.app.on('window-all-closed', () => {
    // Don't quit on window close — keep running in tray
});
electron_1.app.on('before-quit', () => {
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
        const absPath = path_1.default.join(settings.syncRootPath, localRelPath);
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