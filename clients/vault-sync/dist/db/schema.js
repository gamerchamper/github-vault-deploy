"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SQL = exports.SCHEMA_VERSION = void 0;
exports.SCHEMA_VERSION = 1;
exports.SQL = {
    createTables: `
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS sync_root (
      id INTEGER PRIMARY KEY,
      local_path TEXT NOT NULL UNIQUE,
      server_url TEXT NOT NULL,
      last_sync_at TEXT,
      last_full_sync_at TEXT,
      sync_cursor TEXT
    );

    CREATE TABLE IF NOT EXISTS file_tree (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id TEXT,
      local_rel_path TEXT NOT NULL UNIQUE,
      remote_path TEXT,
      name TEXT NOT NULL,
      size INTEGER DEFAULT 0,
      mime_type TEXT,
      is_folder INTEGER DEFAULT 0,
      local_mtime_ms INTEGER,
      local_hash TEXT,
      remote_hash TEXT,
      remote_updated_at TEXT,
      sync_status TEXT DEFAULT 'synced',
      sync_task_id TEXT,
      sync_error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_file_tree_relpath ON file_tree(local_rel_path);
    CREATE INDEX IF NOT EXISTS idx_file_tree_status ON file_tree(sync_status);
    CREATE INDEX IF NOT EXISTS idx_file_tree_file_id ON file_tree(file_id);
    CREATE INDEX IF NOT EXISTS idx_file_tree_hash ON file_tree(local_hash);

    CREATE TABLE IF NOT EXISTS upload_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id TEXT,
      local_rel_path TEXT NOT NULL,
      local_hash TEXT NOT NULL,
      size INTEGER NOT NULL,
      mime_type TEXT,
      status TEXT DEFAULT 'pending',
      upload_mode TEXT DEFAULT 'api',
      percent INTEGER DEFAULT 0,
      error TEXT,
      retry_count INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 100,
      task_id TEXT,
      session_json TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      started_at TEXT,
      completed_at TEXT,
      priority INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_upload_queue_status ON upload_queue(status);
    CREATE INDEX IF NOT EXISTS idx_upload_queue_relpath ON upload_queue(local_rel_path);

    CREATE TABLE IF NOT EXISTS conflicts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id TEXT,
      local_rel_path TEXT NOT NULL,
      local_hash TEXT,
      remote_hash TEXT,
      local_mtime_ms INTEGER,
      remote_updated_at TEXT,
      conflict_reason TEXT,
      resolution TEXT DEFAULT 'unresolved',
      resolved_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT DEFAULT 'info',
      category TEXT,
      message TEXT NOT NULL,
      file_path TEXT,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sync_log_created ON sync_log(created_at);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `,
};
//# sourceMappingURL=schema.js.map