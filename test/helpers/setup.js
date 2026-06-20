const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

function createMemoryDb() {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      github_id TEXT UNIQUE NOT NULL,
      username TEXT NOT NULL,
      avatar_url TEXT,
      access_token TEXT NOT NULL,
      bandwidth_bytes INTEGER DEFAULT 0,
      master_key TEXT,
      vault_org TEXT,
      share_client_stream INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS storage_repos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      owner TEXT NOT NULL,
      name TEXT NOT NULL,
      full_name TEXT NOT NULL,
      default_branch TEXT DEFAULT 'main',
      is_active INTEGER DEFAULT 1,
      chunk_count INTEGER DEFAULT 0,
      total_bytes INTEGER DEFAULT 0,
      reserved_bytes INTEGER DEFAULT 0,
      is_metadata INTEGER DEFAULT 0,
      linked_account_id INTEGER,
      repo_role TEXT DEFAULT 'primary',
      mirrors_repo_id INTEGER,
      is_public INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(user_id, full_name)
    );

    CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      size INTEGER NOT NULL,
      mime_type TEXT,
      is_folder INTEGER DEFAULT 0,
      parent_path TEXT DEFAULT '/',
      chunk_count INTEGER DEFAULT 0,
      has_hls INTEGER DEFAULT 0,
      hls_playlist_repo_id INTEGER,
      hls_playlist_path TEXT,
      has_thumbnail INTEGER DEFAULT 0,
      encryption_meta TEXT,
      share_token TEXT,
      encryption_mode TEXT DEFAULT 'chunk',
      upload_status TEXT DEFAULT 'ready',
      hls_reserved TEXT,
      share_key_meta TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      repo_id INTEGER NOT NULL,
      repo_path TEXT NOT NULL,
      sha TEXT,
      size INTEGER NOT NULL,
      chunk_iv TEXT,
      chunk_tag TEXT,
      plain_size INTEGER,
      FOREIGN KEY (file_id) REFERENCES files(id),
      FOREIGN KEY (repo_id) REFERENCES storage_repos(id),
      UNIQUE(file_id, chunk_index)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'processing',
      phase TEXT DEFAULT 'starting',
      percent INTEGER DEFAULT 0,
      error TEXT,
      payload TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS linked_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      github_id TEXT NOT NULL,
      username TEXT NOT NULL,
      avatar_url TEXT,
      access_token TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'storage',
      is_active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id),
      UNIQUE(user_id, github_id)
    );

    CREATE TABLE IF NOT EXISTS link_tokens (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      expires_at DATETIME NOT NULL,
      used_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS chunk_backups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chunk_id INTEGER NOT NULL,
      repo_id INTEGER NOT NULL,
      sha TEXT,
      FOREIGN KEY (chunk_id) REFERENCES chunks(id),
      FOREIGN KEY (repo_id) REFERENCES storage_repos(id),
      UNIQUE(chunk_id, repo_id)
    );

    CREATE TABLE IF NOT EXISTS chunk_sync_failures (
      chunk_id INTEGER NOT NULL,
      linked_account_id INTEGER NOT NULL,
      fail_count INTEGER DEFAULT 0,
      last_fail_at DATETIME,
      next_retry_at DATETIME,
      last_error TEXT,
      confirmed_missing INTEGER DEFAULT 0,
      PRIMARY KEY (chunk_id, linked_account_id)
    );

    CREATE TABLE IF NOT EXISTS hls_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id TEXT NOT NULL,
      segment_index INTEGER NOT NULL,
      duration REAL DEFAULT 6,
      repo_id INTEGER NOT NULL,
      repo_path TEXT NOT NULL,
      sha TEXT,
      size INTEGER NOT NULL,
      FOREIGN KEY (file_id) REFERENCES files(id),
      FOREIGN KEY (repo_id) REFERENCES storage_repos(id),
      UNIQUE(file_id, segment_index)
    );

    CREATE TABLE IF NOT EXISTS bandwidth_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      file_id TEXT,
      bytes INTEGER NOT NULL,
      type TEXT NOT NULL DEFAULT 'stream',
      recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_bw_user_time ON bandwidth_log(user_id, recorded_at);

    CREATE TABLE IF NOT EXISTS share_shoutbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      share_token TEXT NOT NULL,
      file_id TEXT,
      viewer_id TEXT NOT NULL,
      viewer_name TEXT NOT NULL,
      message TEXT NOT NULL,
      position REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_shoutbox_token ON share_shoutbox(share_token, file_id, created_at);

    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      last_used_at DATETIME,
      revoked_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
    CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id, revoked_at);

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      target_name TEXT,
      ip TEXT,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  for (const sql of [
    'ALTER TABLE users ADD COLUMN master_key TEXT',
    'ALTER TABLE storage_repos ADD COLUMN is_metadata INTEGER DEFAULT 0',
    'ALTER TABLE files ADD COLUMN has_thumbnail INTEGER DEFAULT 0',
    'ALTER TABLE files ADD COLUMN encryption_meta TEXT',
    'ALTER TABLE files ADD COLUMN share_token TEXT',
    'ALTER TABLE files ADD COLUMN encryption_mode TEXT DEFAULT "chunk"',
    'ALTER TABLE chunks ADD COLUMN chunk_iv TEXT',
    'ALTER TABLE chunks ADD COLUMN chunk_tag TEXT',
    'ALTER TABLE chunks ADD COLUMN plain_size INTEGER',
    'ALTER TABLE users ADD COLUMN vault_org TEXT',
    'ALTER TABLE files ADD COLUMN upload_status TEXT DEFAULT "ready"',
    'ALTER TABLE storage_repos ADD COLUMN linked_account_id INTEGER',
    'ALTER TABLE storage_repos ADD COLUMN repo_role TEXT DEFAULT "primary"',
    'ALTER TABLE storage_repos ADD COLUMN mirrors_repo_id INTEGER',
    'ALTER TABLE files ADD COLUMN share_key_meta TEXT',
    'ALTER TABLE users ADD COLUMN share_client_stream INTEGER DEFAULT 1',
    'ALTER TABLE storage_repos ADD COLUMN is_public INTEGER DEFAULT 0',
    'ALTER TABLE files ADD COLUMN has_hls INTEGER DEFAULT 0',
    'ALTER TABLE files ADD COLUMN hls_playlist_repo_id INTEGER',
    'ALTER TABLE files ADD COLUMN hls_playlist_path TEXT',
    'ALTER TABLE users ADD COLUMN bandwidth_bytes INTEGER DEFAULT 0',
    'ALTER TABLE files ADD COLUMN content_hash TEXT',
    'ALTER TABLE files ADD COLUMN content_algorithm TEXT',
    'ALTER TABLE files ADD COLUMN last_accessed DATETIME',
    'ALTER TABLE files ADD COLUMN is_favorite INTEGER DEFAULT 0',
    'ALTER TABLE files ADD COLUMN is_deleted INTEGER DEFAULT 0',
  ]) {
    try { db.exec(sql); } catch { }
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      cover_file_id TEXT,
      visibility TEXT DEFAULT 'private',
      share_token TEXT UNIQUE,
      sort_regex TEXT,
      sort_mode TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS playlist_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id TEXT NOT NULL,
      file_id TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      display_name TEXT,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(playlist_id, file_id)
    );
    CREATE TABLE IF NOT EXISTS collections (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      cover_file_id TEXT,
      visibility TEXT DEFAULT 'private',
      share_token TEXT UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS collection_playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection_id TEXT NOT NULL,
      playlist_id TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      UNIQUE(collection_id, playlist_id)
    );
    CREATE TABLE IF NOT EXISTS playlist_progress (
      user_id INTEGER NOT NULL,
      playlist_id TEXT NOT NULL,
      file_id TEXT NOT NULL,
      position_seconds REAL DEFAULT 0,
      progress_pct REAL DEFAULT 0,
      completed INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, playlist_id, file_id)
    );
    CREATE TABLE IF NOT EXISTS playlist_folder_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id TEXT NOT NULL,
      folder_id TEXT NOT NULL,
      include_subfolders INTEGER DEFAULT 0,
      sort_by TEXT DEFAULT 'name',
      sort_order TEXT DEFAULT 'ASC',
      last_synced_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(playlist_id, folder_id)
    );
  `);

  try { db.exec('ALTER TABLE playlist_items ADD COLUMN folder_link_id INTEGER'); } catch { }
  try { db.exec('ALTER TABLE files ADD COLUMN is_deleted INTEGER DEFAULT 0'); } catch { }

  return db;
}

function seedTestUser(db, overrides = {}) {
  const stmt = db.prepare(`
    INSERT INTO users (github_id, username, access_token, bandwidth_bytes${overrides.master_key ? ', master_key' : ''})
    VALUES (?, ?, ?, ?${overrides.master_key ? ', ?' : ''})
  `);
  const params = [
    overrides.github_id || '12345',
    overrides.username || 'testuser',
    overrides.access_token || 'mock_token',
    overrides.bandwidth_bytes || 0,
  ];
  if (overrides.master_key) params.push(overrides.master_key);
  stmt.run(...params);
  return db.prepare('SELECT * FROM users WHERE github_id = ?').get(overrides.github_id || '12345');
}

function seedTestFile(db, userId, overrides = {}) {
  const cols = ['id', 'user_id', 'name', 'path', 'size', 'mime_type', 'chunk_count', 'has_hls', 'hls_playlist_repo_id', 'hls_playlist_path'];
  const vals = [
    overrides.id || 'test-file-id-1',
    userId,
    overrides.name || 'test.mp4',
    overrides.path || '/test.mp4',
    overrides.size || 1000000,
    overrides.mime_type || 'video/mp4',
    overrides.chunk_count || 10,
    overrides.has_hls || 0,
    overrides.hls_playlist_repo_id || null,
    overrides.hls_playlist_path || null,
  ];
  if (overrides.share_token !== undefined) {
    cols.push('share_token');
    vals.push(overrides.share_token);
  }
  if (overrides.encryption_meta !== undefined) {
    cols.push('encryption_meta');
    vals.push(overrides.encryption_meta);
  }
  if (overrides.upload_status !== undefined) {
    cols.push('upload_status');
    vals.push(overrides.upload_status);
  }
  if (overrides.encryption_mode !== undefined) {
    cols.push('encryption_mode');
    vals.push(overrides.encryption_mode);
  }
  if (overrides.is_folder !== undefined) {
    cols.push('is_folder');
    vals.push(overrides.is_folder);
  }
  if (overrides.parent_path !== undefined) {
    cols.push('parent_path');
    vals.push(overrides.parent_path);
  }
  if (overrides.is_deleted !== undefined) {
    cols.push('is_deleted');
    vals.push(overrides.is_deleted);
  }
  db.prepare(`INSERT INTO files (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals);
  return db.prepare('SELECT * FROM files WHERE id = ?').get(vals[0]);
}

function seedTestRepo(db, userId, overrides = {}) {
  const fullName = overrides.full_name || 'test/repo1';
  db.prepare(`
    INSERT INTO storage_repos (user_id, owner, name, full_name, default_branch, repo_role)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    overrides.owner || 'test',
    overrides.name || 'repo1',
    fullName,
    overrides.default_branch || 'main',
    overrides.repo_role || 'primary'
  );
  return db.prepare('SELECT * FROM storage_repos WHERE full_name = ?').get(fullName);
}

module.exports = { createMemoryDb, seedTestUser, seedTestFile, seedTestRepo };
