import type { SyncState } from '../shared/types';
export declare function getSyncState(): SyncState;
export declare function onSyncStateChange(cb: (state: SyncState) => void): void;
export declare function startSyncLoop(): Promise<void>;
export declare function stopSyncLoop(): void;
//# sourceMappingURL=sync-engine.d.ts.map