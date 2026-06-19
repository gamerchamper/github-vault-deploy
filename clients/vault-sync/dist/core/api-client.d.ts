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
        folder: {
            id: string;
            name: string;
            path: string;
            is_folder?: boolean;
        };
    }>>;
    deleteFile(fileId: string): Promise<Result<{
        success: boolean;
    }>>;
    renameFile(fileId: string, newName: string): Promise<Result<{
        success: boolean;
        id: string;
        name: string;
        path: string;
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
    resumeTask(taskId: string): Promise<Result<unknown>>;
    seamlessInit(opts: {
        fileName: string;
        parentPath: string;
        size: number;
        mimeType: string;
        chunkSize: number;
        fileId?: string;
        replaceFileId?: string;
        taskId?: string;
        convertHls?: boolean;
    }): Promise<Result<{
        fileId: string;
        jobId: string;
        totalParts: number;
        partSize: number;
        totalChunks?: number;
    }>>;
    seamlessPart(fileId: string, partIndex: number, buffer: Buffer, taskId?: string): Promise<Result<{
        partIndex: number;
        partsDone: number;
        percent?: number;
    }>>;
    seamlessComplete(fileId: string, taskId: string, convertHls?: boolean): Promise<Result<unknown>>;
    seamlessStatus(fileId: string): Promise<Result<{
        stagingComplete: boolean;
        totalParts?: number;
        nextPart?: number;
        partSize?: number;
    }>>;
    seamlessResume(fileId: string, taskId: string, convertHls?: boolean): Promise<Result<unknown>>;
    getStats(): Promise<Result<unknown>>;
    getFolders(): Promise<Result<{
        folders: string[];
    }>>;
    downloadFile(fileId: string, filePath: string, onProgress?: (pct: number) => void): Promise<Result<ArrayBuffer>>;
}
//# sourceMappingURL=api-client.d.ts.map