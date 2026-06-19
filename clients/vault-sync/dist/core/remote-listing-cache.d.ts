import { VaultApiClient } from './api-client';
import type { FileEntry } from '../shared/types';
export declare class RemoteListingCache {
    private api;
    private cache;
    constructor(api: VaultApiClient);
    listFolder(parentPath: string): Promise<FileEntry[] | null>;
    findByNameAndSize(parentPath: string, name: string, size: number): Promise<FileEntry | null>;
    findFolderByName(parentPath: string, name: string): Promise<FileEntry | null>;
    invalidate(parentPath: string): void;
    hasFileId(parentPath: string, fileId: string): Promise<boolean | null>;
}
//# sourceMappingURL=remote-listing-cache.d.ts.map