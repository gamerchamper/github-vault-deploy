const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const agentModule = require('./agent');
const { defaultDataDir, loadConfig } = require('./config');

const startAgent = (...args) => agentModule.startAgent(...args);
const stopAgent = (...args) => agentModule.stopAgent(...args);
const getAgentConfig = (...args) => agentModule.getAgentConfig(...args);

let activeDesktop = null;
let agentChild = null;

function resolveSystemNode() {
  if (process.env.FUTURE_VAULT_NODE) return process.env.FUTURE_VAULT_NODE;
  if (!process.versions.electron) return process.execPath;
  try {
    if (process.platform === 'win32') {
      return execSync('where node', { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
    }
    return execSync('which node', { encoding: 'utf8' }).trim();
  } catch {
    throw new Error(
      'Could not find Node.js for the Future Vault agent. Launch with `npm run future-vault:desktop` from the repo root.',
    );
  }
}

function resolveRepoRoot() {
  const devRoot = path.resolve(__dirname, '../..');
  const bundled = process.resourcesPath
    ? path.join(process.resourcesPath, 'github-vault')
    : null;
  if (bundled && fs.existsSync(path.join(bundled, 'server', 'services', 'plex-sidecar-db-repair.js'))) {
    return bundled;
  }
  return devRoot;
}

function spawnAgentProcess(port, opts = {}) {
  const nodePath = opts.nodePath || resolveSystemNode();
  const script = path.join(__dirname, 'agent-process.js');
  const repoRoot = opts.repoRoot || resolveRepoRoot();
  const child = (opts.spawn || spawn)(nodePath, [script, `--port=${port}`], {
    cwd: path.resolve(__dirname, '..'),
    stdio: opts.stdio || 'inherit',
    env: {
      ...process.env,
      GITHUB_VAULT_ROOT: repoRoot,
    },
  });
  agentChild = child;
  child.on('exit', () => {
    if (agentChild === child) agentChild = null;
  });
  return child;
}

async function waitForAgentHealth(url, opts = {}) {
  const timeoutMs = opts.timeoutMs || 30000;
  const fetchFn = opts.fetch || globalThis.fetch;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetchFn(`${url}/health`);
      if (res.ok) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Future Vault agent did not respond at ${url}`);
}

async function agentPost(config, apiPath, opts = {}) {
  const fetchFn = opts.fetch || globalThis.fetch;
  const res = await fetchFn(`${config.agent_url}${apiPath}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.api_key}`,
      'Content-Type': 'application/json',
    },
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: text.slice(0, 200) || res.statusText };
  }
}

function killAgentChildProcess(child) {
  if (!child || child.killed) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 5000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    if (process.platform === 'win32') {
      try {
        execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' });
      } catch {
        try { child.kill(); } catch {}
      }
    } else {
      child.kill('SIGTERM');
    }
  });
}

function loadElectron() {
  try {
    const electron = require('electron');
    if (!electron || typeof electron === 'string') {
      throw new Error('Electron APIs are only available inside the Electron runtime');
    }
    return electron;
  } catch (err) {
    if (err.message.includes('Electron APIs')) throw err;
    throw new Error('Electron is not installed. Run `npm run future-vault:install` from the project root.');
  }
}

function resolveElectronExecutable() {
  try {
    const electron = require('electron');
    if (typeof electron === 'string') return electron;
    if (electron && process.versions.electron) return process.execPath;
  } catch {}
  throw new Error('Electron is not installed. Run `npm run future-vault:install` from the project root.');
}

function startDesktopProcess(opts = {}) {
  const electronPath = opts.electronPath || resolveElectronExecutable();
  const args = [path.join(__dirname, 'desktop-main.js')];
  if (opts.port != null) args.push(`--port=${opts.port}`);
  return (opts.spawn || spawn)(electronPath, args, {
    cwd: path.resolve(__dirname, '..'),
    stdio: opts.stdio || 'inherit',
    env: {
      ...process.env,
      FUTURE_VAULT_NODE: opts.nodePath || process.execPath,
    },
  });
}

function trayIcon(electron) {
  const iconPath = path.join(__dirname, '..', 'assets', 'tray-icon.png');
  if (fs.existsSync(iconPath)) {
    return electron.nativeImage.createFromPath(iconPath);
  }
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="64" height="64">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#00e5ff"/><stop offset="100%" stop-color="#a855f7"/>
      </linearGradient></defs>
      <rect width="64" height="64" rx="14" fill="#0a0e1a"/>
      <path d="M32 10 L52 22 V42 L32 54 L12 42 V22 Z" fill="none" stroke="url(#g)" stroke-width="3"/>
      <circle cx="32" cy="32" r="7" fill="url(#g)"/>
    </svg>`;
  return electron.nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
  );
}

function setupDesktopIpc(electron, opts = {}) {
  const ipcMain = electron.ipcMain;
  if (!ipcMain || ipcMain._futureVaultBound) return;
  ipcMain._futureVaultBound = true;
  const readConfig = opts.getConfig || (() => getAgentConfig() || loadConfig());

  ipcMain.handle('fv:agent-info', async () => {
    const config = readConfig();
    return config ? {
      url: config.agent_url,
      api_key: config.api_key,
      library_path: config.plex_library_path,
    } : null;
  });

  ipcMain.handle('fv:sync', async () => {
    const config = readConfig();
    if (!config?.agent_url) return { ok: false, error: 'Agent not running' };
    return agentPost(config, '/api/sync', opts);
  });

  ipcMain.handle('fv:repair', async () => {
    const config = readConfig();
    if (!config?.agent_url) return { ok: false, error: 'Agent not running' };
    return agentPost(config, '/api/repair', opts);
  });
}

