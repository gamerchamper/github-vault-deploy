const db = require('../db/database');

function parseViewParam(viewStr) {
  if (!viewStr || viewStr === 'primary') return { type: 'primary' };
  const [type, id] = String(viewStr).split(':');
  const accountId = parseInt(id, 10);
  if ((type === 'backup' || type === 'storage') && Number.isFinite(accountId)) {
    return { type, accountId };
  }
  return { type: 'primary' };
}

function listViews(userId) {
  const user = db.prepare('SELECT username FROM users WHERE id = ?').get(userId);
  const views = [{
    id: 'primary',
    type: 'primary',
    label: `Primary (@${user?.username || 'you'})`,
  }];

  const linked = db.prepare(`
    SELECT id, username, role, is_active FROM linked_accounts
    WHERE user_id = ? ORDER BY created_at ASC
  `).all(userId);

  for (const account of linked) {
    if (!account.is_active) continue;
    if (account.role === 'backup') {
      views.push({
        id: `backup:${account.id}`,
        type: 'backup',
        accountId: account.id,
        label: `Backup (@${account.username})`,
      });
    } else if (account.role === 'storage') {
      views.push({
        id: `storage:${account.id}`,
        type: 'storage',
        accountId: account.id,
        label: `Storage (@${account.username})`,
      });
    }
  }

  return views;
}

function getPrimaryStorageRepos(userId) {
  return db.prepare(`
    SELECT * FROM storage_repos
    WHERE user_id = ? AND is_metadata = 0
      AND (repo_role IS NULL OR repo_role = 'primary')
    ORDER BY id ASC
  `).all(userId);
}

function getFileChunkStats(userId, fileId, view) {
  const file = db.prepare(
    'SELECT id, chunk_count, is_folder FROM files WHERE id = ? AND user_id = ?'
  ).get(fileId, userId);
  if (!file || file.is_folder) {
    return { chunks_total: 0, chunks_available: 0, status: 'folder' };
  }

  const total = file.chunk_count || db.prepare(
    'SELECT COUNT(*) as c FROM chunks WHERE file_id = ?'
  ).get(fileId).c;

  if (view.type === 'primary') {
    return { chunks_total: total, chunks_available: total, status: 'synced' };
  }

  if (view.type === 'backup') {
    const backed = db.prepare(`
      SELECT COUNT(*) as c FROM chunks c
      WHERE c.file_id = ?
        AND EXISTS (
          SELECT 1 FROM chunk_backups cb
          JOIN storage_repos r ON cb.repo_id = r.id
          WHERE cb.chunk_id = c.id
            AND r.linked_account_id = ?
            AND r.repo_role = 'backup'
            AND r.mirrors_repo_id = c.repo_id
        )
    `).get(fileId, view.accountId).c;
    const status = backed === 0 ? 'none' : backed >= total ? 'synced' : 'partial';
    return { chunks_total: total, chunks_available: backed, status };
  }

  if (view.type === 'storage') {
    const onAccount = db.prepare(`
      SELECT COUNT(*) as c FROM chunks c
      JOIN storage_repos r ON c.repo_id = r.id
      WHERE c.file_id = ? AND r.linked_account_id = ?
    `).get(fileId, view.accountId).c;
    const status = onAccount === 0 ? 'none' : onAccount >= total ? 'synced' : 'partial';
    return { chunks_total: total, chunks_available: onAccount, status };
  }

  return { chunks_total: total, chunks_available: total, status: 'synced' };
}

function folderVisibleInView(userId, folderPath, view) {
  const files = db.prepare(`
    SELECT id, path, is_folder FROM files
    WHERE user_id = ? AND path LIKE ?
      AND (upload_status IS NULL OR upload_status = 'ready')
  `).all(userId, `${folderPath === '/' ? '' : folderPath}%`);

  for (const entry of files) {
    if (entry.is_folder) continue;
    const stats = getFileChunkStats(userId, entry.id, view);
    if (stats.chunks_available > 0) return true;
  }
  return view.type === 'primary';
}

module.exports = {
  parseViewParam,
  listViews,
  getPrimaryStorageRepos,
  getFileChunkStats,
  folderVisibleInView,
};
