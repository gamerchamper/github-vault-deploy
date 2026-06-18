"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
electron_1.contextBridge.exposeInMainWorld('vaultSync', {
    getSettings: () => electron_1.ipcRenderer.invoke('get-settings'),
    updateSettings: (patch) => electron_1.ipcRenderer.invoke('update-settings', patch),
    getSyncState: () => electron_1.ipcRenderer.invoke('get-sync-state'),
    pickFolder: () => electron_1.ipcRenderer.invoke('pick-folder'),
    testConnection: (serverUrl, apiKey) => electron_1.ipcRenderer.invoke('test-connection', serverUrl, apiKey),
    getQueue: () => electron_1.ipcRenderer.invoke('get-queue'),
    getFileTree: () => electron_1.ipcRenderer.invoke('get-file-tree'),
    openFolder: (path) => electron_1.ipcRenderer.invoke('open-folder', path),
    downloadFile: (fileId, localRelPath) => electron_1.ipcRenderer.invoke('download-file', fileId, localRelPath),
    onSyncState: (cb) => {
        const handler = (_event, state) => cb(state);
        electron_1.ipcRenderer.on('sync-state', handler);
        return () => electron_1.ipcRenderer.removeListener('sync-state', handler);
    },
    onUploadProgress: (cb) => {
        const handler = (_event, p) => cb(p);
        electron_1.ipcRenderer.on('upload-progress', handler);
        return () => electron_1.ipcRenderer.removeListener('upload-progress', handler);
    },
    onLog: (cb) => {
        const handler = (_event, log) => cb(log);
        electron_1.ipcRenderer.on('log', handler);
        return () => electron_1.ipcRenderer.removeListener('log', handler);
    },
});
//# sourceMappingURL=preload.js.map