/**
 * Storage health — orphan chunks, confirmed missing, broken references.
 */
const db = require('../db/database');

function listOrphanChunks(userId, { limit = 100, linkedAccountId = null } = {}) {
  const params = [userId];
  let accountFilter = '';
  if (linkedAccountId) {
    accountFilter = ' AND csf.linked_account_id = ?';
    params.push(linkedAccountId);
  }
  params.push(limit);

  const failures = db.prepare(`
    SELECT csf.chunk_id, csf.linked_account_id, csf.fail_count, csf.last_fail_at,
           csf.next_retry_at, csf.last_error, csf.confirmed_missing,
           c.file_id, c.repo_path, c.repo_id, c.chunk_index, c.size,
           f.name as file_name, f.path as file_path,
           la.username as backup_username
    FROM chunk_sync_failures csf
    JOIN chunks c ON c.id = csf.chunk_id
    JOIN files f ON f.id = c.file_id
    LEFT JOIN linked_accounts la ON la.id = csf.linked_account_id
    WHERE f.user_id = ?${accountFilter}
    ORDER BY csf.confirmed_missing DESC, csf.fail_count DESC
    LIMIT ?
  `).all(...params);

  const missingBackup = db.prepare(`
    SELECT c.id as chunk_id, c.file_id, c.repo_path, c.chunk_index, c.size,
           f.name as file_name, f.path as file_path,
           br.full_name as backup_repo, la.username as backup_username, la.id as linked_account_id
    FROM chunks c
    JOIN files f ON f.id = c.file_id
    JOIN storage_repos pr ON c.repo_id = pr.id
    JOIN storage_repos br ON br.mirrors_repo_id = pr.id AND br.repo_role = 'backup'
    JOIN linked_accounts la ON br.linked_account_id = la.id AND la.is_active = 1
    WHERE f.user_id = ?
      AND (f.upload_status IS NULL OR f.upload_status = 'ready')
      AND NOT EXISTS (
        SELECT 1 FROM chunk_backups cb WHERE cb.chunk_id = c.id AND cb.repo_id = br.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM chunk_sync_failures csf
        WHERE csf.chunk_id = c.id AND csf.linked_account_id = la.id AND csf.confirmed_missing = 1
      )
    LIMIT ?
  `).all(userId, limit);

  return {
    confirmed_missing: failures.filter((r) => r.confirmed_missing),
    in_backoff: failures.filter((r) => !r.confirmed_missing),
    pending_backup: missingBackup,
    totals: {
      confirmed_missing: failures.filter((r) => r.confirmed_missing).length,
      in_backoff: failures.filter((r) => !r.confirmed_missing).length,
      pending_backup: missingBackup.length,
    },
  };
}

function cleanupOrphanFailure(userId, chunkId, linkedAccountId) {
  const row = db.prepare(`
    SELECT csf.chunk_id FROM chunk_sync_failures csf
    JOIN chunks c ON c.id = csf.chunk_id
    JOIN files f ON f.id = c.file_id
    WHERE f.user_id = ? AND csf.chunk_id = ? AND csf.linked_account_id = ?
  `).get(userId, chunkId, linkedAccountId);
  if (!row) return false;
  db.prepare('DELETE FROM chunk_sync_failures WHERE chunk_id = ? AND linked_account_id = ?')
    .run(chunkId, linkedAccountId);
  return true;
}

function clearBackoffForAccount(userId, linkedAccountId) {
  const r = db.prepare(`
    DELETE FROM chunk_sync_failures
    WHERE linked_account_id = ?
      AND chunk_id IN (
        SELECT c.id FROM chunks c JOIN files f ON f.id = c.file_id WHERE f.user_id = ?
      )
  `).run(linkedAccountId, userId);
  return r.changes;
}

module.exports = {
  listOrphanChunks,
  cleanupOrphanFailure,
  clearBackoffForAccount,
};
