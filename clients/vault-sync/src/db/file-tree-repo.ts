import Database from 'better-sqlite3';
import { getDatabase } from './database';
import type { SyncFileEntry, UploadQueueEntry } from '../shared/types';

import { normalizeRelPath } from '../services/paths';

export function upsertFile(db: Database.Database, entry: SyncFileEntry): void {
  const localRelPath = normalizeRelPath(entry.localRelPath);
  db.prepare(`
    INSERT INTO file_tree (file_id, local_rel_path, remote_path, name, size, mime_type, is_folder,
      local_mtime_ms, local_hash, remote_hash, remote_updated_at, sync_status, sync_task_id, sync_error)
    VALUES (@fileId, @localRelPath, @remotePath, @name, @size, @mimeType, @isFolder,
      @localMtimeMs, @localHash, @remoteHash, @remoteUpdatedAt, @syncStatus, @syncTaskId, @syncError)
    ON CONFLICT(local_rel_path) DO UPDATE SET
      file_id=excluded.file_id, remote_path=excluded.remote_path, name=excluded.name,
      size=excluded.size, mime_type=excluded.mime_type, is_folder=excluded.is_folder,
      local_mtime_ms=excluded.local_mtime_ms, local_hash=excluded.local_hash,
      remote_hash=excluded.remote_hash, remote_updated_at=excluded.remote_updated_at,
      sync_status=excluded.sync_status, sync_task_id=excluded.sync_task_id,
      sync_error=excluded.sync_error, updated_at=datetime('now')
  `).run({
    fileId: entry.fileId,
    localRelPath,
    remotePath: entry.remotePath,
    name: entry.name,
    size: entry.size,
    mimeType: entry.mimeType,
    isFolder: entry.isFolder ? 1 : 0,
    localMtimeMs: entry.localMtimeMs,
    localHash: entry.localHash,
    remoteHash: entry.remoteHash,
    remoteUpdatedAt: entry.remoteUpdatedAt,
    syncStatus: entry.syncStatus,
    syncTaskId: entry.syncTaskId,
    syncError: entry.syncError,
  });
}

export function getFileByRelPath(localRelPath: string): SyncFileEntry | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM file_tree WHERE local_rel_path = ?').get(normalizeRelPath(localRelPath)) as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

export function getFileByFileId(fileId: string): SyncFileEntry | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM file_tree WHERE file_id = ?').get(fileId) as Record<string, unknown> | undefined;
  return row ? mapRow(row) : null;
}

export function getFileByHash(localHash: string, excludeRelPath?: string): SyncFileEntry | null {
  const db = getDatabase();
  const row = excludeRelPath
    ? db.prepare('SELECT * FROM file_tree WHERE local_hash = ? AND local_rel_path != ? LIMIT 1').get(localHash, excludeRelPath)
    : db.prepare('SELECT * FROM file_tree WHERE local_hash = ? LIMIT 1').get(localHash);
  return row ? mapRow(row as Record<string, unknown>) : null;
}

export function getAllFiles(): SyncFileEntry[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM file_tree ORDER BY local_rel_path').all() as Record<string, unknown>[];
  return rows.map(mapRow);
}

export function getFilesByStatus(status: string): SyncFileEntry[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM file_tree WHERE sync_status = ? ORDER BY local_rel_path').all(status) as Record<string, unknown>[];
  return rows.map(mapRow);
}

export function deleteFileEntry(localRelPath: string): void {
  const db = getDatabase();
  db.prepare('DELETE FROM file_tree WHERE local_rel_path = ?').run(localRelPath);
}

export function getSyncStatusCounts(): { synced: number; localOnly: number; conflict: number; error: number; uploading: number; total: number } {
  const db = getDatabase();
  const rows = db.prepare('SELECT sync_status, COUNT(*) as cnt FROM file_tree GROUP BY sync_status').all() as { sync_status: string; cnt: number }[];
  const result = { synced: 0, localOnly: 0, conflict: 0, error: 0, uploading: 0, total: 0 };
  for (const row of rows) {
    result.total += row.cnt;
    if (row.sync_status === 'synced') result.synced = row.cnt;
    else if (row.sync_status === 'local_only') result.localOnly = row.cnt;
    else if (row.sync_status === 'conflict') result.conflict = row.cnt;
    else if (row.sync_status === 'error') result.error = row.cnt;
    else if (row.sync_status === 'uploading') result.uploading = row.cnt;
  }
  return result;
}

function mapRow(row: Record<string, unknown>): SyncFileEntry {
  const isFolderExplicit = (row.is_folder as number) === 1;
  const name = row.name as string;
  const size = row.size as number;
  const syncStatus = row.sync_status as SyncFileEntry['syncStatus'];
  const isFolder = isFolderExplicit || (size === 0 && !/\.\w{2,6}$/i.test(name || ''));
  return {
    fileId: row.file_id as string | null,
    localRelPath: row.local_rel_path as string,
    remotePath: row.remote_path as string | null,
    name,
    size,
    mimeType: row.mime_type as string | null,
    isFolder,
    localMtimeMs: row.local_mtime_ms as number | null,
    localHash: row.local_hash as string | null,
    remoteHash: row.remote_hash as string | null,
    remoteUpdatedAt: row.remote_updated_at as string | null,
    syncStatus,
    syncTaskId: row.sync_task_id as string | null,
    syncError: row.sync_error as string | null,
  };
}
