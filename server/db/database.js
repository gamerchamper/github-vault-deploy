const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'vault.db'));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    github_id TEXT UNIQUE NOT NULL,
    username TEXT NOT NULL,
    avatar_url TEXT,
    access_token TEXT NOT NULL,
    master_key TEXT,
    vault_org TEXT,
    share_client_stream INTEGER DEFAULT 1,
    bandwidth_bytes INTEGER DEFAULT 0,
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
    is_metadata INTEGER DEFAULT 0,
    linked_account_id INTEGER,
    repo_role TEXT DEFAULT 'primary',
    mirrors_repo_id INTEGER,
    is_public INTEGER DEFAULT 0,
    chunk_count INTEGER DEFAULT 0,
    total_bytes INTEGER DEFAULT 0,
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

  CREATE INDEX IF NOT EXISTS idx_files_user_path ON files(user_id, parent_path);
  CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);

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

  CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON tasks(user_id, status);

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

  CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_log(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action, created_at);
`);

// Backfill content_hash for existing databases
try { db.exec('ALTER TABLE files ADD COLUMN content_hash TEXT'); } catch { /* exists */ }
try { db.exec('ALTER TABLE files ADD COLUMN content_algorithm TEXT'); } catch { /* exists */ }

// New features: recent files, favorites, soft delete
try { db.exec('ALTER TABLE files ADD COLUMN last_accessed DATETIME'); } catch { /* exists */ }
try { db.exec('ALTER TABLE files ADD COLUMN is_favorite INTEGER DEFAULT 0'); } catch { /* exists */ }
try { db.exec('ALTER TABLE files ADD COLUMN is_deleted INTEGER DEFAULT 0'); } catch { /* exists */ }
try { db.exec('ALTER TABLE files ADD COLUMN deleted_at TEXT'); } catch { /* exists */ }
try { db.exec('ALTER TABLE files ADD COLUMN backup_skip INTEGER DEFAULT 0'); } catch { /* exists */ }
try { db.exec('ALTER TABLE users ADD COLUMN local_upload_ipv4 TEXT'); } catch { /* exists */ }

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS playlists (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      cover_file_id TEXT,
      visibility TEXT DEFAULT 'private',
      share_token TEXT UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS playlist_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id TEXT NOT NULL,
      file_id TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      display_name TEXT,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
      FOREIGN KEY (file_id) REFERENCES files(id),
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
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS collection_playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection_id TEXT NOT NULL,
      playlist_id TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE,
      FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
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
      PRIMARY KEY (user_id, playlist_id, file_id),
      FOREIGN KEY (user_id) REFERENCES users(id),
      FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
      FOREIGN KEY (file_id) REFERENCES files(id)
    );

    CREATE INDEX IF NOT EXISTS idx_playlists_user ON playlists(user_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_playlist_items_playlist ON playlist_items(playlist_id, position);
    CREATE INDEX IF NOT EXISTS idx_collections_user ON collections(user_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_collection_playlists_col ON collection_playlists(collection_id, position);
    CREATE INDEX IF NOT EXISTS idx_playlist_progress_user ON playlist_progress(user_id, playlist_id);
  `);
} catch { /* exists */ }

ensureColumn('playlist_items', 'display_name', 'TEXT');
ensureColumn('playlist_items', 'folder_link_id', 'INTEGER');

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS playlist_folder_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id TEXT NOT NULL,
      folder_id TEXT NOT NULL,
      include_subfolders INTEGER DEFAULT 0,
      sort_by TEXT DEFAULT 'name',
      sort_order TEXT DEFAULT 'ASC',
      last_synced_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
      FOREIGN KEY (folder_id) REFERENCES files(id),
      UNIQUE(playlist_id, folder_id)
    );
    CREATE INDEX IF NOT EXISTS idx_playlist_folder_links_playlist ON playlist_folder_links(playlist_id);
    CREATE INDEX IF NOT EXISTS idx_playlist_folder_links_folder ON playlist_folder_links(folder_id);
    CREATE INDEX IF NOT EXISTS idx_playlist_items_folder_link ON playlist_items(playlist_id, folder_link_id);
  `);
} catch { /* exists */ }
ensureColumn('storage_repos', 'reserved_bytes', 'INTEGER DEFAULT 0');
ensureColumn('files', 'hls_reserved', 'TEXT');
ensureColumn('users', 'auto_repo_enabled', 'INTEGER DEFAULT 0');
ensureColumn('users', 'auto_repo_interval_minutes', 'INTEGER DEFAULT 60');
ensureColumn('users', 'auto_repo_gb', 'INTEGER DEFAULT 5');
ensureColumn('users', 'auto_repo_linked_account_id', 'INTEGER');
ensureColumn('users', 'auto_repo_last_run_at', 'TEXT');
ensureColumn('users', 'plex_sync_enabled', 'INTEGER DEFAULT 0');
ensureColumn('users', 'plex_library_path', 'TEXT');
ensureColumn('users', 'plex_server_url', 'TEXT');
ensureColumn('users', 'plex_token', 'TEXT');
ensureColumn('users', 'plex_section_key', 'TEXT');
ensureColumn('users', 'plex_sync_interval_minutes', 'INTEGER DEFAULT 30');
ensureColumn('users', 'plex_last_sync_at', 'TEXT');
ensureColumn('users', 'plex_last_sync_error', 'TEXT');

try {
  db.exec(`
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
    CREATE INDEX IF NOT EXISTS idx_chunk_sync_retry ON chunk_sync_failures(linked_account_id, next_retry_at);
  `);
} catch { /* exists */ }

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS file_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      version_num INTEGER NOT NULL,
      size INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL,
      content_fingerprint TEXT NOT NULL,
      manifest_sha TEXT,
      source TEXT DEFAULT 'upload',
      note TEXT,
      manifest_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE,
      UNIQUE(file_id, version_num)
    );
    CREATE INDEX IF NOT EXISTS idx_file_versions_file ON file_versions(file_id, version_num DESC);
    CREATE INDEX IF NOT EXISTS idx_file_versions_user ON file_versions(user_id, file_id);
  `);
} catch { /* exists */ }

ensureColumn('api_keys', 'key_secret', 'TEXT');
ensureColumn('playlists', 'sort_regex', 'TEXT');
ensureColumn('playlists', 'sort_mode', 'TEXT');

try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_agents (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      api_key_id INTEGER,
      name TEXT NOT NULL,
      hostname TEXT,
      platform TEXT,
      client_type TEXT DEFAULT 'vault-sync',
      version TEXT,
      last_seen_at DATETIME,
      config_version INTEGER DEFAULT 0,
      desired_config_json TEXT,
      applied_config_version INTEGER DEFAULT 0,
      reported_config_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_sync_agents_user ON sync_agents(user_id, last_seen_at DESC);
  `);
} catch { /* exists */ }

module.exports = db;
