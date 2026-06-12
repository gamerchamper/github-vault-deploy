const fetch = require('node-fetch');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const KEEPALIVE_AGENT = new http.Agent({ keepAlive: true, maxSockets: 50, timeout: 600000 });
const KEEPALIVE_AGENT_HTTPS = new https.Agent({ keepAlive: true, maxSockets: 50, timeout: 600000 });

class VaultApiError extends Error {
  constructor(status, body, url) {
    super(typeof body === 'string' ? body : (body && body.error) || `HTTP ${status}`);
    this.name = 'VaultApiError';
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

class VaultApi {
  constructor(baseUrl, cookieOrOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    const options = typeof cookieOrOptions === 'object' && cookieOrOptions !== null
      ? cookieOrOptions
      : { cookie: cookieOrOptions };
    this.cookie = options.cookie || '';
    this.apiKey = options.apiKey || '';
    this.agent = options.agent || null;
    this.defaultHeaders = {
      'Accept': 'application/json',
      'Connection': 'keep-alive',
    };
    if (this.cookie) this.defaultHeaders.Cookie = this.cookie;
    if (this.apiKey) this.defaultHeaders.Authorization = `Bearer ${this.apiKey}`;
  }

  _url(path) {
    return `${this.baseUrl}${path}`;
  }

  async _fetch(method, urlPath, opts = {}) {
    const url = this._url(urlPath);
    const headers = { ...this.defaultHeaders, ...opts.headers };
    const agent = this.agent || (url.startsWith('https') ? KEEPALIVE_AGENT_HTTPS : KEEPALIVE_AGENT);
    const res = await fetch(url, {
      method,
      headers,
      body: opts.body,
      signal: opts.signal,
      timeout: opts.timeout || 60000,
      agent,
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    if (!res.ok) {
      if (res.status === 401) {
        throw new VaultApiError(401, { error: 'Not authenticated — run `vault-upload auth` first' }, url);
      }
      throw new VaultApiError(res.status, body, url);
    }
    return body;
  }

  async plan(size, chunkSize) {
    return this._fetch('POST', '/api/files/plan', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ size, chunkSize }),
    });
  }

  async uploadInit({ fileName, parentPath, size, mimeType, chunkSize, fileId, taskId, uploadMode, convertHls }) {
    return this._fetch('POST', '/api/files/upload/init', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileName, parentPath, size, mimeType,
        chunkSize: chunkSize || undefined,
        fileId: fileId || undefined,
        taskId: taskId || undefined,
        uploadMode: uploadMode || 'api',
        convertHls: !!convertHls,
      }),
    });
  }

  async uploadChunk(fileId, chunkIndex, buffer, taskId, uploadMode, signal) {
    const form = new FormData();
    form.append('fileId', fileId);
    form.append('chunkIndex', String(chunkIndex));
    form.append('uploadMode', uploadMode || 'api');
    if (taskId) form.append('taskId', taskId);
    form.append('chunk', buffer, {
      filename: `chunk-${chunkIndex}`,
      contentType: 'application/octet-stream',
    });
    const headers = { ...this.defaultHeaders, ...form.getHeaders() };
    return this._fetch('POST', '/api/files/upload/chunk', {
      headers,
      body: form,
      signal,
      timeout: 600000,
    });
  }

  async uploadComplete(fileId, taskId, previewBuffer, uploadMode, convertHls, contentHash) {
    const form = new FormData();
    form.append('fileId', fileId);
    form.append('uploadMode', uploadMode || 'api');
    form.append('convertHls', convertHls ? '1' : '0');
    if (taskId) form.append('taskId', taskId);
    if (contentHash) form.append('contentHash', contentHash);
    if (previewBuffer) {
      form.append('preview', previewBuffer, {
        filename: 'preview',
        contentType: 'application/octet-stream',
      });
    }
    const headers = { ...this.defaultHeaders, ...form.getHeaders() };
    return this._fetch('POST', '/api/files/upload/complete', {
      headers,
      body: form,
      timeout: 600000,
    });
  }

  async uploadCancel(fileId, taskId) {
    return this._fetch('POST', '/api/files/upload/cancel', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId, taskId }),
    });
  }

  async getSession(fileId) {
    return this._fetch('GET', `/api/files/upload/session/${fileId}`);
  }

  async getChunks(fileId) {
    return this._fetch('GET', `/api/files/upload/session/${fileId}/chunks`);
  }

  async getTask(taskId) {
    return this._fetch('GET', `/api/tasks/${taskId}`);
  }

  async listTasks(active = true, resumable = false) {
    const qs = `?active=${active ? '1' : '0'}&resumable=${resumable ? '1' : '0'}`;
    return this._fetch('GET', `/api/tasks/${qs}`);
  }

  async pauseTask(taskId, reason) {
    return this._fetch('POST', `/api/tasks/${taskId}/pause`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: reason || 'Paused by CLI client' }),
    });
  }

  async resumeTask(taskId) {
    return this._fetch('POST', `/api/tasks/${taskId}/resume`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
  }

  async cancelTask(taskId) {
    return this._fetch('POST', `/api/tasks/${taskId}/cancel`, {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
  }

  async deleteTask(taskId) {
    return this._fetch('DELETE', `/api/tasks/${taskId}`);
  }

  async listFolders() {
    return this._fetch('GET', '/api/files/folders');
  }

  async checkAuth() {
    try {
      await this._fetch('GET', '/api/tasks/?active=1&resumable=1');
      return true;
    } catch {
      return false;
    }
  }

  async createApiKey(name) {
    return this._fetch('POST', '/auth/api-keys', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
  }

  async listApiKeys() {
    return this._fetch('GET', '/auth/api-keys');
  }

  async revokeApiKey(id) {
    return this._fetch('DELETE', `/auth/api-keys/${id}`);
  }
}

module.exports = { VaultApi, VaultApiError };
