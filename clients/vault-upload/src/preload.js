const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vaultDesktop', {
  selectFile: () => ipcRenderer.invoke('vault:select-file'),
  platform: process.platform,
});
