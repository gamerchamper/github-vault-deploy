const { expect } = require('chai');
const EventEmitter = require('events');
const { launchDesktop, startDesktopProcess, setupDesktopIpc, getActiveDesktop } = require('../src/desktop');

function createFakeElectron() {
  const app = new EventEmitter();
  app.whenReady = async () => {};
  app.quitCalled = false;
  app.quit = () => { app.quitCalled = true; };
  app.paths = {};
  app.setPath = (name, value) => { app.paths[name] = value; };
  app.requestSingleInstanceLock = () => true;
  const ipcMain = { handlers: {}, handle(name, fn) { this.handlers[name] = fn; } };
  const dialog = { async showOpenDialog() { return { canceled: false, filePaths: ['C:\\big.bin'] }; } };

  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.loadedUrl = null;
      this.visible = false;
      this.focused = false;
      this.movedTop = false;
      this.alwaysOnTop = [];
      this.webContents = new EventEmitter();
      BrowserWindow.instances.push(this);
    }

    async loadURL(url) {
      this.loadedUrl = url;
      process.nextTick(() => this.emit('ready-to-show'));
    }

    show() {
      this.visible = true;
    }

    focus() {
      this.focused = true;
    }

    moveTop() {
      this.movedTop = true;
    }

    setAlwaysOnTop(value) {
      this.alwaysOnTop.push(value);
    }

    isVisible() {
      return this.visible;
    }
  }
  BrowserWindow.instances = [];

  return { app, BrowserWindow, ipcMain, dialog };
}

describe('desktop launcher', function () {
  it('should open the local UI in a hardened native window', async function () {
    const electron = createFakeElectron();
    const desktop = await launchDesktop({ electron, port: 0 });
    const win = electron.BrowserWindow.instances[0];

    expect(desktop.url).to.match(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(win.loadedUrl).to.equal(desktop.url);
    expect(win.options.webPreferences.nodeIntegration).to.equal(false);
    expect(win.options.webPreferences.contextIsolation).to.equal(true);
    expect(win.options.webPreferences.sandbox).to.equal(true);
    expect(win.options.autoHideMenuBar).to.equal(true);
    expect(win.options.webPreferences.preload).to.match(/preload\.js$/);
    expect(electron.app.paths.userData).to.match(/electron-profile$/);
    expect(getActiveDesktop().window).to.equal(win);
    expect(win.visible).to.equal(true);
    expect(win.focused).to.equal(true);
    expect(win.movedTop).to.equal(true);
    expect(win.alwaysOnTop).to.include(true);

    desktop.server.close();
  });

  it('should close the local UI server when the app quits', async function () {
    const electron = createFakeElectron();
    const desktop = await launchDesktop({ electron, port: 0 });

    expect(desktop.server.listening).to.equal(true);
    electron.app.emit('before-quit');

    await new Promise(resolve => setTimeout(resolve, 20));
    expect(desktop.server.listening).to.equal(false);
  });

  it('should withstand many concurrent native launch preparations', async function () {
    const launches = [];
    for (let i = 0; i < 25; i++) {
      launches.push(launchDesktop({ electron: createFakeElectron(), port: 0 }));
    }

    const desktops = await Promise.all(launches);
    const urls = new Set(desktops.map(d => d.url));
    expect(urls.size).to.equal(desktops.length);
    expect(desktops.every(d => d.server.listening)).to.equal(true);

    await Promise.all(desktops.map(d => new Promise(resolve => d.server.close(resolve))));
  });

  it('should spawn the Electron runtime from the CLI launcher', function () {
    let captured = null;
    const child = new EventEmitter();
    const result = startDesktopProcess({
      electronPath: 'electron-test-bin',
      host: '127.0.0.1',
      port: 0,
      stdio: 'pipe',
      spawn: (cmd, args, options) => {
        captured = { cmd, args, options };
        return child;
      },
    });

    expect(result).to.equal(child);
    expect(captured.cmd).to.equal('electron-test-bin');
    expect(captured.args[0]).to.match(/desktop-main\.js$/);
    expect(captured.args).to.include('--host=127.0.0.1');
    expect(captured.args).to.include('--port=0');
    expect(captured.options.stdio).to.equal('pipe');
  });

  it('should expose a native file picker through IPC', async function () {
    const electron = createFakeElectron();
    setupDesktopIpc(electron);

    expect(electron.ipcMain.handlers['vault:select-file']).to.be.a('function');
    const result = await electron.ipcMain.handlers['vault:select-file']();
    expect(result.canceled).to.equal(false);
    expect(result.filePath).to.equal('C:\\big.bin');
  });

  it('should quit when another desktop instance owns the lock', async function () {
    const electron = createFakeElectron();
    electron.app.requestSingleInstanceLock = () => false;
    const desktop = await launchDesktop({ electron, port: 0 });

    expect(desktop.alreadyRunning).to.equal(true);
    expect(electron.app.quitCalled).to.equal(true);
    expect(electron.BrowserWindow.instances).to.have.length(0);
  });

  it('should forward renderer console messages to the launcher logger', async function () {
    const electron = createFakeElectron();
    const logs = [];
    const desktop = await launchDesktop({ electron, port: 0, logger: { log: (msg) => logs.push(msg), error: (msg) => logs.push(msg) } });
    const win = electron.BrowserWindow.instances[0];

    win.webContents.emit('console-message', {}, 2, 'button clicked', 12, 'ui');
    expect(logs.some(msg => msg.includes('button clicked'))).to.equal(true);
    desktop.server.close();
  });
});
