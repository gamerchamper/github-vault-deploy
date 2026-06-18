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
        headers: {
          ...this.authHeaders(),
          ...(init.headers as Record<string, string>),
        },
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

  async uploadFile(
    fileBuffer: Buffer,
    fileName: string,
    parentPath = '/',
    chunkSize?: number,
  ): Promise<Result<{ jobId: string; fileName: string; estimatedChunks: number }>> {
    const fd = new FormData();
    fd.append('file', new Blob([fileBuffer]), fileName);
    fd.append('path', parentPath);
    if (chunkSize) fd.append('chunkSize', String(chunkSize));

    try {
      const res = await baseFetch(`${this.baseUrl}/api/files/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        body: fd,
      }, 120000);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return err({ message: text || `HTTP ${res.status}`, status: res.status });
      }
      return ok(await res.json() as any);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return err({ message: msg, status: 0 });
    }
  }

  async getUploadProgress(jobId: string): Promise<Result<{ status?: string; phase?: string; percent?: number; error?: string }>> {
    return this.request(`/api/files/upload-progress/${jobId}`);
  }

  async uploadInit(
    fileName: string, parentPath: string, size: number, mimeType?: string,
  ): Promise<Result<{ fileId: string; jobId: string; totalChunks: number; chunkSize: number; chunksDone: number }>> {
    return this.request('/api/files/upload/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileName, path: parentPath, size, mimeType }),
    });
  }

  async uploadChunk(
    fileId: string, chunkIndex: number, chunkBuffer: Buffer, taskId?: string,
  ): Promise<Result<{ skipped: boolean; chunkIndex: number; chunksDone: number; totalChunks: number; percent: number }>> {
    const fd = new FormData();
    fd.append('chunk', new Blob([chunkBuffer]));
    fd.append('fileId', fileId);
    fd.append('chunkIndex', String(chunkIndex));
    if (taskId) fd.append('taskId', taskId);

    try {
      const res = await baseFetch(`${this.baseUrl}/api/files/upload/chunk`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        body: fd,
      }, 120000);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return err({ message: text || `HTTP ${res.status}`, status: res.status });
      }
      return ok(await res.json() as any);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return err({ message: msg, status: 0 });
    }
  }

  async uploadComplete(fileId: string, taskId?: string): Promise<Result<{ id: string; name: string; size: number }>> {
    return this.request('/api/files/upload/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId, taskId }),
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

  async resumeTask(taskId: string): Promise<Result<unknown>> {
    return this.request(`/api/tasks/${taskId}/resume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
  }

  async seamlessInit(opts: {
    fileName: string;
    parentPath: string;
    size: number;
    mimeType: string;
    chunkSize: number;
    fileId?: string;
    taskId?: string;
    convertHls?: boolean;
  }): Promise<Result<{ fileId: string; jobId: string; totalParts: number; partSize: number; totalChunks?: number }>> {
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
        taskId: opts.taskId || undefined,
        convertHls: !!opts.convertHls,
      }),
    });
  }

  async seamlessPart(
    fileId: string,
    partIndex: number,
    buffer: Buffer,
    taskId?: string,
  ): Promise<Result<{ partIndex: number; partsDone: number; percent?: number }>> {
    const fd = new FormData();
    fd.append('fileId', fileId);
    fd.append('partIndex', String(partIndex));
    if (taskId) fd.append('taskId', taskId);
    fd.append('part', new Blob([buffer]), `part-${partIndex}`);

    try {
      const res = await baseFetch(`${this.baseUrl}/api/files/upload/seamless/part`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        body: fd,
      }, 600000);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return err({ message: text || `HTTP ${res.status}`, status: res.status });
      }
      return ok(await res.json() as any);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return err({ message: msg, status: 0 });
    }
  }

  async seamlessComplete(fileId: string, taskId: string, convertHls = false): Promise<Result<unknown>> {
    return this.request('/api/files/upload/seamless/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId, taskId, convertHls: convertHls ? '1' : '0' }),
    }, 600000);
  }

  async seamlessStatus(fileId: string): Promise<Result<{ stagingComplete: boolean; totalParts?: number; nextPart?: number; partSize?: number }>> {
    return this.request(`/api/files/upload/seamless/status/${fileId}`);
  }

  async seamlessResume(fileId: string, taskId: string, convertHls = false): Promise<Result<unknown>> {
    return this.request('/api/files/upload/seamless/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId, taskId, convertHls: convertHls ? '1' : '0' }),
    }, 600000);
  }

  async getStats(): Promise<Result<unknown>> {
    return this.request('/api/files/stats');
  }

  async getFolders(): Promise<Result<{ folders: string[] }>> {
    return this.request('/api/files/folders');
  }

  async downloadFile(fileId: string, filePath: string, onProgress?: (pct: number) => void): Promise<Result<ArrayBuffer>> {
    try {
      const res = await baseFetch(`${this.baseUrl}/api/files/stream/${fileId}`, {
        headers: this.authHeaders(),
      }, 120000);

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return err({ message: text || `HTTP ${res.status}`, status: res.status });
      }

      const total = parseInt(res.headers.get('content-length') || '0', 10);
      const reader = res.body?.getReader();
      if (!reader) return err({ message: 'No response body', status: 0 });

      const chunks: Uint8Array[] = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (onProgress && total > 0) onProgress(Math.round((received / total) * 100));
      }

      const totalSize = chunks.reduce((s, c) => s + c.length, 0);
      const buf = new Uint8Array(totalSize);
      let offset = 0;
      for (const chunk of chunks) { buf.set(chunk, offset); offset += chunk.length; }
      return ok(buf.buffer);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return err({ message: msg, status: 0 });
    }
  }
}
