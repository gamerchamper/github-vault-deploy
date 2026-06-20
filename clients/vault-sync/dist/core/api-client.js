"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.VaultApiClient = void 0;
const result_1 = require("../shared/result");
function baseFetch(url, init = {}, timeoutMs = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}
class VaultApiClient {
    config;
    constructor(config) {
        this.config = config;
    }
    get baseUrl() {
        return this.config.serverUrl.replace(/\/+$/, '');
    }
    authHeaders() {
        return {
            Accept: 'application/json',
            Authorization: `Bearer ${this.config.apiKey}`,
        };
    }
    async request(path, init = {}, timeoutMs = 30000) {
        try {
            const res = await baseFetch(`${this.baseUrl}${path}`, {
                ...init,
                headers: {
                    ...this.authHeaders(),
                    ...init.headers,
                },
            }, timeoutMs);
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return (0, result_1.err)({ message: text || `HTTP ${res.status}`, status: res.status });
            }
            const data = await res.json();
            return (0, result_1.ok)(data);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return (0, result_1.err)({ message: msg, status: 0 });
        }
    }
    async validateAuth() {
        return this.request('/auth/me');
    }
    async agentRegister(body) {
        return this.request('/api/agents/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }
    async agentHeartbeat(body) {
        return this.request('/api/agents/heartbeat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
    }
    async listFiles(parentPath = '/', limit = 500, offset = 0) {
        const params = new URLSearchParams({ path: parentPath, limit: String(limit), offset: String(offset), sort: 'name', order: 'ASC' });
        return this.request(`/api/files/list?${params}`);
    }
    async getFileDetails(fileId) {
        return this.request(`/api/files/details/${fileId}`);
    }
    async createFolder(name, parentPath = '/') {
        return this.request('/api/files/folder', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, path: parentPath }),
        });
    }
    async deleteFile(fileId) {
        return this.request(`/api/files/${fileId}`, { method: 'DELETE' });
    }
    async renameFile(fileId, newName) {
        return this.request('/api/files/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: fileId, name: newName }),
        });
    }
    async moveFile(ids, destination) {
        return this.request('/api/files/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids, destination }),
        });
    }
    async uploadFile(fileBuffer, fileName, parentPath = '/', chunkSize) {
        const fd = new FormData();
        fd.append('file', new Blob([fileBuffer]), fileName);
        fd.append('path', parentPath);
        if (chunkSize)
            fd.append('chunkSize', String(chunkSize));
        try {
            const res = await baseFetch(`${this.baseUrl}/api/files/upload`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${this.config.apiKey}` },
                body: fd,
            }, 120000);
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return (0, result_1.err)({ message: text || `HTTP ${res.status}`, status: res.status });
            }
            return (0, result_1.ok)(await res.json());
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return (0, result_1.err)({ message: msg, status: 0 });
        }
    }
    async getUploadProgress(jobId) {
        return this.request(`/api/files/upload-progress/${jobId}`);
    }
    async uploadInit(fileName, parentPath, size, mimeType) {
        return this.request('/api/files/upload/init', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileName, path: parentPath, size, mimeType }),
        });
    }
    async uploadChunk(fileId, chunkIndex, chunkBuffer, taskId) {
        const fd = new FormData();
        fd.append('chunk', new Blob([chunkBuffer]));
        fd.append('fileId', fileId);
        fd.append('chunkIndex', String(chunkIndex));
        if (taskId)
            fd.append('taskId', taskId);
        try {
            const res = await baseFetch(`${this.baseUrl}/api/files/upload/chunk`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${this.config.apiKey}` },
                body: fd,
            }, 120000);
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return (0, result_1.err)({ message: text || `HTTP ${res.status}`, status: res.status });
            }
            return (0, result_1.ok)(await res.json());
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return (0, result_1.err)({ message: msg, status: 0 });
        }
    }
    async uploadComplete(fileId, taskId) {
        return this.request('/api/files/upload/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileId, taskId }),
        });
    }
    async getTasks(params) {
        const search = new URLSearchParams();
        if (params?.active)
            search.set('active', '1');
        if (params?.resumable)
            search.set('resumable', '1');
        return this.request(`/api/tasks/?${search}`);
    }
    async getTask(taskId) {
        return this.request(`/api/tasks/${taskId}`);
    }
    async resumeTask(taskId) {
        return this.request(`/api/tasks/${taskId}/resume`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({}),
        });
    }
    async seamlessInit(opts) {
        return this.request('/api/files/upload/seamless/init', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                fileName: opts.fileName,
                parentPath: opts.parentPath,
                size: opts.size,
                mimeType: opts.mimeType,
                chunkSize: opts.chunkSize || undefined,
                fileId: opts.fileId || undefined,
                replaceFileId: opts.replaceFileId || undefined,
                taskId: opts.taskId || undefined,
                convertHls: !!opts.convertHls,
            }),
        });
    }
    async seamlessPart(fileId, partIndex, buffer, taskId) {
        const fd = new FormData();
        fd.append('fileId', fileId);
        fd.append('partIndex', String(partIndex));
        if (taskId)
            fd.append('taskId', taskId);
        fd.append('part', new Blob([buffer]), `part-${partIndex}`);
        try {
            const res = await baseFetch(`${this.baseUrl}/api/files/upload/seamless/part`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${this.config.apiKey}` },
                body: fd,
            }, 600000);
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return (0, result_1.err)({ message: text || `HTTP ${res.status}`, status: res.status });
            }
            return (0, result_1.ok)(await res.json());
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return (0, result_1.err)({ message: msg, status: 0 });
        }
    }
    async seamlessComplete(fileId, taskId, convertHls = false) {
        return this.request('/api/files/upload/seamless/complete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileId, taskId, convertHls: convertHls ? '1' : '0' }),
        }, 600000);
    }
    async seamlessStatus(fileId) {
        return this.request(`/api/files/upload/seamless/status/${fileId}`);
    }
    async seamlessResume(fileId, taskId, convertHls = false) {
        return this.request('/api/files/upload/seamless/resume', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fileId, taskId, convertHls: convertHls ? '1' : '0' }),
        }, 600000);
    }
    async getStats() {
        return this.request('/api/files/stats');
    }
    async getFolders() {
        return this.request('/api/files/folders');
    }
    async downloadFile(fileId, filePath, onProgress) {
        try {
            const res = await baseFetch(`${this.baseUrl}/api/files/stream/${fileId}`, {
                headers: this.authHeaders(),
            }, 120000);
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                return (0, result_1.err)({ message: text || `HTTP ${res.status}`, status: res.status });
            }
            const total = parseInt(res.headers.get('content-length') || '0', 10);
            const reader = res.body?.getReader();
            if (!reader)
                return (0, result_1.err)({ message: 'No response body', status: 0 });
            const chunks = [];
            let received = 0;
            while (true) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                chunks.push(value);
                received += value.length;
                if (onProgress && total > 0)
                    onProgress(Math.round((received / total) * 100));
            }
            const totalSize = chunks.reduce((s, c) => s + c.length, 0);
            const buf = new Uint8Array(totalSize);
            let offset = 0;
            for (const chunk of chunks) {
                buf.set(chunk, offset);
                offset += chunk.length;
            }
            return (0, result_1.ok)(buf.buffer);
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return (0, result_1.err)({ message: msg, status: 0 });
        }
    }
}
exports.VaultApiClient = VaultApiClient;
//# sourceMappingURL=api-client.js.map