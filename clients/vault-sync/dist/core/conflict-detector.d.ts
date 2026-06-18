import type { SyncFileEntry, ConflictEntry } from '../shared/types';
export declare function detectConflicts(localEntry: SyncFileEntry | null, remoteEntry: SyncFileEntry | null): {
    conflict: ConflictEntry | null;
    action: 'upload' | 'download' | 'skip' | 'conflict';
};
export declare function makeConflictCopyPath(filePath: string): string;
//# sourceMappingURL=conflict-detector.d.ts.map