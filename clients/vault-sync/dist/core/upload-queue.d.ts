declare let onProgress: ((entry: {
    id: number;
    localRelPath: string;
    status: string;
    percent: number;
}) => void) | null;
export declare function setProgressHandler(handler: typeof onProgress): void;
export declare function kickQueue(): void;
export declare function startProcessing(intervalMs?: number): void;
export declare function stopProcessing(): void;
export declare function resetFolderCache(): void;
export {};
//# sourceMappingURL=upload-queue.d.ts.map