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
}
//# sourceMappingURL=api-client.d.ts.map