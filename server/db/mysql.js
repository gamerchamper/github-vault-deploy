const mysql = require('mysql2/promise');
const path = require('path');
const fs = require('fs');

let pool = null;

function getConfig() {
  return {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: parseInt(process.env.MYSQL_PORT || '3306', 10),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'github_vault',
    waitForConnections: true,
    connectionLimit: 10,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
  };
}

async function connect() {
  if (pool) return pool;
  const config = getConfig();

  // Connect without database first to create it if needed
  const initConn = await mysql.createConnection({
    host: config.host, port: config.port,
    user: config.user, password: config.password,
  });
  await initConn.execute(
    `CREATE DATABASE IF NOT EXISTS \`${config.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await initConn.end();

  pool = mysql.createPool(config);
  await createTables();
  return pool;
}

async function createTables() {
  const sql = `
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      github_id VARCHAR(64) NOT NULL UNIQUE,
      username VARCHAR(255) NOT NULL,
      avatar_url TEXT,
      access_token TEXT NOT NULL,
      master_key TEXT,
      vault_org TEXT,
      share_client_stream INT DEFAULT 1,
      bandwidth_bytes BIGINT DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS storage_repos (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      owner VARCHAR(255) NOT NULL,
      name VARCHAR(255) NOT NULL,
      full_name VARCHAR(512) NOT NULL,
      default_branch VARCHAR(128) DEFAULT 'main',
      is_active INT DEFAULT 1,
      chunk_count INT DEFAULT 0,
      total_bytes BIGINT DEFAULT 0,
      is_metadata INT DEFAULT 0,
      linked_account_id INT,
      repo_role VARCHAR(32) DEFAULT 'primary',
      mirrors_repo_id INT,
      is_public INT DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_user_fullname (user_id, full_name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS files (
      id VARCHAR(64) PRIMARY KEY,
      user_id INT NOT NULL,
      name VARCHAR(512) NOT NULL,
      path VARCHAR(1024) NOT NULL,
      size BIGINT NOT NULL,
      mime_type VARCHAR(128),
      is_folder INT DEFAULT 0,
      parent_path VARCHAR(1024) DEFAULT '/',
      chunk_count INT DEFAULT 0,
      has_hls INT DEFAULT 0,
      hls_playlist_repo_id INT,
      hls_playlist_path TEXT,
      has_thumbnail INT DEFAULT 0,
      encryption_meta TEXT,
      share_token VARCHAR(128),
      encryption_mode VARCHAR(32) DEFAULT 'chunk',
      upload_status VARCHAR(32) DEFAULT 'ready',
      share_key_meta TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_files_user_path (user_id, parent_path)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS chunks (
      id INT AUTO_INCREMENT PRIMARY KEY,
      file_id VARCHAR(64) NOT NULL,
      chunk_index INT NOT NULL,
      repo_id INT NOT NULL,
      repo_path VARCHAR(1024) NOT NULL,
      sha VARCHAR(128),
      size BIGINT NOT NULL,
      chunk_iv VARCHAR(64),
      chunk_tag VARCHAR(64),
      plain_size INT,
      UNIQUE KEY uq_file_chunk (file_id, chunk_index),
      INDEX idx_chunks_file (file_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS tasks (
      id VARCHAR(64) PRIMARY KEY,
      user_id INT NOT NULL,
      type VARCHAR(32) NOT NULL,
      title VARCHAR(512) NOT NULL,
      status VARCHAR(32) DEFAULT 'processing',
      phase VARCHAR(32) DEFAULT 'starting',
      percent INT DEFAULT 0,
      error TEXT,
      payload TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_tasks_user_status (user_id, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS linked_accounts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      github_id VARCHAR(64) NOT NULL,
      username VARCHAR(255) NOT NULL,
      avatar_url TEXT,
      access_token TEXT NOT NULL,
      role VARCHAR(32) DEFAULT 'storage',
      is_active INT DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_linked_user (user_id, github_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS link_tokens (
      token VARCHAR(128) PRIMARY KEY,
      user_id INT NOT NULL,
      role VARCHAR(32) NOT NULL,
      expires_at DATETIME NOT NULL,
      used_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS chunk_backups (
      id INT AUTO_INCREMENT PRIMARY KEY,
      chunk_id INT NOT NULL,
      repo_id INT NOT NULL,
      sha VARCHAR(128),
      UNIQUE KEY uq_chunk_backup (chunk_id, repo_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS hls_segments (
      id INT AUTO_INCREMENT PRIMARY KEY,
      file_id VARCHAR(64) NOT NULL,
      segment_index INT NOT NULL,
      duration REAL DEFAULT 6,
      repo_id INT NOT NULL,
      repo_path VARCHAR(1024) NOT NULL,
      sha VARCHAR(128),
      size BIGINT NOT NULL,
      UNIQUE KEY uq_hls_seg (file_id, segment_index)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS bandwidth_log (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      file_id VARCHAR(64),
      bytes BIGINT NOT NULL,
      type VARCHAR(32) DEFAULT 'stream',
      recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_bw_user_time (user_id, recorded_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS share_shoutbox (
      id INT AUTO_INCREMENT PRIMARY KEY,
      share_token VARCHAR(128) NOT NULL,
      file_id VARCHAR(64),
      viewer_id VARCHAR(128) NOT NULL,
      viewer_name VARCHAR(64) NOT NULL,
      message TEXT NOT NULL,
      position REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_shoutbox_token (share_token, file_id, created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

    CREATE TABLE IF NOT EXISTS api_keys (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      name VARCHAR(128) NOT NULL,
      key_hash VARCHAR(128) NOT NULL UNIQUE,
      key_prefix VARCHAR(32) NOT NULL,
      last_used_at DATETIME,
      revoked_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_api_keys_hash (key_hash),
      INDEX idx_api_keys_user (user_id, revoked_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;

  // Split on semicolons and run each statement
  const statements = sql.split(';').map(s => s.trim()).filter(s => s.length > 0);
  for (const stmt of statements) {
    await pool.execute(stmt);
  }
  try {
    await pool.execute('ALTER TABLE users ADD COLUMN local_upload_ipv4 VARCHAR(45) NULL');
  } catch {
    /* column exists */
  }
}

async function getConn() {
  if (!pool) await connect();
  return pool;
}

module.exports = { connect, getConn, getConfig };
