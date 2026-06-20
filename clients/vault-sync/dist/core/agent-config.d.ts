import type { SyncSettings } from '../shared/types';
export interface RemoteAgentConfig {
    syncEnabled?: boolean;
    syncIntervalSeconds?: number;
    syncRootPath?: string;
    excludedPatterns?: string[];
    convertHlsEnabled?: boolean;
    additionalSyncFolders?: Array<{
        id?: string;
        name?: string;
        localPath: string;
        enabled?: boolean;
    }>;
}
export declare function ensureAgentId(): string;
export declare function buildReportedConfig(settings: SyncSettings): RemoteAgentConfig;
export declare function applyRemoteAgentConfig(config: RemoteAgentConfig): SyncSettings;
export declare function getAgentDisplayName(): string;
export declare function getAgentPlatform(): string;
//# sourceMappingURL=agent-config.d.ts.map