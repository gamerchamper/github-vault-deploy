import type { SyncFileEntry, SyncSettings } from '../shared/types';
export declare function trackPendingRemoval(relPath: string, isFolder: boolean): void;
export declare function tryResolvePendingRename(newRelPath: string, isFolder: boolean): Promise<boolean>;
export declare function applyPathChange(oldEntry: SyncFileEntry, newRelPath: string): Promise<void>;
export declare function applyFolderPathChange(oldFolder: SyncFileEntry, newFolderRel: string): Promise<void>;
export declare function detectRenamesFromScan(settings: SyncSettings, hashIndex: Map<string, string>, known: Set<string>, seen: Set<string>): Promise<number>;
export declare function buildHashIndexKey(hash: string, size: number): string;
//# sourceMappingURL=rename-sync.d.ts.map