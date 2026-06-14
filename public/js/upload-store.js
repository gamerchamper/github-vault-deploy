const UploadStore = {
  DB_NAME: 'vault-uploads',
  STORE: 'sessions',
  VERSION: 1,

  async open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(this.STORE)) {
          db.createObjectStore(this.STORE, { keyPath: 'taskId' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  },

  async save(session) {
    const db = await this.open();
    const { file, ...meta } = session;
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE, 'readwrite');
      tx.objectStore(this.STORE).put(meta);
      tx.oncomplete = () => resolve(session);
      tx.onerror = () => reject(tx.error || new Error('Failed to save upload session'));
    });
  },

  async get(taskId) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE, 'readonly');
      const req = tx.objectStore(this.STORE).get(taskId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  },

  async remove(taskId) {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE, 'readwrite');
      tx.objectStore(this.STORE).delete(taskId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },

  async list() {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.STORE, 'readonly');
      const req = tx.objectStore(this.STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  },

  async createFromFile(file, parentPath, chunkSize, uploadMode = 'api', convertHls = false) {
    const taskId = `upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const session = {
      taskId,
      fileId: null,
      fileName: file.name,
      fileSize: file.size,
      mimeType: file.type || 'application/octet-stream',
      parentPath: parentPath || '/',
      chunkSize,
      uploadMode: uploadMode === 'git' ? 'git' : uploadMode === 'seamless' ? 'seamless' : 'api',
      convertHls,
      totalChunks: 0,
      chunksDone: 0,
      status: 'pending',
      error: null,
      createdAt: Date.now(),
    };
    await this.save(session);
    return { ...session, file };
  },

  async listInterrupted() {
    const sessions = await this.list();
    return sessions.filter((s) => ['error', 'uploading', 'pending', 'paused'].includes(s.status));
  },
};
