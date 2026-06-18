"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.addToQueue = addToQueue;
exports.getQueueEntry = getQueueEntry;
exports.getQueueEntryByPath = getQueueEntryByPath;
exports.getPendingEntries = getPendingEntries;
exports.getActiveCount = getActiveCount;
exports.getAllQueueEntries = getAllQueueEntries;
exports.updateQueueEntry = updateQueueEntry;
exports.removeQueueEntry = removeQueueEntry;
exports.clearCompleted = clearCompleted;
exports.resetStuckEntries = resetStuckEntries;
const database_1 = require("./database");
function addToQueue(entry) {
    const db = (0, database_1.getDatabase)();
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
function getQueueEntry(id) {
    const db = (0, database_1.getDatabase)();
    const row = db.prepare('SELECT * FROM upload_queue WHERE id = ?').get(id);
    return row ? mapQueueRow(row) : null;
}
function getQueueEntryByPath(localRelPath) {
    const db = (0, database_1.getDatabase)();
    const row = db.prepare('SELECT * FROM upload_queue WHERE local_rel_path = ? AND status != ? ORDER BY id DESC LIMIT 1')
        .get(localRelPath, 'done');
    return row ? mapQueueRow(row) : null;
}
function getPendingEntries(limit = 10) {
    const db = (0, database_1.getDatabase)();
    const rows = db.prepare('SELECT * FROM upload_queue WHERE status IN (?, ?, ?) ORDER BY priority DESC, id ASC LIMIT ?')
        .all('pending', 'hashing', 'uploading', limit);
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
    db.prepare("UPDATE upload_queue SET status = 'pending', error = 'Reset after restart' WHERE status IN ('hashing', 'uploading')").run();
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