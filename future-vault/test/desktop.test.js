const { expect } = require('chai');
const path = require('path');
const { setupDesktopIpc, launchDesktop } = require('../src/desktop');

function createFakeElectron() {
  const handlers = {};
  const instances = [];
  const BrowserWindow = class {
      constructor(opts) {
        this.opts = opts;
        this.webContents = {
          isDestroyed: () => false,
          reloadIgnoringCache: () => {},
          on() {},
        };
        this._visible = false;
        instances.push(this);
      }
      once() {}
      on() {}
      show() { this._visible = true; }
      focus() {}
      isVisible() { return this._visible; }
      isMinimized() { return false; }
      loadURL() { return Promise.resolve(); }
      hide() {}
    };
  BrowserWindow.instances = instances;
  return {
    ipcMain: {
      _futureVaultBound: false,
      handle(channel, fn) { handlers[channel] = fn; },
      handlers,
    },
    nativeImage: {
      createFromPath: () => ({ isEmpty: () => false }),
      createFromDataURL: () => ({ isEmpty: () => false }),
    },
    app: {
      isQuitting: false,
      paths: {},
      setPath(name, value) { this.paths[name] = value; },
      requestSingleInstanceLock: () => true,
      whenReady: async () => {},
      on() {},
      quit() {},
    },
    BrowserWindow,
    Tray: class {
      constructor() {}
      setToolTip() {}
      setContextMenu() {}
      on() {}
      destroy() {}
    },
    Menu: {
      buildFromTemplate: (items) => items,
    },
  };
}

describe('future-vault desktop', () => {
  it('registers IPC handlers for sync and repair', () => {
    const electron = createFakeElectron();
    setupDesktopIpc(electron);
    expect(electron.ipcMain.handlers['fv:sync']).to.be.a('function');
    expect(electron.ipcMain.handlers['fv:repair']).to.be.a('function');
  });

  it('prepares a native window with hardened webPreferences', async function () {
    this.timeout(10000);
    const electron = createFakeElectron();

    const desktop = await launchDesktop({
      electron,
      port: 17420,
      log: false,
      startAgent: async () => ({
        url: 'http://127.0.0.1:17420',
        config: { agent_url: 'http://127.0.0.1:17420', api_key: 'fv_test' },
        server: { close(fn) { fn(); } },
      }),
      stopAgent: async () => {},
    });
    const win = electron.BrowserWindow.instances[0];
    expect(win.opts.webPreferences.contextIsolation).to.equal(true);
    expect(win.opts.webPreferences.nodeIntegration).to.equal(false);
    expect(win.opts.webPreferences.preload).to.include('preload.js');
    expect(desktop.url).to.include('127.0.0.1:17420');
  });
});
