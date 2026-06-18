import { logger } from '../services/logger';
import type { FileEntry, Result } from '../shared/types';
import { ok, err } from '../shared/result';

export interface VaultApiConfig {
  serverUrl: string;
  apiKey: string;
}

function baseFetch(url: string, init: RequestInit = {}, timeoutMs = 30000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

export class VaultApiClient {
  constructor(private config: VaultApiConfig) {}

  private get baseUrl(): string {
    return this.config.serverUrl.replace(/\/+$/, '');
  }

  private authHeaders(): Record<string, string> {
    return {
      Accept: 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
    };
  }

  private async request<T>(path: string, init: RequestInit = {}, timeoutMs = 30000): Promise<Result<T>> {
    try {
      const res = await baseFetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...this.authHeaders(), ...(init.headers as Record<string, string>) },
      }, timeoutMs);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return err({ message: text || `HTTP ${res.status}`, status: res.status });
      }
      const data = await res.json() as T;
      return ok(data);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return err({ message: msg, status: 0 });
    }
  }

  async validateAuth(): Promise<Result<{ authenticated: boolean }>> {
    return this.request('/auth/me');
  }

  async listFiles(parentPath = '/', limit = 500, offset = 0): Promise<Result<{ files: FileEntry[]; total: number; hasMore: boolean; nextOffset: number }>> {
    const params = new URLSearchParams({ path: parentPath, limit: String(limit), offset: String(offset), sort: 'name', order: 'ASC' });
    return this.request(`/api/files/list?${params}`);
  }

  async getFileDetails(fileId: string): Promise<Result<FileEntry>> {
    return this.request(`/api/files/details/${fileId}`);
  }

  async createFolder(name: string, parentPath = '/'): Promise<Result<{ success: boolean; folder: unknown }>> {
    return this.request('/api/files/folder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, path: parentPath }),
    });
  }

  async deleteFile(fileId: string): Promise<Result<{ success: boolean }>> {
    return this.request(`/api/files/${fileId}`, { method: 'DELETE' });
  }

  async moveFile(ids: string[], destination: string): Promise<Result<{ success: boolean }>> {
    return this.request('/api/files/move', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, destination }),
    });
  }

  async getTasks(params?: { active?: boolean; resumable?: boolean }): Promise<Result<{ tasks: unknown[] }>> {
    const search = new URLSearchParams();
    if (params?.active) search.set('active', '1');
    if (params?.resumable) search.set('resumable', '1');
    return this.request(`/api/tasks/?${search}`);
  }

  async getTask(taskId: string): Promise<Result<unknown>> {
    return this.request(`/api/tasks/${taskId}`);
  }

  async getStats(): Promise<Result<unknown>> {
    return this.request('/api/files/stats');
  }

  async getFolders(): Promise<Result<{ folders: string[] }>> {
    return this.request('/api/files/folders');
  }
}
