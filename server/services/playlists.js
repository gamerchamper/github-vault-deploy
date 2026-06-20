const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const appUrl = require('./app-url');
const episodeMeta = require('./episode-meta');

const VISIBILITY = ['public', 'private', 'unlisted'];

function generateToken() {
  return uuidv4().replace(/-/g, '');
}

function validateVisibility(v) {
  return VISIBILITY.includes(v) ? v : 'private';
}

function sanitizeDisplayName(name) {
  if (name == null || name === '') return null;
  const trimmed = String(name).trim();
  return trimmed ? trimmed.slice(0, 128) : null;
}

function fileRowToItem(row) {
  if (!row) return null;
  const displayName = sanitizeDisplayName(row.display_name);
  return {
    id: row.id,
    name: row.name,
    display_name: displayName,
    path: row.path,
    size: row.size,
    mime_type: row.mime_type,
    chunk_count: row.chunk_count,
    has_thumbnail: row.has_thumbnail,
    has_hls: row.has_hls,
    hls_segment_count: Number(row.hls_segment_count) || 0,
    hls_duration_sec: Number(row.hls_duration_sec) || 0,
    parent_path: row.parent_path,
    position: row.position,
    added_at: row.added_at,
    folder_link_id: row.folder_link_id ?? null,
    sync_managed: !!row.folder_link_id,
    progress_pct: row.progress_pct ?? null,
    completed: row.completed ?? null,
    position_seconds: row.position_seconds ?? null,
  };
}

function enrichPlaylist(row, userId = null, req = null) {
  if (!row) return null;
  const stats = db.prepare(`
    SELECT COUNT(*) AS item_count, COALESCE(SUM(f.size), 0) AS total_bytes
    FROM playlist_items pi
    JOIN files f ON f.id = pi.file_id AND f.is_deleted = 0 AND f.is_folder = 0
    WHERE pi.playlist_id = ?
  `).get(row.id);

  const cover = row.cover_file_id
    ? db.prepare('SELECT id, name, has_thumbnail FROM files WHERE id = ? AND is_deleted = 0').get(row.cover_file_id)
    : db.prepare(`
        SELECT f.id, f.name, f.has_thumbnail
        FROM playlist_items pi
        JOIN files f ON f.id = pi.file_id AND f.is_deleted = 0 AND f.has_thumbnail = 1
        WHERE pi.playlist_id = ?
        ORDER BY pi.position ASC LIMIT 1
      `).get(row.id);

  const result = {
    id: row.id,
    title: row.title,
    description: row.description || '',
    cover_file_id: row.cover_file_id,
    cover_thumbnail_id: cover?.id || null,
    visibility: row.visibility || 'private',
    share_token: row.share_token || null,
    sort_regex: row.sort_regex || null,
    item_count: stats?.item_count || 0,
    total_bytes: stats?.total_bytes || 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };

  if (row.share_token && req) {
    result.share_url = appUrl.publicUrl(req, `/share/p/${row.share_token}`);
  }
  if (userId) {
    result.owner_id = row.user_id;
  }
  return result;
}

function enrichCollection(row, req = null) {
  if (!row) return null;
  const playlistCount = db.prepare(
    'SELECT COUNT(*) AS c FROM collection_playlists WHERE collection_id = ?'
  ).get(row.id);

  const cover = row.cover_file_id
    ? db.prepare('SELECT id, name, has_thumbnail FROM files WHERE id = ?').get(row.cover_file_id)
    : null;

  const result = {
    id: row.id,
    title: row.title,
    description: row.description || '',
    cover_file_id: row.cover_file_id,
    cover_thumbnail_id: cover?.id || null,
    visibility: row.visibility || 'private',
    share_token: row.share_token || null,
    playlist_count: playlistCount?.c || 0,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };

  if (row.share_token && req) {
    result.share_url = appUrl.publicUrl(req, `/share/c/${row.share_token}`);
  }
  return result;
}

function assertFolderOwned(userId, folderId) {
  const folder = db.prepare(`
    SELECT id, path, name FROM files
    WHERE id = ? AND user_id = ? AND is_deleted = 0 AND is_folder = 1
  `).get(folderId, userId);
  if (!folder) throw new Error('Folder not found');
  return folder;
}

function listFolderLinks(playlistId) {
  return db.prepare(`
    SELECT l.id, l.folder_id, l.include_subfolders, l.sort_by, l.sort_order, l.last_synced_at,
           f.name AS folder_name, f.path AS folder_path
    FROM playlist_folder_links l
    JOIN files f ON f.id = l.folder_id
    WHERE l.playlist_id = ?
    ORDER BY l.id ASC
  `).all(playlistId).map((row) => ({
    id: row.id,
    folder_id: row.folder_id,
    folder_name: row.folder_name,
    folder_path: row.folder_path,
    include_subfolders: !!row.include_subfolders,
    sort_by: row.sort_by || 'name',
    sort_order: row.sort_order || 'ASC',
    last_synced_at: row.last_synced_at,
  }));
}

