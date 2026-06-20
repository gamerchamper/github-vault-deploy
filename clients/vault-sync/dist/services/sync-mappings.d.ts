import { parentPathFromRel } from './paths';
import type { AdditionalSyncFolder, SyncSettings } from '../shared/types';
export declare const SYNC_CONTAINER_NAME = "Sync Folder";
export declare function remotePrefixForFolderName(folderName: string): string;
export declare function createAdditionalFolder(localPath: string): AdditionalSyncFolder;
export declare function getEnabledAdditionalFolders(settings: SyncSettings): AdditionalSyncFolder[];
export declare function isAdditionalStoredRel(storedRel: string): boolean;
export declare function toAdditionalStoredRel(mappingId: string, relWithin: string): string;
export declare function parseAdditionalStoredRel(storedRel: string): {
    mappingId: string;
    relWithin: string;
} | null;
export declare function findMapping(settings: SyncSettings, mappingId: string): AdditionalSyncFolder | undefined;
export declare function absPathFromStored(settings: SyncSettings, storedRel: string): string | null;
export declare function remotePathFromStored(settings: SyncSettings, storedRel: string): string;
export declare function remoteParentFromStored(settings: SyncSettings, storedRel: string): string;
export declare function displayRelPath(settings: SyncSettings, storedRel: string): string;
export declare function resolveAbsPathToStored(settings: SyncSettings, absPath: string): string | null;
export declare function relWithinSegments(storedRel: string): string[];
export declare function storedRelAfterSegments(mappingId: string | null, segments: string[]): string;
export declare function mappingIdFromStored(storedRel: string): string | null;
/** Parent stored path for folder hierarchy inside a mapping or main root. */
export declare function parentStoredRel(storedRel: string): string;
export declare function pathsConflict(settings: SyncSettings, localPath: string): string | null;
export declare function listRemoteWalkRoots(settings: SyncSettings): string[];
export declare function remotePathToStored(settings: SyncSettings, remotePath: string): string | null;
export { parentPathFromRel };
//# sourceMappingURL=sync-mappings.d.ts.map