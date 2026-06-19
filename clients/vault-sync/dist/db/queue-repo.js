"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.addToQueue = addToQueue;
exports.getQueueEntry = getQueueEntry;
exports.getQueueEntryByPath = getQueueEntryByPath;
exports.hasActiveQueueEntry = hasActiveQueueEntry;
exports.getPendingEntries = getPendingEntries;
exports.getActiveCount = getActiveCount;
exports.getAllQueueEntries = getAllQueueEntries;
exports.updateQueueEntry = updateQueueEntry;
exports.removeQueueEntry = removeQueueEntry;
exports.clearCompleted = clearCompleted;
exports.resetStuckEntries = resetStuckEntries;
exports.clearStaleUploadSessions = clearStaleUploadSessions;
exports.requeueFailedEntries = requeueFailedEntries;
exports.requeuePathIfFailed = requeuePathIfFailed;
exports.dedupePendingEntries = dedupePendingEntries;
exports.cancelInvalidPendingEntries = cancelInvalidPendingEntries;
exports.prepareQueueAfterRestart = prepareQueueAfterRestart;
const database_1 = require("./database");
const paths_1 = require("../services/paths");
function addToQueue(entry) {
    const localRelPath = (0, paths_1.normalizeRelPath)(entry.localRelPath);
    if (hasActiveQueueEntry(localRelPath)) {
        return -1;
    }
    const db = (0, database_1.getDatabase)();
    const result = db.prepare(`
    INSERT INTO upload_queue (file_id, local_rel_path, local_hash, size, mime_type, status, upload_mode, retry_count, max_retries, task_id, session_json, priority)
    VALUES (@fileId, @localRelPath, @localHash, @size, @mimeType, @status, @uploadMode, @retryCount, @maxRetries, @taskId, @sessionJson, @priority)
  `).run({
        fileId: entry.fileId,
        localRelPath,
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
function getQueueEntry(id) {
    const db = (0, database_1.getDatabase)();
    const row = db.prepare('SELECT * FROM upload_queue WHERE id = ?').get(id);
    return row ? mapQueueRow(row) : null;
}
function getQueueEntryByPath(localRelPath) {
    const db = (0, database_1.getDatabase)();
    const row = db.prepare('SELECT * FROM upload_queue WHERE local_rel_path = ? AND status != ? ORDER BY id DESC LIMIT 1')
        .get((0, paths_1.normalizeRelPath)(localRelPath), 'done');
    return row ? mapQueueRow(row) : null;
}
function hasActiveQueueEntry(localRelPath) {
    const db = (0, database_1.getDatabase)();
    const row = db.prepare("SELECT 1 FROM upload_queue WHERE local_rel_path = ? AND status IN ('pending', 'hashing', 'uploading') LIMIT 1").get((0, paths_1.normalizeRelPath)(localRelPath));
    return !!row;
}
function getPendingEntries(limit = 10) {
    const db = (0, database_1.getDatabase)();
    const rows = db.prepare('SELECT * FROM upload_queue WHERE status IN (?, ?) ORDER BY priority DESC, id ASC LIMIT ?')
        .all('pending', 'hashing', limit);
    return rows.map(mapQueueRow);
}
function getActiveCount() {
    const db = (0, database_1.getDatabase)();
    const row = db.prepare("SELECT COUNT(*) as cnt FROM upload_queue WHERE status IN ('hashing', 'uploading')").get();
    return row.cnt;
}
function getAllQueueEntries() {
    const db = (0, database_1.getDatabase)();
    const rows = db.prepare('SELECT * FROM upload_queue ORDER BY id DESC').all();
    return rows.map(mapQueueRow);
}
function updateQueueEntry(id, patch) {
    const sets = [];
    const params = { id };
    for (const [key, value] of Object.entries(patch)) {
        const col = camelToSnake(key);
        sets.push(`${col} = @${key}`);
        params[key] = value;
    }
    if (!sets.length)
        return;
    const db = (0, database_1.getDatabase)();
    db.prepare(`UPDATE upload_queue SET ${sets.join(', ')} WHERE id = @id`).run(params);
}
function removeQueueEntry(id) {
    const db = (0, database_1.getDatabase)();
    db.prepare('DELETE FROM upload_queue WHERE id = ?').run(id);
}
function clearCompleted() {
    const db = (0, database_1.getDatabase)();
    db.prepare("DELETE FROM upload_queue WHERE status = 'done'").run();
}
function resetStuckEntries() {
    const db = (0, database_1.getDatabase)();
    db.prepare(`
    UPDATE upload_queue
    SET status = 'pending', error = 'Reset after restart', file_id = NULL, task_id = NULL, session_json = NULL
    WHERE status IN ('hashing', 'uploading')
  `).run();
}
function clearStaleUploadSessions() {
    const db = (0, database_1.getDatabase)();
    const result = db.prepare(`
    UPDATE upload_queue
    SET file_id = NULL, task_id = NULL, session_json = NULL
    WHERE status IN ('pending', 'error') AND (file_id IS NOT NULL OR task_id IS NOT NULL)
  `).run();
    return result.changes;
}
function requeueFailedEntries() {
    const db = (0, database_1.getDatabase)();
    db.prepare("UPDATE upload_queue SET status = 'pending', retry_count = 0, error = NULL WHERE status = 'error'").run();
}
function requeuePathIfFailed(localRelPath) {
    const db = (0, database_1.getDatabase)();
    db.prepare("UPDATE upload_queue SET status = 'pending', retry_count = 0, error = NULL, priority = 10 WHERE local_rel_path = ? AND status = 'error'").run((0, paths_1.normalizeRelPath)(localRelPath));
}
function dedupePendingEntries() {
    const db = (0, database_1.getDatabase)();
    const result = db.prepare(`
    DELETE FROM upload_queue
    WHERE status = 'pending'
      AND id NOT IN (
        SELECT MAX(id) FROM upload_queue WHERE status = 'pending' GROUP BY local_rel_path
      )
  `).run();
    return result.changes;
}
function cancelInvalidPendingEntries() {
    const db = (0, database_1.getDatabase)();
    const result = db.prepare(`
    UPDATE upload_queue
    SET status = 'error', error = 'Invalid queue entry (zero size)'
    WHERE status = 'pending' AND size <= 0
  `).run();
    return result.changes;
}
function prepareQueueAfterRestart() {
    resetStuckEntries();
    requeueFailedEntries();
    const cancelled = cancelInvalidPendingEntries();
    const deduped = dedupePendingEntries();
    const sessionsCleared = clearStaleUploadSessions();
    (0, database_1.getDatabase)().prepare("UPDATE upload_queue SET priority = 10 WHERE status = 'pending' AND priority < 10").run();
    return { deduped, cancelled, sessionsCleared };
}
function camelToSnake(str) {
    return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
function mapQueueRow(row) {
    return {
        id: row.id,
        fileId: row.file_id,
        localRelPath: row.local_rel_path,
        localHash: row.local_hash,
        size: row.size,
        mimeType: row.mime_type,
        status: row.status,
        uploadMode: row.upload_mode,
        percent: row.percent,
        error: row.error,
        retryCount: row.retry_count,
        maxRetries: row.max_retries,
        taskId: row.task_id,
        sessionJson: row.session_json,
        createdAt: row.created_at,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        priority: row.priority,
    };
}
//# sourceMappingURL=queue-repo.js.map