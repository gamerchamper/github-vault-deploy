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
                headers: { ...this.authHeaders(), ...init.headers },
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
    async moveFile(ids, destination) {
        return this.request('/api/files/move', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids, destination }),
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
    async getStats() {
        return this.request('/api/files/stats');
    }
    async getFolders() {
        return this.request('/api/files/folders');
    }
}
exports.VaultApiClient = VaultApiClient;
//# sourceMappingURL=api-client.js.map