"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.upsertFile = upsertFile;
exports.getFileByRelPath = getFileByRelPath;
exports.getFileByFileId = getFileByFileId;
exports.getFileByHash = getFileByHash;
exports.getAllFiles = getAllFiles;
exports.getFilesByStatus = getFilesByStatus;
exports.deleteFileEntry = deleteFileEntry;
exports.getSyncStatusCounts = getSyncStatusCounts;
const database_1 = require("./database");
function upsertFile(db, entry) {
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
        localRelPath: entry.localRelPath,
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
function getFileByRelPath(localRelPath) {
    const db = (0, database_1.getDatabase)();
    const row = db.prepare('SELECT * FROM file_tree WHERE local_rel_path = ?').get(localRelPath);
    return row ? mapRow(row) : null;
}
function getFileByFileId(fileId) {
    const db = (0, database_1.getDatabase)();
    const row = db.prepare('SELECT * FROM file_tree WHERE file_id = ?').get(fileId);
    return row ? mapRow(row) : null;
}
function getFileByHash(localHash) {
    const db = (0, database_1.getDatabase)();
    const row = db.prepare('SELECT * FROM file_tree WHERE local_hash = ? LIMIT 1').get(localHash);
    return row ? mapRow(row) : null;
}
function getAllFiles() {
    const db = (0, database_1.getDatabase)();
    const rows = db.prepare('SELECT * FROM file_tree ORDER BY local_rel_path').all();
    return rows.map(mapRow);
}
function getFilesByStatus(status) {
    const db = (0, database_1.getDatabase)();
    const rows = db.prepare('SELECT * FROM file_tree WHERE sync_status = ? ORDER BY local_rel_path').all(status);
    return rows.map(mapRow);
}
function deleteFileEntry(localRelPath) {
    const db = (0, database_1.getDatabase)();
    db.prepare('DELETE FROM file_tree WHERE local_rel_path = ?').run(localRelPath);
}
function getSyncStatusCounts() {
    const db = (0, database_1.getDatabase)();
    const rows = db.prepare('SELECT sync_status, COUNT(*) as cnt FROM file_tree GROUP BY sync_status').all();
    const result = { synced: 0, localOnly: 0, conflict: 0, error: 0, uploading: 0, total: 0 };
    for (const row of rows) {
        result.total += row.cnt;
        if (row.sync_status === 'synced')
            result.synced = row.cnt;
        else if (row.sync_status === 'local_only')
            result.localOnly = row.cnt;
        else if (row.sync_status === 'conflict')
            result.conflict = row.cnt;
        else if (row.sync_status === 'error')
            result.error = row.cnt;
        else if (row.sync_status === 'uploading')
            result.uploading = row.cnt;
    }
    return result;
}
function mapRow(row) {
    const isFolderExplicit = row.is_folder === 1;
    const name = row.name;
    const size = row.size;
    const syncStatus = row.sync_status;
    const isFolder = isFolderExplicit || (size === 0 && !/\.\w{2,6}$/i.test(name || ''));
    return {
        fileId: row.file_id,
        localRelPath: row.local_rel_path,
        remotePath: row.remote_path,
        name,
        size,
        mimeType: row.mime_type,
        isFolder,
        localMtimeMs: row.local_mtime_ms,
        localHash: row.local_hash,
        remoteHash: row.remote_hash,
        remoteUpdatedAt: row.remote_updated_at,
        syncStatus,
        syncTaskId: row.sync_task_id,
        syncError: row.sync_error,
    };
}
//# sourceMappingURL=file-tree-repo.js.map