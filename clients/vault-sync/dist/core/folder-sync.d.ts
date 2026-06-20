import { VaultApiClient } from './api-client';
import { RemoteListingCache } from './remote-listing-cache';
/** Ensure the server has /Sync Folder before syncing additional PC folders. */
export declare function ensureSyncContainerOnServer(api?: VaultApiClient): Promise<boolean>;
/** Ensure a local folder path exists on the server (creates parents as needed). */
export declare function syncLocalFolder(relPath: string, remoteCache?: RemoteListingCache): Promise<boolean>;
/** Sync all local-only folders (parents before children). */
export declare function syncLocalOnlyFolders(remoteCache?: RemoteListingCache): Promise<number>;
export declare function registerAdditionalFolderRoots(): Promise<void>;
//# sourceMappingURL=folder-sync.d.ts.map