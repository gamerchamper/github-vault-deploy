import { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, dialog, shell, Notification } from 'electron';
import path from 'path';
import fs from 'fs';
import { openDatabase, closeDatabase, getDatabase } from '../db/database';
import { getSettings, updateSettings } from '../db/settings-repo';
import * as queueRepo from '../db/queue-repo';
import * as fileTreeRepo from '../db/file-tree-repo';
import { getSyncState, startSyncLoop, stopSyncLoop, onSyncStateChange, scanLocalFile, runSyncCycleNow, handleWatcherEvent, scanAdditionalFolderNow } from '../core/sync-engine';
import { startAllWatchers, stopWatcher } from '../core/file-watcher';
import { startProcessing, stopProcessing, setProgressHandler, resetFolderCache, kickQueue } from '../core/upload-queue';
import { VaultApiClient } from '../core/api-client';
import { ensureSyncContainerOnServer, registerAdditionalFolderRoots } from '../core/folder-sync';
import { logger } from '../services/logger';
import { computeBufferHash } from '../services/hasher';
import { startAgentClient } from '../core/agent-client';
import { collectWatchRoots, onRemoteConfigApplied, restartWatchers } from '../core/runtime';
import {
  createAdditionalFolder,
  pathsConflict,
  resolveAbsPathToStored,
  absPathFromStored,
  getEnabledAdditionalFolders,
} from '../services/sync-mappings';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let dataDir: string;
let stopAgentClient: (() => void) | null = null;

function getDefaultDataDir(): string {
  const userData = app.getPath('userData');
  const dir = path.join(userData, 'vault-sync-data');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function getDefaultSyncRoot(): string {
  return path.join(app.getPath('home'), 'GitHub Vault');
}

app.setAppUserModelId('com.github-vault.sync');

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(() => {
  dataDir = getDefaultDataDir();
  openDatabase(dataDir);
  const queueReset = queueRepo.prepareQueueAfterRestart();
  if (queueReset.deduped > 0 || queueReset.cancelled > 0 || queueReset.sessionsCleared > 0) {
    logger.info('main', `Queue cleanup: ${queueReset.deduped} duplicate(s), ${queueReset.cancelled} invalid, ${queueReset.sessionsCleared} stale session(s) cleared`);
  }

  const settings = getSettings();
  if (!settings.syncRootPath) {
    updateSettings({ syncRootPath: getDefaultSyncRoot() });
  }

  setupIPC();
  createTray();

  logger.setHandler((level, category, message, details) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (level === 'error' || category !== 'sync') {
      mainWindow.webContents.send('log', { level, category, message, details, time: new Date().toISOString() });
    }
  });

  onSyncStateChange((state) => {
    updateTrayMenu(state);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sync-state', state);
    }
  });

  setProgressHandler((p) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('upload-progress', p);
    }
  });

  startAllWatchers(collectWatchRoots(), (absPath) => {
    const s = getSettings();
    return resolveAbsPathToStored(s, absPath);
  }, (event, filePath) => {
    handleWatcherEvent(event, filePath).catch((err) => {
      logger.warn('watcher', `Event failed (${event} ${filePath}): ${err instanceof Error ? err.message : String(err)}`);
    });
  });

  startProcessing(2000);
  kickQueue();
  startSyncLoop().catch((err) => logger.error('main', `Sync start error: ${err.message}`));

  stopAgentClient = startAgentClient({
    onRemoteConfig: () => onRemoteConfigApplied(),
  });

  logger.info('main', 'App started');
});

app.on('window-all-closed', () => {
  // Don't quit on window close — keep running in tray
});

app.on('before-quit', () => {
  stopAgentClient?.();
  stopSyncLoop();
  stopWatcher();
  stopProcessing();
  closeDatabase();
});

function createTray(): void {
  const icon = nativeImage.createEmpty();
  tray = new Tray(icon);

  const state = getSyncState();
  updateTrayMenu(state);

  tray.setToolTip('GitHub Vault Sync');
  tray.on('double-click', () => openMainWindow());
}

