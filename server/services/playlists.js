const { v4: uuidv4 } = require('uuid');
const db = require('../db/database');
const appUrl = require('./app-url');

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
    parent_path: row.parent_path,
    position: row.position,
    added_at: row.added_at,
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
  return playlist;
}

function listPlaylistItems(userId, playlistId, { limit, offset } = {}) {
  let sql = `
    SELECT f.id, f.name, f.path, f.size, f.mime_type, f.chunk_count, f.has_thumbnail, f.has_hls,
           f.parent_path, pi.position, pi.added_at, pi.display_name,
           pp.progress_pct, pp.completed, pp.position_seconds
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
  if (coverFileId) assertFileOwned(userId, coverFileId);

  db.prepare(`
    UPDATE playlists SET title = ?, description = ?, visibility = ?, cover_file_id = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `).run(title, description, visibility, coverFileId, playlistId, userId);

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
  if (src.items?.length) {
    addItems(userId, copy.id, src.items.map((i) => i.id));
    const named = src.items.filter((i) => i.display_name);
    if (named.length) {
      updateItemsDisplayNames(userId, copy.id, named.map((i) => ({
        file_id: i.id,
        display_name: i.display_name,
      })));
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
           f.parent_path, pi.position, pi.added_at, pi.display_name
    FROM playlist_items pi
    JOIN files f ON f.id = pi.file_id AND f.is_deleted = 0 AND f.is_folder = 0
    WHERE pi.playlist_id = ?
    ORDER BY pi.position ASC
  `).all(row.id).map(fileRowToItem);

  playlist.items = items;
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
    SELECT pp.*, p.title AS playlist_title, f.name AS file_name, f.has_thumbnail, f.mime_type
    FROM playlist_progress pp
    JOIN playlists p ON p.id = pp.playlist_id AND p.user_id = ?
    JOIN files f ON f.id = pp.file_id AND f.is_deleted = 0
    WHERE pp.user_id = ? AND pp.completed = 0 AND pp.progress_pct > 0 AND pp.progress_pct < 95
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
};
