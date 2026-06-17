const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('futureVaultDesktop', {
  platform: process.platform,
  syncNow: () => ipcRenderer.invoke('fv:sync'),
  repairNow: () => ipcRenderer.invoke('fv:repair'),
  getAgentInfo: () => ipcRenderer.invoke('fv:agent-info'),
});
