const fs = require('fs');
const path = require('path');
const { SESSION_DIR, ensureDirs } = require('./config');

class SessionStore {
  static _path(taskId) {
    return path.join(SESSION_DIR, `${taskId.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  }

  static create(taskId, file) {
    ensureDirs();
    const session = {
      taskId,
      fileId: null,
      fileName: file.name || path.basename(file.path || file.name || 'unknown'),
      filePath: file.path || file.name,
      fileSize: file.size || 0,
      mimeType: file.mimeType || file.mime_type || 'application/octet-stream',
      parentPath: file.parentPath || '/',
      chunkSize: file.chunkSize || 0,
      uploadMode: file.uploadMode || 'api',
      convertHls: !!file.convertHls,
      totalChunks: 0,
      chunksDone: 0,
      status: 'pending',
      error: null,
      createdAt: Date.now(),
    };
    this.save(session);
    return session;
  }

  static get(taskId) {
    const p = this._path(taskId);
    try {
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf-8'));
    } catch {}
    return null;
  }

  static save(session) {
    ensureDirs();
    const data = { ...session };
    delete data.fileBuffer;
    fs.writeFileSync(this._path(session.taskId), JSON.stringify(data, null, 2), 'utf-8');
  }

  static remove(taskId) {
    const p = this._path(taskId);
    try { fs.unlinkSync(p); } catch {}
  }

  static list() {
    ensureDirs();
    const sessions = [];
    try {
      for (const f of fs.readdirSync(SESSION_DIR)) {
        if (!f.endsWith('.json')) continue;
        try {
          const s = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, f), 'utf-8'));
          sessions.push(s);
        } catch {}
      }
    } catch {}
    return sessions;
  }

  static listInterrupted() {
    return this.list().filter(s =>
      ['error', 'uploading', 'pending', 'paused'].includes(s.status)
    );
  }

  static generateTaskId() {
    const ts = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    return `vault-cli-${ts}-${rand}`;
  }
}

module.exports = { SessionStore };
