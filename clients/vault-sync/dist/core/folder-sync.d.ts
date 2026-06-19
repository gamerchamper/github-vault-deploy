import { RemoteListingCache } from './remote-listing-cache';
/** Ensure a local folder path exists on the server (creates parents as needed). */
export declare function syncLocalFolder(relPath: string, remoteCache?: RemoteListingCache): Promise<boolean>;
/** Sync all local-only folders (parents before children). */
export declare function syncLocalOnlyFolders(remoteCache?: RemoteListingCache): Promise<number>;
//# sourceMappingURL=folder-sync.d.ts.map