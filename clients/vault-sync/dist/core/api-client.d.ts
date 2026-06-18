import type { FileEntry, Result } from '../shared/types';
export interface VaultApiConfig {
    serverUrl: string;
    apiKey: string;
}
export declare class VaultApiClient {
    private config;
    constructor(config: VaultApiConfig);
    private get baseUrl();
    private authHeaders;
    private request;
    validateAuth(): Promise<Result<{
        authenticated: boolean;
    }>>;
    listFiles(parentPath?: string, limit?: number, offset?: number): Promise<Result<{
        files: FileEntry[];
        total: number;
        hasMore: boolean;
        nextOffset: number;
    }>>;
    getFileDetails(fileId: string): Promise<Result<FileEntry>>;
    createFolder(name: string, parentPath?: string): Promise<Result<{
        success: boolean;
        folder: unknown;
    }>>;
    deleteFile(fileId: string): Promise<Result<{
        success: boolean;
    }>>;
    moveFile(ids: string[], destination: string): Promise<Result<{
        success: boolean;
    }>>;
    uploadFile(fileBuffer: Buffer, fileName: string, parentPath?: string, chunkSize?: number): Promise<Result<{
        jobId: string;
        fileName: string;
        estimatedChunks: number;
    }>>;
    getUploadProgress(jobId: string): Promise<Result<{
        status?: string;
        phase?: string;
        percent?: number;
        error?: string;
    }>>;
    uploadInit(fileName: string, parentPath: string, size: number, mimeType?: string): Promise<Result<{
        fileId: string;
        jobId: string;
        totalChunks: number;
        chunkSize: number;
        chunksDone: number;
    }>>;
    uploadChunk(fileId: string, chunkIndex: number, chunkBuffer: Buffer, taskId?: string): Promise<Result<{
        skipped: boolean;
        chunkIndex: number;
        chunksDone: number;
        totalChunks: number;
        percent: number;
    }>>;
    uploadComplete(fileId: string, taskId?: string): Promise<Result<{
        id: string;
        name: string;
        size: number;
    }>>;
    getTasks(params?: {
        active?: boolean;
        resumable?: boolean;
    }): Promise<Result<{
        tasks: unknown[];
    }>>;
    getTask(taskId: string): Promise<Result<unknown>>;
    getStats(): Promise<Result<unknown>>;
    getFolders(): Promise<Result<{
        folders: string[];
    }>>;
    downloadFile(fileId: string, filePath: string, onProgress?: (pct: number) => void): Promise<Result<ArrayBuffer>>;
}
//# sourceMappingURL=api-client.d.ts.map