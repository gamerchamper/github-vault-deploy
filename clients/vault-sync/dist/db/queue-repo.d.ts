import type { UploadQueueEntry } from '../shared/types';
export declare function addToQueue(entry: Omit<UploadQueueEntry, 'id' | 'createdAt' | 'startedAt' | 'completedAt'>): number;
export declare function getQueueEntry(id: number): UploadQueueEntry | null;
export declare function getQueueEntryByPath(localRelPath: string): UploadQueueEntry | null;
export declare function hasActiveQueueEntry(localRelPath: string): boolean;
export declare function getPendingEntries(limit?: number): UploadQueueEntry[];
export declare function getActiveCount(): number;
export declare function getAllQueueEntries(): UploadQueueEntry[];
export declare function updateQueueEntry(id: number, patch: Partial<UploadQueueEntry>): void;
export declare function removeQueueEntry(id: number): void;
export declare function clearCompleted(): void;
export declare function resetStuckEntries(): void;
export declare function clearStaleUploadSessions(): number;
export declare function requeueFailedEntries(): void;
export declare function requeuePathIfFailed(localRelPath: string): void;
export declare function dedupePendingEntries(): number;
export declare function cancelInvalidPendingEntries(): number;
export declare function relocateQueuePath(oldRelPath: string, newRelPath: string): void;
export declare function relocateQueuePathPrefix(oldPrefix: string, newPrefix: string): void;
export declare function prepareQueueAfterRestart(): {
    deduped: number;
    cancelled: number;
    sessionsCleared: number;
};
//# sourceMappingURL=queue-repo.d.ts.map