async function launchDesktop(opts = {}) {
  const electron = opts.electron || loadElectron();
  const app = electron.app;
  const BrowserWindow = electron.BrowserWindow;
  const Tray = electron.Tray;
  const Menu = electron.Menu;
  const logger = opts.logger || console;
  const port = opts.port == null ? 7420 : opts.port;

  if (typeof app.setPath === 'function') {
    const userData = path.join(defaultDataDir(), 'electron-profile');
    fs.mkdirSync(userData, { recursive: true });
    app.setPath('userData', userData);
  }

  if (typeof app.requestSingleInstanceLock === 'function' && !opts.allowMultiple) {
    const locked = app.requestSingleInstanceLock();
    if (!locked) {
      app.quit();
      return { app, window: null, alreadyRunning: true };
    }
    app.on('second-instance', () => {
      if (!activeDesktop?.window) return;
      const win = activeDesktop.window;
      if (win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.reloadIgnoringCache();
      }
      if (typeof win.restore === 'function' && win.isMinimized?.()) win.restore();
      win.show();
      win.focus();
    });
  }

  let mainWindow = null;
  let tray = null;
  let shuttingDown = false;
  let shutdownFn = async () => (opts.stopAgent || stopAgent)();

  app.on('window-all-closed', (event) => {
    event.preventDefault();
  });

  await app.whenReady();

  const start = opts.startAgent || startAgent;
  const useExternalAgent = !!process.versions.electron && !opts.startAgent;
  let agentUrl;

  if (useExternalAgent) {
    spawnAgentProcess(port, opts);
    const initialConfig = loadConfig();
    agentUrl = initialConfig.agent_url || `http://127.0.0.1:${port}`;
    await waitForAgentHealth(agentUrl, opts);
    shutdownFn = async () => {
      await killAgentChildProcess(agentChild);
      await (opts.stopAgent || stopAgent)();
    };
  } else {
    const agent = await start({ port });
    agentUrl = agent.url;
  }

  app.on('before-quit', (event) => {
    if (shuttingDown) return;
    event.preventDefault();
    shuttingDown = true;
    app.isQuitting = true;
    (async () => {
      if (tray) {
        tray.destroy();
        tray = null;
      }
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
      await shutdownFn();
      app.exit(0);
    })().catch((err) => {
      logger.error(err.stack || err.message);
      app.exit(1);
    });
  });

  setupDesktopIpc(electron, {
    ...opts,
    getConfig: () => loadConfig(),
  });

  const loadUrl = `${agentUrl}/?desktop=1`;
  logger.log(`Future Vault desktop loading ${loadUrl}`);

  mainWindow = new BrowserWindow({
    width: opts.width || 1320,
    height: opts.height || 900,
    minWidth: 960,
    minHeight: 680,
    title: 'Future Vault',
    backgroundColor: '#06080f',
    show: false,
    autoHideMenuBar: true,
    icon: trayIcon(electron),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: true,
    },
  });

  const desktop = { app, window: mainWindow, url: loadUrl, tray };
  activeDesktop = desktop;

  const revealWindow = () => {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.focus();
  };

  mainWindow.once('ready-to-show', revealWindow);
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('hide', () => {
    if (mainWindow?.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.setBackgroundThrottling(true);
      mainWindow.webContents.executeJavaScript('window.__fvPauseDashboard && window.__fvPauseDashboard()').catch(() => {});
    }
  });
  mainWindow.on('show', () => {
    if (mainWindow?.webContents && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.setBackgroundThrottling(false);
      mainWindow.webContents.executeJavaScript('window.__fvResumeDashboard && window.__fvResumeDashboard()').catch(() => {});
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    desktop.window = null;
  });

  await mainWindow.loadURL(loadUrl);
  if (mainWindow && !mainWindow.isVisible()) revealWindow();

  const showWindow = () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  };

  tray = new Tray(trayIcon(electron));
  tray.setToolTip('Future Vault — local Plex agent');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Future Vault', click: showWindow },
    { type: 'separator' },
    {
      label: 'Sync library',
      click: async () => {
        const config = loadConfig();
        await agentPost(config, '/api/sync', opts);
      },
    },
    {
      label: 'Repair Plex DB',
      click: async () => {
        const config = loadConfig();
        await agentPost(config, '/api/repair', opts);
      },
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]));
  tray.on('double-click', showWindow);
  desktop.tray = tray;

  return desktop;
}

if (require.main === module && !process.versions.electron) {
  const portArg = process.argv.find((arg) => arg.startsWith('--port='));
  startDesktopProcess({
    port: portArg ? parseInt(portArg.slice('--port='.length), 10) : 7420,
  });
}

module.exports = {
  launchDesktop,
  loadElectron,
  resolveElectronExecutable,
  resolveSystemNode,
  spawnAgentProcess,
  waitForAgentHealth,
  killAgentChildProcess,
  agentPost,
  startDesktopProcess,
  setupDesktopIpc,
};
