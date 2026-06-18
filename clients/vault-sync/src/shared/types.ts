export interface FileEntry {
  id: string;
  name: string;
  path: string;
  parentPath: string;
  size: number;
  mimeType: string | null;
  isFolder: boolean;
  contentHash: string | null;
  chunkCount: number;
  hasThumbnail: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  isDeleted: boolean;
}

export interface SyncFileEntry {
  fileId: string | null;
  localRelPath: string;
  remotePath: string | null;
  name: string;
  size: number;
  mimeType: string | null;
  isFolder: boolean;
  localMtimeMs: number | null;
  localHash: string | null;
  remoteHash: string | null;
  remoteUpdatedAt: string | null;
  syncStatus: SyncStatus;
  syncTaskId: string | null;
  syncError: string | null;
}

export type SyncStatus =
  | 'synced'
  | 'uploading'
  | 'downloading'
  | 'conflict'
  | 'local_only'
  | 'remote_only'
  | 'deleted'
  | 'error';

export interface UploadQueueEntry {
  id: number;
  fileId: string | null;
  localRelPath: string;
  localHash: string;
  size: number;
  mimeType: string | null;
  status: QueueStatus;
  uploadMode: UploadMode;
  percent: number;
  error: string | null;
  retryCount: number;
  maxRetries: number;
  taskId: string | null;
  sessionJson: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  priority: number;
}

export type QueueStatus = 'pending' | 'hashing' | 'uploading' | 'done' | 'error' | 'paused';
export type UploadMode = 'api' | 'seamless';

export interface ConflictEntry {
  id: number;
  fileId: string | null;
  localRelPath: string;
  localHash: string | null;
  remoteHash: string | null;
  localMtimeMs: number | null;
  remoteUpdatedAt: string | null;
  conflictReason: string;
  resolution: 'unresolved' | 'keep_local' | 'keep_remote' | 'keep_both';
  resolvedAt: string | null;
  createdAt: string;
}

export interface SyncSettings {
  syncEnabled: boolean;
  syncIntervalSeconds: number;
  uploadConcurrency: number;
  syncRootPath: string;
  serverUrl: string;
  apiKey: string;
  excludedPatterns: string[];
  autoStart: boolean;
  notificationsEnabled: boolean;
  lastSyncCursor: string | null;
}

export interface SyncState {
  status: 'idle' | 'syncing' | 'error' | 'offline';
  lastSyncAt: string | null;
  lastError: string | null;
  pendingUploads: number;
  pendingDownloads: number;
  conflictCount: number;
  totalFiles: number;
}

export interface ApiError {
  message: string;
  status: number;
  code?: string;
}

export type Result<T, E = ApiError> =
  | { ok: true; value: T }
  | { ok: false; error: E };
