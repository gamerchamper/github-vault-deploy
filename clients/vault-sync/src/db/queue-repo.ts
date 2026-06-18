import { getDatabase } from './database';
import type { UploadQueueEntry, QueueStatus } from '../shared/types';

export function addToQueue(entry: Omit<UploadQueueEntry, 'id' | 'createdAt' | 'startedAt' | 'completedAt'>): number {
  const db = getDatabase();
  const result = db.prepare(`
    INSERT INTO upload_queue (file_id, local_rel_path, local_hash, size, mime_type, status, upload_mode, retry_count, max_retries, task_id, session_json, priority)
    VALUES (@fileId, @localRelPath, @localHash, @size, @mimeType, @status, @uploadMode, @retryCount, @maxRetries, @taskId, @sessionJson, @priority)
  `).run({
    fileId: entry.fileId,
    localRelPath: entry.localRelPath,
    localHash: entry.localHash,
    size: entry.size,
    mimeType: entry.mimeType,
    status: entry.status,
    uploadMode: entry.uploadMode,
    retryCount: entry.retryCount,
    maxRetries: entry.maxRetries,
    taskId: entry.taskId,
    sessionJson: entry.sessionJson,
    priority: entry.priority,
  });
  return Number(result.lastInsertRowid);
}

export function getQueueEntry(id: number): UploadQueueEntry | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM upload_queue WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? mapQueueRow(row) : null;
}

export function getQueueEntryByPath(localRelPath: string): UploadQueueEntry | null {
  const db = getDatabase();
  const row = db.prepare('SELECT * FROM upload_queue WHERE local_rel_path = ? AND status != ? ORDER BY id DESC LIMIT 1')
    .get(localRelPath, 'done') as Record<string, unknown> | undefined;
  return row ? mapQueueRow(row) : null;
}

export function getPendingEntries(limit = 10): UploadQueueEntry[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM upload_queue WHERE status IN (?, ?, ?) ORDER BY priority DESC, id ASC LIMIT ?')
    .all('pending', 'hashing', 'uploading', limit) as Record<string, unknown>[];
  return rows.map(mapQueueRow);
}

export function getActiveCount(): number {
  const db = getDatabase();
  const row = db.prepare("SELECT COUNT(*) as cnt FROM upload_queue WHERE status IN ('hashing', 'uploading')").get() as { cnt: number };
  return row.cnt;
}

export function getAllQueueEntries(): UploadQueueEntry[] {
  const db = getDatabase();
  const rows = db.prepare('SELECT * FROM upload_queue ORDER BY id DESC').all() as Record<string, unknown>[];
  return rows.map(mapQueueRow);
}

export function updateQueueEntry(id: number, patch: Partial<UploadQueueEntry>): void {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  for (const [key, value] of Object.entries(patch)) {
    const col = camelToSnake(key);
    sets.push(`${col} = @${key}`);
    params[key] = value;
  }
  if (!sets.length) return;
  const db = getDatabase();
  db.prepare(`UPDATE upload_queue SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

export function removeQueueEntry(id: number): void {
  const db = getDatabase();
  db.prepare('DELETE FROM upload_queue WHERE id = ?').run(id);
}

export function clearCompleted(): void {
  const db = getDatabase();
  db.prepare("DELETE FROM upload_queue WHERE status = 'done'").run();
}

export function resetStuckEntries(): void {
  const db = getDatabase();
  db.prepare("UPDATE upload_queue SET status = 'pending', error = 'Reset after restart' WHERE status IN ('hashing', 'uploading')").run();
}

function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function mapQueueRow(row: Record<string, unknown>): UploadQueueEntry {
  return {
    id: row.id as number,
    fileId: row.file_id as string | null,
    localRelPath: row.local_rel_path as string,
    localHash: row.local_hash as string,
    size: row.size as number,
    mimeType: row.mime_type as string | null,
    status: row.status as QueueStatus,
    uploadMode: row.upload_mode as 'api' | 'seamless',
    percent: row.percent as number,
    error: row.error as string | null,
    retryCount: row.retry_count as number,
    maxRetries: row.max_retries as number,
    taskId: row.task_id as string | null,
    sessionJson: row.session_json as string | null,
    createdAt: row.created_at as string,
    startedAt: row.started_at as string | null,
    completedAt: row.completed_at as string | null,
    priority: row.priority as number,
  };
}
