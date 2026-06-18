import Database from 'better-sqlite3';
import type { SyncFileEntry } from '../shared/types';
export declare function upsertFile(db: Database.Database, entry: SyncFileEntry): void;
export declare function getFileByRelPath(localRelPath: string): SyncFileEntry | null;
export declare function getFileByFileId(fileId: string): SyncFileEntry | null;
export declare function getFileByHash(localHash: string): SyncFileEntry | null;
export declare function getAllFiles(): SyncFileEntry[];
export declare function getFilesByStatus(status: string): SyncFileEntry[];
export declare function deleteFileEntry(localRelPath: string): void;
export declare function getSyncStatusCounts(): {
    synced: number;
    localOnly: number;
    conflict: number;
    error: number;
    uploading: number;
    total: number;
};
//# sourceMappingURL=file-tree-repo.d.ts.map