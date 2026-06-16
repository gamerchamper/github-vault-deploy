/**
 * Write Plex STRM manifest to a local folder via File System Access API.
 */
const PlexLocalSync = {
  supported() {
    return typeof window.showDirectoryPicker === 'function';
  },

  /** Call showDirectoryPicker synchronously — only valid during a user click. */
  requestFolderPicker() {
    if (!this.supported()) {
      throw new Error('Use Chrome or Edge on desktop to write files to a local folder.');
    }
    return window.showDirectoryPicker({ mode: 'readwrite', id: 'github-vault-plex' });
  },

  /**
   * Inline onclick entry point — keeps the picker inside the browser user-gesture window
   * (required when Cloudflare Rocket Loader defers addEventListener handlers).
   */
  beginWriteFromClick(event) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    if (!this.supported()) {
      window.App?.toast('Use Chrome or Edge on desktop to write files to a local folder', 'error');
      return false;
    }
    let folderPromise;
    try {
      folderPromise = this.requestFolderPicker();
    } catch (err) {
      window.App?.toast(err.message, 'error');
      return false;
    }
    const btn = document.getElementById('btn-sync-plex-local');
    window.App?.continuePlexLocalSync(folderPromise, btn);
    return false;
  },

  async getDirectory(dirHandle, parts, { create = false } = {}) {
    let current = dirHandle;
    for (const part of parts) {
      current = await current.getDirectoryHandle(part, create ? { create: true } : undefined);
    }
    return current;
  },

  async writeEntry(rootHandle, entry) {
    const parts = String(entry.path || '').split('/').filter(Boolean);
    if (!parts.length) return;
    const fileName = parts.pop();
    const dirHandle = parts.length
      ? await this.getDirectory(rootHandle, parts, { create: true })
      : rootHandle;
    const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(entry.content || '');
    await writable.close();
  },

  async applyManifest(manifest, rootHandle) {
    const entries = manifest?.entries || [];
    for (const entry of entries) {
      await this.writeEntry(rootHandle, entry);
    }
    const metaHandle = await rootHandle.getFileHandle('.vault-plex-sync.json', { create: true });
    const writable = await metaHandle.createWritable();
    await writable.write(`${JSON.stringify({
      vault_url: manifest.vault_url,
      synced_at: new Date().toISOString(),
      files: manifest.keep_paths || entries.map((e) => e.path),
      stats: manifest.stats,
      local_browser_sync: true,
    }, null, 2)}\n`);
    await writable.close();
    return entries.length;
  },
};

window.PlexLocalSync = PlexLocalSync;
