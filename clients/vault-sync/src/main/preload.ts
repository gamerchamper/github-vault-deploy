import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('vaultSync', {
  getSettings: (): Promise<unknown> => ipcRenderer.invoke('get-settings'),
  updateSettings: (patch: Record<string, unknown>): Promise<unknown> => ipcRenderer.invoke('update-settings', patch),
  getSyncState: (): Promise<unknown> => ipcRenderer.invoke('get-sync-state'),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('pick-folder'),
  testConnection: (serverUrl: string, apiKey: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('test-connection', serverUrl, apiKey),
  getQueue: (): Promise<unknown[]> => ipcRenderer.invoke('get-queue'),
  getFileTree: (): Promise<unknown[]> => ipcRenderer.invoke('get-file-tree'),
  openFolder: (path: string): Promise<void> => ipcRenderer.invoke('open-folder', path),
  downloadFile: (fileId: string, localRelPath: string): Promise<{ ok: boolean; size?: number; error?: string }> =>
    ipcRenderer.invoke('download-file', fileId, localRelPath),

  onSyncState: (cb: (state: unknown) => void): (() => void) => {
    const handler = (_event: unknown, state: unknown) => cb(state);
    ipcRenderer.on('sync-state', handler);
    return () => ipcRenderer.removeListener('sync-state', handler);
  },

  onUploadProgress: (cb: (p: unknown) => void): (() => void) => {
    const handler = (_event: unknown, p: unknown) => cb(p);
    ipcRenderer.on('upload-progress', handler);
    return () => ipcRenderer.removeListener('upload-progress', handler);
  },

  onLog: (cb: (log: unknown) => void): (() => void) => {
    const handler = (_event: unknown, log: unknown) => cb(log);
    ipcRenderer.on('log', handler);
    return () => ipcRenderer.removeListener('log', handler);
  },
});
