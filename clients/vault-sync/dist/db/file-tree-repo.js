"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.upsertFile = upsertFile;
exports.getFileByRelPath = getFileByRelPath;
exports.getFileByFileId = getFileByFileId;
exports.getFileByHash = getFileByHash;
exports.getAllFiles = getAllFiles;
exports.getFilesByStatus = getFilesByStatus;
exports.getFilesUnderPrefix = getFilesUnderPrefix;
exports.relocatePathPrefix = relocatePathPrefix;
exports.deleteFileEntry = deleteFileEntry;
exports.getSyncStatusCounts = getSyncStatusCounts;
const path_1 = __importDefault(require("path"));
const database_1 = require("./database");
const paths_1 = require("../services/paths");
function upsertFile(db, entry) {
    const localRelPath = (0, paths_1.normalizeRelPath)(entry.localRelPath);
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
function getFileByRelPath(localRelPath) {
    const db = (0, database_1.getDatabase)();
    const row = db.prepare('SELECT * FROM file_tree WHERE local_rel_path = ?').get((0, paths_1.normalizeRelPath)(localRelPath));
    return row ? mapRow(row) : null;
}
function getFileByFileId(fileId) {
    const db = (0, database_1.getDatabase)();
    const row = db.prepare('SELECT * FROM file_tree WHERE file_id = ?').get(fileId);
    return row ? mapRow(row) : null;
}
function getFileByHash(localHash, excludeRelPath) {
    const db = (0, database_1.getDatabase)();
    const exclude = excludeRelPath ? (0, paths_1.normalizeRelPath)(excludeRelPath) : undefined;
    const row = exclude
        ? db.prepare('SELECT * FROM file_tree WHERE local_hash = ? AND local_rel_path != ? LIMIT 1').get(localHash, exclude)
        : db.prepare('SELECT * FROM file_tree WHERE local_hash = ? LIMIT 1').get(localHash);
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
function getFilesUnderPrefix(prefix) {
    const db = (0, database_1.getDatabase)();
    const normalized = (0, paths_1.normalizeRelPath)(prefix).replace(/\/$/, '');
    const pattern = `${normalized}/%`;
    const rows = db.prepare('SELECT * FROM file_tree WHERE local_rel_path = ? OR local_rel_path LIKE ? ORDER BY local_rel_path').all(normalized, pattern);
    return rows.map(mapRow);
}
function relocatePathPrefix(oldPrefix, newPrefix) {
    const db = (0, database_1.getDatabase)();
    const oldP = (0, paths_1.normalizeRelPath)(oldPrefix).replace(/\/$/, '');
    const newP = (0, paths_1.normalizeRelPath)(newPrefix).replace(/\/$/, '');
    const allRows = db.prepare('SELECT * FROM file_tree WHERE local_rel_path = ? OR local_rel_path LIKE ?').all(oldP, `${oldP}/%`);
    for (const row of allRows) {
        const entry = mapRow(row);
        const suffix = entry.localRelPath === oldP ? '' : entry.localRelPath.slice(oldP.length);
        const newRel = newP + suffix;
        const newName = suffix === '' ? path_1.default.basename(newP) : path_1.default.basename(newRel);
        db.prepare('DELETE FROM file_tree WHERE local_rel_path = ?').run(entry.localRelPath);
        upsertFile(db, {
            ...entry,
            localRelPath: newRel,
            remotePath: `/${newRel}`,
            name: newName,
            isFolder: entry.isFolder || suffix === '',
        });
    }
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