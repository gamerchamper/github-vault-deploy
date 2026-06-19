import type { SyncState } from '../shared/types';
export declare function getSyncState(): SyncState;
export declare function onSyncStateChange(cb: (state: SyncState) => void): void;
/** Handle watcher events (rename detection, scan). */
export declare function handleWatcherEvent(event: string, relPath: string): Promise<void>;
/** Scan one file (watcher / manual refresh) and queue if needed. */
export declare function scanLocalFile(relPath: string): Promise<void>;
export declare function startSyncLoop(): Promise<void>;
export declare function stopSyncLoop(): void;
export declare function runSyncCycleNow(): Promise<void>;
//# sourceMappingURL=sync-engine.d.ts.map