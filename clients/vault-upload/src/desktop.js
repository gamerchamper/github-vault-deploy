const { listenUiServer } = require('./ui-server');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { CONFIG_DIR } = require('./config');

let activeDesktop = null;

function loadElectron() {
  try {
    const electron = require('electron');
    if (!electron || typeof electron === 'string') {
      throw new Error('Electron APIs are only available inside the Electron runtime');
    }
    return electron;
  } catch (err) {
    if (err.message.includes('Electron APIs')) throw err;
    throw new Error('Electron is not installed. Run `npm run client:install` from the project root.');
  }
}

function resolveElectronExecutable() {
  try {
    const electron = require('electron');
    if (typeof electron === 'string') return electron;
    if (electron && process.versions.electron) return process.execPath;
  } catch {}
  throw new Error('Electron is not installed. Run `npm run client:install` from the project root.');
}

function startDesktopProcess(opts = {}) {
  const electronPath = opts.electronPath || resolveElectronExecutable();
  const args = [path.join(__dirname, 'desktop-main.js')];
  if (opts.host) args.push(`--host=${opts.host}`);
  if (opts.port != null) args.push(`--port=${opts.port}`);
  const child = (opts.spawn || spawn)(electronPath, args, {
    cwd: path.resolve(__dirname, '..'),
    stdio: opts.stdio || 'inherit',
    env: process.env,
  });
  return child;
}

function setupDesktopIpc(electron, opts = {}) {
  const ipcMain = electron.ipcMain;
  const dialog = electron.dialog;
  if (!ipcMain || !dialog || ipcMain._vaultUploadBound) return;
  ipcMain._vaultUploadBound = true;
  ipcMain.handle('vault:select-file', async () => {
    const result = await dialog.showOpenDialog({
      title: 'Choose files to upload',
      properties: ['openFile', 'multiSelections'],
    });
    const filePaths = result.canceled ? [] : (result.filePaths || []);
    return {
      canceled: !!result.canceled,
      filePaths,
      filePath: filePaths[0] || null,
    };
  });
}

async function launchDesktop(opts = {}) {
  const electron = opts.electron || loadElectron();
  const app = electron.app;
  const BrowserWindow = electron.BrowserWindow;
  const logger = opts.logger || console;
  const host = opts.host || '127.0.0.1';
  const port = opts.port == null ? 0 : opts.port;
  let ui = null;
  let mainWindow = null;

  if (typeof app.setPath === 'function') {
    const userData = path.join(CONFIG_DIR, 'electron-profile');
    fs.mkdirSync(userData, { recursive: true });
    app.setPath('userData', userData);
  }

  if (typeof app.requestSingleInstanceLock === 'function' && !opts.allowMultiple) {
    const locked = app.requestSingleInstanceLock();
    if (!locked) {
      app.quit();
      return { app, window: null, server: null, url: null, alreadyRunning: true };
    }
    app.on('second-instance', () => {
      if (!mainWindow) return;
      if (typeof mainWindow.restore === 'function' && mainWindow.isMinimized?.()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    });
  }

  const shutdownServer = () => {
    if (ui && ui.server.listening) {
      ui.server.close(() => {});
    }
  };

  app.on('window-all-closed', () => {
    shutdownServer();
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', shutdownServer);

  await app.whenReady();
  setupDesktopIpc(electron, opts);
  ui = await listenUiServer({ host, port });
  if (opts.log !== false) logger.log(`Vault Upload desktop loading ${ui.url}`);

  mainWindow = new BrowserWindow({
    width: opts.width || 1280,
    height: opts.height || 860,
    minWidth: 940,
    minHeight: 680,
    title: 'Vault Upload',
    backgroundColor: '#070910',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });

  const desktop = { app, window: mainWindow, server: ui.server, url: ui.url };
  activeDesktop = desktop;

  const revealWindow = () => {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
    if (typeof mainWindow.moveTop === 'function') mainWindow.moveTop();
    if (typeof mainWindow.setAlwaysOnTop === 'function') {
      mainWindow.setAlwaysOnTop(true);
      setTimeout(() => {
        if (mainWindow) mainWindow.setAlwaysOnTop(false);
      }, 1200);
    }
  };

  mainWindow.once('ready-to-show', revealWindow);
  if (mainWindow.webContents) {
    mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
      logger.log(`[Vault Upload renderer:${level}] ${message}${sourceId ? ` (${sourceId}:${line})` : ''}`);
    });
    mainWindow.webContents.on('render-process-gone', (event, details) => {
      logger.error(`[Vault Upload renderer gone] ${details?.reason || 'unknown'}`);
    });
    mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription, validatedURL) => {
      logger.error(`[Vault Upload load failed] ${errorCode} ${errorDescription} ${validatedURL || ''}`);
    });
  }
  mainWindow.on('closed', () => {
    mainWindow = null;
    desktop.window = null;
    if (activeDesktop === desktop) activeDesktop.window = null;
  });
  await mainWindow.loadURL(ui.url);
  if (mainWindow && !mainWindow.isVisible()) revealWindow();

  return desktop;
}

if (require.main === module && !process.versions.electron) {
  const portArg = process.argv.find(arg => arg.startsWith('--port='));
  const hostArg = process.argv.find(arg => arg.startsWith('--host='));
  startDesktopProcess({
    port: portArg ? parseInt(portArg.slice('--port='.length), 10) : 0,
    host: hostArg ? hostArg.slice('--host='.length) : '127.0.0.1',
  });
}

function getActiveDesktop() {
  return activeDesktop;
}

module.exports = { launchDesktop, loadElectron, resolveElectronExecutable, startDesktopProcess, setupDesktopIpc, getActiveDesktop };
