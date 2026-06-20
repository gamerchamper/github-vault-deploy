export declare function startAllWatchers(roots: string[], toStoredRel: (absPath: string) => string | null, cb: (event: string, storedRelPath: string) => void): void;
/** @deprecated Use startAllWatchers */
export declare function startWatcher(syncRoot: string, cb: (event: string, filePath: string) => void): void;
export declare function stopWatcher(): void;
//# sourceMappingURL=file-watcher.d.ts.map