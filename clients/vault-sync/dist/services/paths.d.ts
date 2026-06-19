/** Canonical relative path stored in SQLite (forward slashes). */
export declare function normalizeRelPath(relPath: string): string;
export declare function toAbsPath(syncRoot: string, relPath: string): string;
export declare function parentPathFromRel(localRelPath: string): string;
export declare function toRemotePath(localRelPath: string): string;
//# sourceMappingURL=paths.d.ts.map