function updateTrayMenu(state: ReturnType<typeof getSyncState>): void {
  if (!tray) return;

  let statusLine = 'GitHub Vault Sync';
  if (state.status === 'syncing') statusLine = '↻ Syncing...';
  else if (state.status === 'error') statusLine = '⚠ Error';
  else if (state.status === 'offline') statusLine = '⚡ Offline';
  else if (state.status === 'idle') statusLine = '✓ Synced';

  const menu = Menu.buildFromTemplate([
    { label: statusLine, enabled: false },
    { type: 'separator' },
    {
      label: 'Open GitHub Vault Folder',
      click: () => {
        const settings = getSettings();
        if (settings.syncRootPath) shell.openPath(settings.syncRootPath);
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
      click: (mi: Electron.MenuItem) => {
        if (mi.checked) stopSyncLoop();
        else startSyncLoop().catch(() => {});
      },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);

  tray.setContextMenu(menu);
}

function openMainWindow(hash = ''): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (hash) mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'), { hash });
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  mainWindow = new BrowserWindow({
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
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'), { hash });
  mainWindow.once('ready-to-show', () => mainWindow!.show());
  mainWindow.on('close', (e) => {
    e.preventDefault();
    mainWindow?.hide();
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

function setupIPC(): void {
  ipcMain.handle('get-settings', () => getSettings());

  ipcMain.handle('update-settings', (_event, patch: Record<string, unknown>) => {
    updateSettings(patch as any);
    resetFolderCache();
    restartWatchers();
    return getSettings();
  });

  ipcMain.handle('get-sync-state', () => getSyncState());

  ipcMain.handle('rescan-sync', async () => {
    await runSyncCycleNow();
    return getSyncState();
  });

  ipcMain.handle('pick-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Select GitHub Vault Sync Folder',
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });

  ipcMain.handle('pick-additional-sync-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: 'Select folder to sync to Sync Folder on server',
    });
    if (result.canceled || !result.filePaths.length) return { ok: false as const };
    return { ok: true as const, path: result.filePaths[0] };
  });

  ipcMain.handle('add-additional-sync-folder', async (_event, localPath: string) => {
    if (!localPath || !fs.existsSync(localPath)) {
      return { ok: false, error: 'Folder not found' };
    }
    const settings = getSettings();
    const conflict = pathsConflict(settings, localPath);
    if (conflict) return { ok: false, error: conflict };

    const folder = createAdditionalFolder(localPath);
    const next = [...(settings.additionalSyncFolders || []), folder];
    updateSettings({ additionalSyncFolders: next });

    if (settings.serverUrl && settings.apiKey) {
      const api = new VaultApiClient({ serverUrl: settings.serverUrl, apiKey: settings.apiKey });
      await ensureSyncContainerOnServer(api);
    }

    resetFolderCache();
    restartWatchers();
    await registerAdditionalFolderRoots();
    try {
      await scanAdditionalFolderNow(folder.id);
      kickQueue();
      logger.info('main', `Additional folder queued for sync: ${folder.name}`);
    } catch (err) {
      logger.error('main', `Additional folder scan failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    runSyncCycleNow().catch((err) => {
      logger.warn('main', `Sync after add folder: ${err instanceof Error ? err.message : String(err)}`);
    });

    return { ok: true, folder };
  });

  ipcMain.handle('remove-additional-sync-folder', (_event, folderId: string) => {
    const settings = getSettings();
    const next = (settings.additionalSyncFolders || []).filter((f) => f.id !== folderId);
    updateSettings({ additionalSyncFolders: next });
    restartWatchers();
    return getSettings();
  });

  ipcMain.handle('resolve-local-path', (_event, storedRelPath: string) => {
    const settings = getSettings();
    return absPathFromStored(settings, storedRelPath.replace(/\\/g, '/')) || null;
  });

  ipcMain.handle('test-connection', async (_event, serverUrl: string, apiKey: string) => {
    try {
      const api = new VaultApiClient({ serverUrl, apiKey });
      const result = await api.validateAuth();
      if (result.ok && result.value.authenticated) {
        return { ok: true };
      }
      return { ok: false, error: 'Authentication failed' };
    } catch (e: unknown) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle('get-queue', () => queueRepo.getAllQueueEntries());

  ipcMain.handle('get-file-tree', async () => {
    await new Promise<void>((resolve) => setImmediate(resolve));
    return fileTreeRepo.getAllFiles();
  });

  ipcMain.handle('open-folder', (_event, folderPath: string) => {
    if (fs.existsSync(folderPath)) shell.openPath(folderPath);
  });

  ipcMain.handle('download-file', async (_event, fileId: string, localRelPath: string) => {
    const settings = getSettings();
    if (!settings.serverUrl || !settings.apiKey) return { ok: false, error: 'Not authenticated' };

    const api = new VaultApiClient({ serverUrl: settings.serverUrl, apiKey: settings.apiKey });
    const absPath = absPathFromStored(settings, localRelPath.replace(/\\/g, '/'));
    if (!absPath) return { ok: false, error: 'Unknown local path' };

    try {
      const result = await api.downloadFile(fileId, localRelPath);
      if (!result.ok) return { ok: false, error: result.error.message };

      const dir = path.dirname(absPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(absPath, Buffer.from(result.value));

      fileTreeRepo.upsertFile(getDatabase(), {
        fileId, localRelPath,
        remotePath: '/' + localRelPath.replace(/\\/g, '/'),
        name: path.basename(localRelPath),
        size: result.value.byteLength,
        mimeType: null, isFolder: false,
        localMtimeMs: fs.statSync(absPath).mtimeMs,
        localHash: computeBufferHash(Buffer.from(result.value)),
        remoteHash: null, remoteUpdatedAt: null,
        syncStatus: 'synced', syncTaskId: null, syncError: null,
      });

      return { ok: true, size: result.value.byteLength };
    } catch (e: unknown) {
      return { ok: false, error: (e as Error).message };
    }
  });
}
