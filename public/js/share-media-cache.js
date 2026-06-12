const ShareMediaCache = {
  DB_NAME: 'vault-share-media',
  STORE_MEDIA: 'media',
  STORE_MANIFESTS: 'manifests',
  STORE_CHUNKS: 'chunks',
  STORE_ENC_CHUNKS: 'enc_chunks',
  VERSION: 3,
  MAX_ENTRIES: 48,
  MAX_BYTES: 8 * 1024 * 1024 * 1024,

  cacheKey(token, fileId) {
    return `${token}:${fileId || 'root'}`;
  },

  chunkKey(mediaKey, index) {
    return `${mediaKey}:${index}`;
  },

  fingerprint(manifest) {
    if (!manifest) return '';
    const chunkSig = (manifest.chunks || [])
      .map((c) => `${c.plain_size}:${c.encrypted_size}:${c.iv || ''}:${c.tag || ''}:${c.raw_url || ''}`)
      .join('|');
    return `${manifest.size}:${manifest.chunk_count}:${manifest.encryption_mode || 'chunk'}:${chunkSig}`;
  },

  infoFromManifest(manifest, extra = {}) {
    if (!manifest) return null;
    return {
      id: manifest.id,
      name: manifest.name,
      size: manifest.size,
      mime_type: manifest.mime_type,
      chunk_count: manifest.chunk_count || manifest.chunks?.length || 0,
      has_thumbnail: !!extra.has_thumbnail,
      hls_available: manifest.hls_available || !!manifest.hls_playlist_url,
      hls_playlist_url: manifest.hls_playlist_url || null,
      is_folder: false,
      client_stream: true,
      offline: true,
      ...extra,
    };
  },

  supported() {
    return typeof indexedDB !== 'undefined';
  },

  async open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.STORE_MEDIA)) {
          const store = db.createObjectStore(this.STORE_MEDIA, { keyPath: 'key' });
          store.createIndex('cachedAt', 'cachedAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(this.STORE_MANIFESTS)) {
          const store = db.createObjectStore(this.STORE_MANIFESTS, { keyPath: 'key' });
          store.createIndex('cachedAt', 'cachedAt', { unique: false });
        }
        if (!db.objectStoreNames.contains(this.STORE_CHUNKS)) {
          db.createObjectStore(this.STORE_CHUNKS, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(this.STORE_ENC_CHUNKS)) {
          db.createObjectStore(this.STORE_ENC_CHUNKS, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },

  async getMedia(key, fingerprint) {
    if (!this.supported()) return null;
    try {
      const db = await this.open();
      const entry = await new Promise((resolve, reject) => {
        const tx = db.transaction(this.STORE_MEDIA, 'readonly');
        const req = tx.objectStore(this.STORE_MEDIA).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
      if (!entry?.blob) return null;
      if (fingerprint && entry.fingerprint !== fingerprint) {
        return null;
      }
      return entry;
    } catch {
      return null;
    }
  },

  async get(key, fingerprint) {
    return this.getMedia(key, fingerprint);
  },

  async putMedia(key, fingerprint, blob, meta = {}) {
    if (!this.supported() || !blob) return;
    try {
      await this.evictIfNeeded(blob.size);
      const db = await this.open();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(this.STORE_MEDIA, 'readwrite');
        tx.objectStore(this.STORE_MEDIA).put({
          key,
          fingerprint,
          blob,
          size: blob.size,
          mimeType: meta.mimeType || blob.type || 'application/octet-stream',
          name: meta.name || '',
          token: meta.token || null,
          fileId: meta.fileId || null,
          cachedAt: Date.now(),
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      /* cache is best-effort */
    }
  },

  async put(key, fingerprint, blob, meta = {}) {
    return this.putMedia(key, fingerprint, blob, meta);
  },

  async getManifest(key) {
    if (!this.supported()) return null;
    try {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(this.STORE_MANIFESTS, 'readonly');
        const req = tx.objectStore(this.STORE_MANIFESTS).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    } catch {
      return null;
    }
  },

  async putManifest(key, { manifest, info, token, fileId }) {
    if (!this.supported() || !manifest) return;
    try {
      const db = await this.open();
      const fingerprint = this.fingerprint(manifest);
      await new Promise((resolve, reject) => {
        const tx = db.transaction(this.STORE_MANIFESTS, 'readwrite');
        tx.objectStore(this.STORE_MANIFESTS).put({
          key,
          manifest,
          info: info || this.infoFromManifest(manifest),
          token,
          fileId: fileId || null,
          fingerprint,
          cachedAt: Date.now(),
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      /* ignore */
    }
  },

  async getInfo(token, fileId) {
    const entry = await this.getManifest(this.cacheKey(token, fileId));
    return entry?.info || this.infoFromManifest(entry?.manifest) || null;
  },

  async putChunk(mediaKey, index, bytes) {
    if (!this.supported() || !bytes) return;
    try {
      const db = await this.open();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(this.STORE_CHUNKS, 'readwrite');
        tx.objectStore(this.STORE_CHUNKS).put({
          id: this.chunkKey(mediaKey, index),
          mediaKey,
          index,
          bytes,
          cachedAt: Date.now(),
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      /* ignore */
    }
  },

  async getChunk(mediaKey, index) {
    if (!this.supported()) return null;
    try {
      const db = await this.open();
      const row = await new Promise((resolve, reject) => {
        const tx = db.transaction(this.STORE_CHUNKS, 'readonly');
        const req = tx.objectStore(this.STORE_CHUNKS).get(this.chunkKey(mediaKey, index));
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
      return row?.bytes || null;
    } catch {
      return null;
    }
  },

  async putEncChunk(mediaKey, index, bytes) {
    if (!this.supported() || !bytes) return;
    try {
      const db = await this.open();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(this.STORE_ENC_CHUNKS, 'readwrite');
        tx.objectStore(this.STORE_ENC_CHUNKS).put({
          id: this.chunkKey(mediaKey, index),
          mediaKey,
          index,
          bytes,
          cachedAt: Date.now(),
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      /* ignore */
    }
  },

  async getEncChunk(mediaKey, index) {
    if (!this.supported()) return null;
    try {
      const db = await this.open();
      const row = await new Promise((resolve, reject) => {
        const tx = db.transaction(this.STORE_ENC_CHUNKS, 'readonly');
        const req = tx.objectStore(this.STORE_ENC_CHUNKS).get(this.chunkKey(mediaKey, index));
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
      return row?.bytes || null;
    } catch {
      return null;
    }
  },

  countCachedChunks(mediaKey, total) {
    return this.listChunkIndexes(mediaKey, total);
  },

  async listChunkIndexes(mediaKey, total) {
    if (!this.supported()) return 0;
    let count = 0;
    for (let i = 0; i < total; i++) {
      const dec = await this.getChunk(mediaKey, i);
      if (dec) { count += 1; continue; }
      const enc = await this.getEncChunk(mediaKey, i);
      if (enc) count += 1;
    }
    return count;
  },

  async listMediaEntries() {
    if (!this.supported()) return [];
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE_MEDIA, 'readonly');
      const req = tx.objectStore(this.STORE_MEDIA).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },

  async evictIfNeeded(incomingSize) {
    let entries = await this.listMediaEntries();
    entries.sort((a, b) => (a.cachedAt || 0) - (b.cachedAt || 0));

    let total = entries.reduce((sum, e) => sum + (e.size || 0), 0) + incomingSize;
    while (entries.length >= this.MAX_ENTRIES || total > this.MAX_BYTES) {
      const oldest = entries.shift();
      if (!oldest) break;
      total -= oldest.size || 0;
      await this.removeMedia(oldest.key);
    }
  },

  async removeMedia(key) {
    if (!this.supported()) return;
    try {
      const db = await this.open();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(this.STORE_MEDIA, 'readwrite');
        tx.objectStore(this.STORE_MEDIA).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch {
      /* ignore */
    }
  },

  async remove(key) {
    return this.removeMedia(key);
  },
};