function sortFileRows(rows, sortBy, sortOrder) {
  const sorted = [...rows];
  if (sortBy === 'smart') {
    sorted.sort((a, b) => {
      const cmp = episodeMeta.compareEpisodeTitles(a.name, b.name, a.parent_path, b.parent_path);
      return sortOrder === 'DESC' ? -cmp : cmp;
    });
    return sorted;
  }
  const dir = sortOrder === 'DESC' ? -1 : 1;
  if (sortBy === 'created_at') {
    sorted.sort((a, b) => dir * String(a.created_at || '').localeCompare(String(b.created_at || '')));
  } else {
    sorted.sort((a, b) => dir * a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  }
  return sorted;
}

function listFilesForFolderLink(userId, folder, includeSubfolders) {
  if (includeSubfolders) {
    const childPrefix = folder.path === '/' ? '/%' : `${folder.path}/%`;
    return db.prepare(`
      SELECT id, name, parent_path, created_at FROM files
      WHERE user_id = ? AND is_deleted = 0 AND is_folder = 0
        AND (upload_status IS NULL OR upload_status = 'ready')
        AND (parent_path = ? OR path LIKE ?)
    `).all(userId, folder.path, childPrefix);
  }
  return db.prepare(`
    SELECT id, name, parent_path, created_at FROM files
    WHERE user_id = ? AND parent_path = ? AND is_deleted = 0 AND is_folder = 0
      AND (upload_status IS NULL OR upload_status = 'ready')
  `).all(userId, folder.path);
}

function fileMatchesFolderLink(file, folderPath, includeSubfolders) {
  if (!file || file.is_folder) return false;
  if (file.parent_path === folderPath) return true;
  if (!includeSubfolders) return false;
  const prefix = folderPath === '/' ? '/' : `${folderPath}/`;
  return file.path.startsWith(prefix);
}

function rebuildPlaylistPositions(playlistId) {
  const playlist = db.prepare('SELECT user_id FROM playlists WHERE id = ?').get(playlistId);
  if (!playlist) return;

  const links = db.prepare(
    'SELECT * FROM playlist_folder_links WHERE playlist_id = ? ORDER BY id ASC'
  ).all(playlistId);

  const linkTargets = new Map();
  for (const link of links) {
    const folder = db.prepare('SELECT * FROM files WHERE id = ? AND is_deleted = 0').get(link.folder_id);
    if (!folder) {
      linkTargets.set(link.id, new Set());
      continue;
    }
    const files = listFilesForFolderLink(playlist.user_id, folder, !!link.include_subfolders);
    linkTargets.set(link.id, new Set(files.map((f) => f.id)));
  }

  const currentItems = db.prepare(`
    SELECT pi.file_id, pi.folder_link_id
    FROM playlist_items pi
    JOIN files f ON f.id = pi.file_id AND f.is_deleted = 0 AND f.is_folder = 0
    WHERE pi.playlist_id = ?
    ORDER BY pi.position ASC, pi.id ASC
  `).all(playlistId);

  const kept = [];
  const keptSet = new Set();
  for (const item of currentItems) {
    if (item.folder_link_id) {
      const targets = linkTargets.get(item.folder_link_id);
      if (!targets?.has(item.file_id)) continue;
    }
    kept.push(item.file_id);
    keptSet.add(item.file_id);
  }

  const toAppend = [];
  for (const link of links) {
    const targets = linkTargets.get(link.id);
    if (!targets?.size) continue;
    const missing = [...targets].filter((id) => !keptSet.has(id));
    if (!missing.length) continue;
    const folder = db.prepare('SELECT * FROM files WHERE id = ? AND is_deleted = 0').get(link.folder_id);
    if (!folder) continue;
    const rows = listFilesForFolderLink(playlist.user_id, folder, !!link.include_subfolders)
      .filter((f) => missing.includes(f.id));
    const sorted = sortFileRows(rows, link.sort_by, link.sort_order);
    for (const f of sorted) {
      toAppend.push(f.id);
      keptSet.add(f.id);
    }
  }

  const finalOrder = [...kept, ...toAppend];
  const upd = db.prepare('UPDATE playlist_items SET position = ? WHERE playlist_id = ? AND file_id = ?');
  finalOrder.forEach((fileId, idx) => upd.run(idx, playlistId, fileId));
}

function syncPlaylistFolderLink(userId, linkId) {
  const link = db.prepare(`
    SELECT l.*, p.user_id AS playlist_user_id
    FROM playlist_folder_links l
    JOIN playlists p ON p.id = l.playlist_id
    WHERE l.id = ? AND p.user_id = ?
  `).get(linkId, userId);
  if (!link) throw new Error('Folder link not found');

  const folder = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(link.folder_id, userId);
  if (!folder || folder.is_deleted || !folder.is_folder) {
    db.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND folder_link_id = ?')
      .run(link.playlist_id, linkId);
    rebuildPlaylistPositions(link.playlist_id);
    db.prepare('UPDATE playlist_folder_links SET last_synced_at = CURRENT_TIMESTAMP WHERE id = ?').run(linkId);
    return { added: 0, removed: 0 };
  }

  const sorted = sortFileRows(
    listFilesForFolderLink(userId, folder, !!link.include_subfolders),
    link.sort_by,
    link.sort_order,
  );
  const targetIds = sorted.map((f) => f.id);
  const targetSet = new Set(targetIds);

  let removed = 0;
  const managed = db.prepare(
    'SELECT file_id FROM playlist_items WHERE playlist_id = ? AND folder_link_id = ?'
  ).all(link.playlist_id, linkId);
  const del = db.prepare(
    'DELETE FROM playlist_items WHERE playlist_id = ? AND file_id = ? AND folder_link_id = ?'
  );
  for (const { file_id: fileId } of managed) {
    if (!targetSet.has(fileId)) {
      del.run(link.playlist_id, fileId, linkId);
      removed += 1;
    }
  }

  const insert = db.prepare(`
    INSERT INTO playlist_items (playlist_id, file_id, position, folder_link_id)
    VALUES (?, ?, ?, ?)
  `);
  let added = 0;
  let nextPos = db.prepare(
    'SELECT COALESCE(MAX(position), -1) AS m FROM playlist_items WHERE playlist_id = ?'
  ).get(link.playlist_id).m + 1;
  for (const fileId of targetIds) {
    const existing = db.prepare(
      'SELECT folder_link_id FROM playlist_items WHERE playlist_id = ? AND file_id = ?'
    ).get(link.playlist_id, fileId);
    if (existing) continue;
    try {
      assertFileOwned(userId, fileId);
      insert.run(link.playlist_id, fileId, nextPos, linkId);
      nextPos += 1;
      added += 1;
    } catch {
      /* file became unavailable during sync */
    }
  }

  rebuildPlaylistPositions(link.playlist_id);
  db.prepare('UPDATE playlist_folder_links SET last_synced_at = CURRENT_TIMESTAMP WHERE id = ?').run(linkId);
  if (added || removed) {
    db.prepare('UPDATE playlists SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(link.playlist_id);
  }
  return { added, removed };
}

function syncPlaylistsForFolder(userId, folderId) {
  const links = db.prepare(`
    SELECT l.id FROM playlist_folder_links l
    JOIN playlists p ON p.id = l.playlist_id AND p.user_id = ?
    WHERE l.folder_id = ?
  `).all(userId, folderId);
  for (const { id } of links) syncPlaylistFolderLink(userId, id);
}

function syncPlaylistsForFile(userId, fileId) {
  const file = db.prepare(`
    SELECT id, parent_path, path, is_folder, is_deleted FROM files WHERE id = ? AND user_id = ?
  `).get(fileId, userId);
  if (!file) return;

  const links = db.prepare(`
    SELECT l.id, l.folder_id, l.include_subfolders, f.path AS folder_path
    FROM playlist_folder_links l
    JOIN playlists p ON p.id = l.playlist_id AND p.user_id = ?
    JOIN files f ON f.id = l.folder_id
  `).all(userId);

  const affected = new Set();
  for (const link of links) {
    if (file.is_folder && file.id === link.folder_id) {
      affected.add(link.id);
      continue;
    }
    if (!file.is_folder && fileMatchesFolderLink(file, link.folder_path, !!link.include_subfolders)) {
      affected.add(link.id);
    }
  }
  for (const linkId of affected) syncPlaylistFolderLink(userId, linkId);
}

function linkFolder(userId, playlistId, folderId, options = {}) {
  const pl = db.prepare('SELECT id FROM playlists WHERE id = ? AND user_id = ?').get(playlistId, userId);
  if (!pl) throw new Error('Playlist not found');
  assertFolderOwned(userId, folderId);

  const includeSubfolders = options.include_subfolders ? 1 : 0;
  const sortBy = options.sort_by === 'created_at'
    ? 'created_at'
    : options.sort_by === 'smart'
      ? 'smart'
      : 'name';
  const sortOrder = options.sort_order === 'DESC' ? 'DESC' : 'ASC';

  let linkId;
  try {
    const result = db.prepare(`
      INSERT INTO playlist_folder_links (playlist_id, folder_id, include_subfolders, sort_by, sort_order)
      VALUES (?, ?, ?, ?, ?)
    `).run(playlistId, folderId, includeSubfolders, sortBy, sortOrder);
    linkId = result.lastInsertRowid;
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) throw new Error('Folder already linked to this playlist');
    throw err;
  }

  syncPlaylistFolderLink(userId, linkId);
  return getPlaylist(userId, playlistId);
}

function unlinkFolder(userId, playlistId, folderId) {
  const link = db.prepare(`
    SELECT l.id FROM playlist_folder_links l
    JOIN playlists p ON p.id = l.playlist_id AND p.user_id = ?
    WHERE l.playlist_id = ? AND l.folder_id = ?
  `).get(userId, playlistId, folderId);
  if (!link) throw new Error('Folder link not found');

  db.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND folder_link_id = ?')
    .run(playlistId, link.id);
  db.prepare('DELETE FROM playlist_folder_links WHERE id = ?').run(link.id);
  normalizePositions(playlistId);
  db.prepare('UPDATE playlists SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(playlistId);
  return getPlaylist(userId, playlistId);
}

function syncPlaylist(userId, playlistId) {
  const pl = db.prepare('SELECT id FROM playlists WHERE id = ? AND user_id = ?').get(playlistId, userId);
  if (!pl) throw new Error('Playlist not found');
  const links = db.prepare('SELECT id FROM playlist_folder_links WHERE playlist_id = ?').all(playlistId);
  let added = 0;
  let removed = 0;
  for (const { id } of links) {
    const r = syncPlaylistFolderLink(userId, id);
    added += r.added;
    removed += r.removed;
  }
  return { added, removed, playlist: getPlaylist(userId, playlistId) };
}

function assertFileOwned(userId, fileId) {
  const file = db.prepare(`
    SELECT id FROM files
    WHERE id = ? AND user_id = ? AND is_deleted = 0 AND is_folder = 0
      AND (upload_status IS NULL OR upload_status = 'ready')
  `).get(fileId, userId);
  if (!file) throw new Error('File not found');
  return file;
}

function getPlaylist(userId, playlistId, req = null) {
  const row = db.prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ?').get(playlistId, userId);
  if (!row) throw new Error('Playlist not found');
  const playlist = enrichPlaylist(row, userId, req);
  playlist.items = listPlaylistItems(userId, playlistId);
  playlist.folder_links = listFolderLinks(playlistId);
  return playlist;
}

function listPlaylistItems(userId, playlistId, { limit, offset } = {}) {
  let sql = `
    SELECT f.id, f.name, f.path, f.size, f.mime_type, f.chunk_count, f.has_thumbnail, f.has_hls,
           f.parent_path, pi.position, pi.added_at, pi.display_name, pi.folder_link_id,
           pp.progress_pct, pp.completed, pp.position_seconds,
           (SELECT COUNT(*) FROM hls_segments WHERE file_id = f.id) AS hls_segment_count,
           (SELECT COALESCE(SUM(duration), 0) FROM hls_segments WHERE file_id = f.id) AS hls_duration_sec
    FROM playlist_items pi
    JOIN files f ON f.id = pi.file_id AND f.is_deleted = 0 AND f.is_folder = 0
    LEFT JOIN playlist_progress pp ON pp.file_id = f.id AND pp.playlist_id = pi.playlist_id AND pp.user_id = ?
    WHERE pi.playlist_id = ?
    ORDER BY pi.position ASC, pi.id ASC
  `;
  const params = [userId, playlistId];
  if (limit) {
    sql += ' LIMIT ? OFFSET ?';
    params.push(limit, offset || 0);
  }
  return db.prepare(sql).all(...params).map(fileRowToItem);
}

function listPlaylists(userId, req = null) {
  const rows = db.prepare(`
    SELECT * FROM playlists WHERE user_id = ? ORDER BY updated_at DESC
  `).all(userId);
  return rows.map((r) => enrichPlaylist(r, userId, req));
}

function createPlaylist(userId, { title, description = '', visibility = 'private', cover_file_id = null }) {
  if (!title?.trim()) throw new Error('Title is required');
  const id = uuidv4();
  if (cover_file_id) assertFileOwned(userId, cover_file_id);
  db.prepare(`
    INSERT INTO playlists (id, user_id, title, description, cover_file_id, visibility)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, userId, title.trim(), description || '', cover_file_id, validateVisibility(visibility));
  return getPlaylist(userId, id);
}

function updatePlaylist(userId, playlistId, patch) {
  const existing = db.prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ?').get(playlistId, userId);
  if (!existing) throw new Error('Playlist not found');

  const title = patch.title !== undefined ? String(patch.title).trim() : existing.title;
  const description = patch.description !== undefined ? patch.description : existing.description;
  const visibility = patch.visibility !== undefined ? validateVisibility(patch.visibility) : existing.visibility;
  let coverFileId = patch.cover_file_id !== undefined ? patch.cover_file_id : existing.cover_file_id;
  const sortRegex = patch.sort_regex !== undefined
    ? (patch.sort_regex ? String(patch.sort_regex).trim() : null)
    : existing.sort_regex;
  if (sortRegex) {
    try {
      // eslint-disable-next-line no-new
      new RegExp(sortRegex, 'i');
    } catch {
      throw new Error('Invalid sort regex');
    }
  }
  if (coverFileId) assertFileOwned(userId, coverFileId);

  db.prepare(`
    UPDATE playlists SET title = ?, description = ?, visibility = ?, cover_file_id = ?, sort_regex = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `).run(title, description, visibility, coverFileId, sortRegex, playlistId, userId);

  return getPlaylist(userId, playlistId);
}

function deletePlaylist(userId, playlistId) {
  const row = db.prepare('SELECT id FROM playlists WHERE id = ? AND user_id = ?').get(playlistId, userId);
  if (!row) throw new Error('Playlist not found');
  db.prepare('DELETE FROM playlists WHERE id = ?').run(playlistId);
  return { ok: true };
}

function duplicatePlaylist(userId, playlistId) {
  const src = getPlaylist(userId, playlistId);
  const copy = createPlaylist(userId, {
    title: `${src.title} (copy)`,
    description: src.description,
    visibility: 'private',
    cover_file_id: src.cover_file_id,
  });
  if (src.sort_regex) {
    updatePlaylist(userId, copy.id, { sort_regex: src.sort_regex });
  }
  if (src.items?.length) {
    const manualItems = src.items.filter((i) => !i.sync_managed);
    if (manualItems.length) {
      addItems(userId, copy.id, manualItems.map((i) => i.id));
      const named = manualItems.filter((i) => i.display_name);
      if (named.length) {
        updateItemsDisplayNames(userId, copy.id, named.map((i) => ({
          file_id: i.id,
          display_name: i.display_name,
        })));
      }
    }
  }
  for (const link of src.folder_links || []) {
    try {
      linkFolder(userId, copy.id, link.folder_id, {
        include_subfolders: link.include_subfolders,
        sort_by: link.sort_by,
        sort_order: link.sort_order,
      });
    } catch {
      /* folder may have been deleted */
    }
  }
  return getPlaylist(userId, copy.id);
}

function addItems(userId, playlistId, fileIds, { position } = {}) {
  const pl = db.prepare('SELECT id FROM playlists WHERE id = ? AND user_id = ?').get(playlistId, userId);
  if (!pl) throw new Error('Playlist not found');
  if (!Array.isArray(fileIds) || !fileIds.length) throw new Error('No files specified');

  const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM playlist_items WHERE playlist_id = ?')
    .get(playlistId).m;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO playlist_items (playlist_id, file_id, position) VALUES (?, ?, ?)
  `);

  let pos = position !== undefined ? position : maxPos + 1;
  const added = [];
  for (const fileId of fileIds) {
    assertFileOwned(userId, fileId);
    const r = insert.run(playlistId, fileId, pos);
    if (r.changes) {
      added.push(fileId);
      pos += 1;
    }
  }

  if (added.length) {
    db.prepare('UPDATE playlists SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(playlistId);
  }
  return { added: added.length, items: listPlaylistItems(userId, playlistId) };
}

function removeItem(userId, playlistId, fileId) {
  const pl = db.prepare('SELECT id FROM playlists WHERE id = ? AND user_id = ?').get(playlistId, userId);
  if (!pl) throw new Error('Playlist not found');
  db.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND file_id = ?').run(playlistId, fileId);
  normalizePositions(playlistId);
  db.prepare('UPDATE playlists SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(playlistId);
  return { ok: true };
}

function removeItems(userId, playlistId, fileIds) {
  if (!Array.isArray(fileIds) || !fileIds.length) throw new Error('No files specified');
  const pl = db.prepare('SELECT id FROM playlists WHERE id = ? AND user_id = ?').get(playlistId, userId);
  if (!pl) throw new Error('Playlist not found');
  const del = db.prepare('DELETE FROM playlist_items WHERE playlist_id = ? AND file_id = ?');
  for (const fileId of fileIds) del.run(playlistId, fileId);
  normalizePositions(playlistId);
  db.prepare('UPDATE playlists SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(playlistId);
  return { ok: true, items: listPlaylistItems(userId, playlistId) };
}

function normalizePositions(playlistId) {
  const items = db.prepare('SELECT id, file_id FROM playlist_items WHERE playlist_id = ? ORDER BY position ASC, id ASC')
    .all(playlistId);
  const upd = db.prepare('UPDATE playlist_items SET position = ? WHERE id = ?');
  items.forEach((item, idx) => upd.run(idx, item.id));
}

function pruneOrphanedPlaylistItems(playlistId) {
  const result = db.prepare(`
    DELETE FROM playlist_items
    WHERE playlist_id = ?
      AND file_id NOT IN (
        SELECT id FROM files WHERE is_deleted = 0 AND is_folder = 0
      )
  `).run(playlistId);
  if (result.changes > 0) normalizePositions(playlistId);
  return result.changes;
}

function updateItemDisplayName(userId, playlistId, fileId, displayName) {
  const pl = db.prepare('SELECT id FROM playlists WHERE id = ? AND user_id = ?').get(playlistId, userId);
  if (!pl) throw new Error('Playlist not found');
  const item = db.prepare('SELECT 1 FROM playlist_items WHERE playlist_id = ? AND file_id = ?').get(playlistId, fileId);
  if (!item) throw new Error('Item not found in playlist');
  const value = sanitizeDisplayName(displayName);
  db.prepare('UPDATE playlist_items SET display_name = ? WHERE playlist_id = ? AND file_id = ?')
    .run(value, playlistId, fileId);
  db.prepare('UPDATE playlists SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(playlistId);
  return { ok: true, display_name: value };
}

function updateItemsDisplayNames(userId, playlistId, items) {
  const pl = db.prepare('SELECT id FROM playlists WHERE id = ? AND user_id = ?').get(playlistId, userId);
  if (!pl) throw new Error('Playlist not found');
  if (!Array.isArray(items)) throw new Error('Invalid items');

  const upd = db.prepare('UPDATE playlist_items SET display_name = ? WHERE playlist_id = ? AND file_id = ?');
  for (const item of items) {
    if (!item?.file_id) continue;
    const exists = db.prepare('SELECT 1 FROM playlist_items WHERE playlist_id = ? AND file_id = ?')
      .get(playlistId, item.file_id);
    if (!exists) throw new Error('Item not found in playlist');
    upd.run(sanitizeDisplayName(item.display_name), playlistId, item.file_id);
  }
  db.prepare('UPDATE playlists SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(playlistId);
  return { items: listPlaylistItems(userId, playlistId) };
}

function reorderItems(userId, playlistId, orderedFileIds) {
  const pl = db.prepare('SELECT id FROM playlists WHERE id = ? AND user_id = ?').get(playlistId, userId);
  if (!pl) throw new Error('Playlist not found');
  if (!Array.isArray(orderedFileIds)) throw new Error('Invalid order');

  pruneOrphanedPlaylistItems(playlistId);

  const uniqueOrder = [];
  const seen = new Set();
  for (const id of orderedFileIds) {
    if (typeof id !== 'string' || seen.has(id)) continue;
    seen.add(id);
    uniqueOrder.push(id);
  }

  const existing = listPlaylistItems(userId, playlistId).map((i) => i.id);
  const existingSet = new Set(existing);

  let finalOrder = uniqueOrder;
  if (finalOrder.length !== existing.length) {
    const orderSet = new Set(finalOrder);
    const missing = existing.filter((id) => !orderSet.has(id));
    if (missing.length && finalOrder.every((id) => existingSet.has(id))) {
      finalOrder = [...finalOrder, ...missing];
    } else {
      throw new Error('Order must include all items');
    }
  }

  for (const id of finalOrder) {
    if (!existingSet.has(id)) throw new Error('Invalid file in order');
  }

  const upd = db.prepare('UPDATE playlist_items SET position = ? WHERE playlist_id = ? AND file_id = ?');
  finalOrder.forEach((fileId, idx) => upd.run(idx, playlistId, fileId));
  db.prepare('UPDATE playlists SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(playlistId);
  return { items: listPlaylistItems(userId, playlistId) };
}

function smartReorderItems(userId, playlistId) {
  const row = db.prepare('SELECT sort_regex FROM playlists WHERE id = ? AND user_id = ?').get(playlistId, userId);
  if (!row) throw new Error('Playlist not found');
  const items = listPlaylistItems(userId, playlistId);
  const before = items.map((i) => i.id);
  const sorted = row.sort_regex
    ? episodeMeta.sortItemsByRegex(items, row.sort_regex)
    : episodeMeta.sortItemsByEpisodeMeta(items);
  const after = sorted.map((i) => i.id);
  const result = reorderItems(userId, playlistId, after);
  const moved = after.filter((id, idx) => id !== before[idx]).length;
  return { ...result, moved, sort_regex: row.sort_regex || null };
}

function createShareToken(userId, playlistId, req = null) {
  const row = db.prepare('SELECT * FROM playlists WHERE id = ? AND user_id = ?').get(playlistId, userId);
  if (!row) throw new Error('Playlist not found');
  let token = row.share_token;
  if (!token) {
    token = generateToken();
    db.prepare('UPDATE playlists SET share_token = ?, visibility = CASE WHEN visibility = \'private\' THEN \'unlisted\' ELSE visibility END WHERE id = ?')
      .run(token, playlistId);
  }
  return { token, url: appUrl.publicUrl(req, `/share/p/${token}`) };
}

function revokeShareToken(userId, playlistId) {
  db.prepare('UPDATE playlists SET share_token = NULL WHERE id = ? AND user_id = ?').run(playlistId, userId);
  return { ok: true };
}

function resolvePlaylistFile(token, fileId) {
  const row = db.prepare(`
    SELECT p.id, p.user_id FROM playlists p
    WHERE p.share_token = ? AND p.visibility IN ('public', 'unlisted')
  `).get(token);
  if (!row || !fileId) return null;

  const inPlaylist = db.prepare(`
    SELECT 1 FROM playlist_items pi
    WHERE pi.playlist_id = ? AND pi.file_id = ?
  `).get(row.id, fileId);
  if (!inPlaylist) return null;

  return db.prepare(`
    SELECT * FROM files WHERE id = ? AND user_id = ? AND is_deleted = 0 AND is_folder = 0
  `).get(fileId, row.user_id);
}

function getByShareToken(token, req = null) {
  const row = db.prepare(`
    SELECT p.*, u.username AS owner_name, u.avatar_url AS owner_avatar
    FROM playlists p
    JOIN users u ON u.id = p.user_id
    WHERE p.share_token = ? AND p.visibility IN ('public', 'unlisted')
  `).get(token);
  if (!row) return null;

  const playlist = enrichPlaylist(row, null, req);
  playlist.owner_id = row.user_id;
  playlist.owner_name = row.owner_name;
  playlist.owner_avatar = row.owner_avatar;

  const items = db.prepare(`
    SELECT f.id, f.name, f.path, f.size, f.mime_type, f.chunk_count, f.has_thumbnail, f.has_hls,
           f.parent_path, pi.position, pi.added_at, pi.display_name,
           (SELECT COUNT(*) FROM hls_segments WHERE file_id = f.id) AS hls_segment_count,
           (SELECT COALESCE(SUM(duration), 0) FROM hls_segments WHERE file_id = f.id) AS hls_duration_sec
    FROM playlist_items pi
    JOIN files f ON f.id = pi.file_id AND f.is_deleted = 0 AND f.is_folder = 0
    WHERE pi.playlist_id = ?
    ORDER BY pi.position ASC
  `).all(row.id).map(fileRowToItem);

  playlist.items = items;
  playlist.total_hls_duration_sec = items.reduce(
    (sum, item) => sum + (Number(item.hls_duration_sec) || 0),
    0
  );
  return playlist;
}

function saveProgress(userId, playlistId, fileId, { position_seconds = 0, progress_pct = 0, completed = 0 }) {
  db.prepare(`
    INSERT INTO playlist_progress (user_id, playlist_id, file_id, position_seconds, progress_pct, completed, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, playlist_id, file_id) DO UPDATE SET
      position_seconds = excluded.position_seconds,
      progress_pct = excluded.progress_pct,
      completed = excluded.completed,
      updated_at = CURRENT_TIMESTAMP
  `).run(userId, playlistId, fileId, position_seconds, progress_pct, completed ? 1 : 0);
  return { ok: true };
}

function getProgress(userId, playlistId) {
  return db.prepare(`
    SELECT file_id, position_seconds, progress_pct, completed, updated_at
    FROM playlist_progress WHERE user_id = ? AND playlist_id = ?
  `).all(userId, playlistId);
}

function getContinueWatching(userId, limit = 20) {
  return db.prepare(`
    SELECT pp.*, p.title AS playlist_title, f.name AS file_name, f.has_thumbnail, f.mime_type,
           f.has_hls, f.chunk_count,
           (SELECT COALESCE(SUM(duration), 0) FROM hls_segments WHERE file_id = f.id) AS hls_duration_sec
    FROM playlist_progress pp
    JOIN playlists p ON p.id = pp.playlist_id AND p.user_id = ?
    JOIN files f ON f.id = pp.file_id AND f.is_deleted = 0
    WHERE pp.user_id = ? AND pp.completed = 0 AND pp.progress_pct > 0 AND pp.progress_pct < 90
    ORDER BY pp.updated_at DESC LIMIT ?
  `).all(userId, userId, limit);
}

function getRecentPlaylists(userId, limit = 20) {
  return db.prepare(`
    SELECT DISTINCT p.* FROM playlists p
    JOIN playlist_progress pp ON pp.playlist_id = p.id AND pp.user_id = ?
    WHERE p.user_id = ?
    ORDER BY pp.updated_at DESC LIMIT ?
  `).all(userId, userId, limit).map((r) => enrichPlaylist(r, userId));
}

// --- Collections ---

function listCollections(userId, req = null) {
  return db.prepare('SELECT * FROM collections WHERE user_id = ? ORDER BY updated_at DESC')
    .all(userId).map((r) => enrichCollection(r, req));
}

function getCollection(userId, collectionId, req = null) {
  const row = db.prepare('SELECT * FROM collections WHERE id = ? AND user_id = ?').get(collectionId, userId);
  if (!row) throw new Error('Collection not found');
  const collection = enrichCollection(row, req);
  collection.playlists = listCollectionPlaylists(userId, collectionId, req);
  return collection;
}

function listCollectionPlaylists(userId, collectionId, req = null) {
  const rows = db.prepare(`
    SELECT p.*, cp.position
    FROM collection_playlists cp
    JOIN playlists p ON p.id = cp.playlist_id
    WHERE cp.collection_id = ?
    ORDER BY cp.position ASC
  `).all(collectionId);
  return rows.map((r) => enrichPlaylist(r, userId, req));
}

function createCollection(userId, { title, description = '', visibility = 'private', cover_file_id = null }) {
  if (!title?.trim()) throw new Error('Title is required');
  const id = uuidv4();
  if (cover_file_id) assertFileOwned(userId, cover_file_id);
  db.prepare(`
    INSERT INTO collections (id, user_id, title, description, cover_file_id, visibility)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, userId, title.trim(), description || '', cover_file_id, validateVisibility(visibility));
  return getCollection(userId, id);
}

function updateCollection(userId, collectionId, patch) {
  const existing = db.prepare('SELECT * FROM collections WHERE id = ? AND user_id = ?').get(collectionId, userId);
  if (!existing) throw new Error('Collection not found');
  const title = patch.title !== undefined ? String(patch.title).trim() : existing.title;
  const description = patch.description !== undefined ? patch.description : existing.description;
  const visibility = patch.visibility !== undefined ? validateVisibility(patch.visibility) : existing.visibility;
  let coverFileId = patch.cover_file_id !== undefined ? patch.cover_file_id : existing.cover_file_id;
  if (coverFileId) assertFileOwned(userId, coverFileId);

  db.prepare(`
    UPDATE collections SET title = ?, description = ?, visibility = ?, cover_file_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `).run(title, description, visibility, coverFileId, collectionId, userId);
  return getCollection(userId, collectionId);
}

function deleteCollection(userId, collectionId) {
  const row = db.prepare('SELECT id FROM collections WHERE id = ? AND user_id = ?').get(collectionId, userId);
  if (!row) throw new Error('Collection not found');
  db.prepare('DELETE FROM collections WHERE id = ?').run(collectionId);
  return { ok: true };
}

function addPlaylistToCollection(userId, collectionId, playlistId, position) {
  const col = db.prepare('SELECT id FROM collections WHERE id = ? AND user_id = ?').get(collectionId, userId);
  if (!col) throw new Error('Collection not found');
  const pl = db.prepare('SELECT id FROM playlists WHERE id = ? AND user_id = ?').get(playlistId, userId);
  if (!pl) throw new Error('Playlist not found');

  const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM collection_playlists WHERE collection_id = ?')
    .get(collectionId).m;
  const pos = position !== undefined ? position : maxPos + 1;

  db.prepare(`
    INSERT OR IGNORE INTO collection_playlists (collection_id, playlist_id, position) VALUES (?, ?, ?)
  `).run(collectionId, playlistId, pos);
  db.prepare('UPDATE collections SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(collectionId);
  return getCollection(userId, collectionId);
}

function removePlaylistFromCollection(userId, collectionId, playlistId) {
  db.prepare('DELETE FROM collection_playlists WHERE collection_id = ? AND playlist_id = ?').run(collectionId, playlistId);
  db.prepare('UPDATE collections SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(collectionId);
  return { ok: true };
}

function createCollectionShareToken(userId, collectionId, req = null) {
  const row = db.prepare('SELECT * FROM collections WHERE id = ? AND user_id = ?').get(collectionId, userId);
  if (!row) throw new Error('Collection not found');
  let token = row.share_token;
  if (!token) {
    token = generateToken();
    db.prepare('UPDATE collections SET share_token = ?, visibility = CASE WHEN visibility = \'private\' THEN \'unlisted\' ELSE visibility END WHERE id = ?')
      .run(token, collectionId);
  }
  return { token, url: appUrl.publicUrl(req, `/share/c/${token}`) };
}

function getCollectionByShareToken(token, req = null) {
  const row = db.prepare(`
    SELECT c.*, u.username AS owner_name, u.avatar_url AS owner_avatar
    FROM collections c
    JOIN users u ON u.id = c.user_id
    WHERE c.share_token = ? AND c.visibility IN ('public', 'unlisted')
  `).get(token);
  if (!row) return null;

  const collection = enrichCollection(row, req);
  collection.owner_id = row.user_id;
  collection.owner_name = row.owner_name;
  collection.owner_avatar = row.owner_avatar;
  collection.playlists = db.prepare(`
    SELECT p.*, cp.position
    FROM collection_playlists cp
    JOIN playlists p ON p.id = cp.playlist_id AND p.visibility IN ('public', 'unlisted')
    WHERE cp.collection_id = ?
    ORDER BY cp.position ASC
  `).all(row.id).map((r) => enrichPlaylist(r, null, req));
  return collection;
}

module.exports = {
  resolvePlaylistFile,
  listPlaylists,
  getPlaylist,
  createPlaylist,
  updatePlaylist,
  deletePlaylist,
  duplicatePlaylist,
  addItems,
  removeItem,
  removeItems,
  updateItemDisplayName,
  updateItemsDisplayNames,
  reorderItems,
  smartReorderItems,
  createShareToken,
  revokeShareToken,
  getByShareToken,
  saveProgress,
  getProgress,
  getContinueWatching,
  getRecentPlaylists,
  listCollections,
  getCollection,
  createCollection,
  updateCollection,
  deleteCollection,
  addPlaylistToCollection,
  removePlaylistFromCollection,
  createCollectionShareToken,
  getCollectionByShareToken,
  listFolderLinks,
  linkFolder,
  unlinkFolder,
  syncPlaylist,
  syncPlaylistFolderLink,
  syncPlaylistsForFile,
  syncPlaylistsForFolder,
};
