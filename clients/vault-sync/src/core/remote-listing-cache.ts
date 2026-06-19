import { VaultApiClient } from './api-client';
import type { FileEntry } from '../shared/types';

export class RemoteListingCache {
  private cache = new Map<string, FileEntry[] | null>();

  constructor(private api: VaultApiClient) {}

  async listFolder(parentPath: string): Promise<FileEntry[] | null> {
    if (this.cache.has(parentPath)) return this.cache.get(parentPath)!;

    const files: FileEntry[] = [];
    let offset = 0;
    for (;;) {
      const result = await this.api.listFiles(parentPath, 500, offset);
      if (!result.ok) {
        this.cache.set(parentPath, null);
        return null;
      }
      files.push(...result.value.files);
      if (!result.value.hasMore || result.value.nextOffset === undefined) break;
      offset = result.value.nextOffset;
    }

    this.cache.set(parentPath, files);
    return files;
  }

  async findByNameAndSize(parentPath: string, name: string, size: number): Promise<FileEntry | null> {
    const files = await this.listFolder(parentPath);
    if (!files) return null;
    return files.find((file) => {
      if (file.isFolder || file.is_folder) return false;
      return file.name === name && file.size === size;
    }) ?? null;
  }

  async findFolderByName(parentPath: string, name: string): Promise<FileEntry | null> {
    const files = await this.listFolder(parentPath);
    if (!files) return null;
    return files.find((file) => {
      const isFolder = !!(file.isFolder || file.is_folder);
      return isFolder && file.name === name;
    }) ?? null;
  }

  invalidate(parentPath: string): void {
    this.cache.delete(parentPath);
  }

  async hasFileId(parentPath: string, fileId: string): Promise<boolean | null> {
    const files = await this.listFolder(parentPath);
    if (files === null) return null;
    return files.some((file) => file.id === fileId);
  }
}
