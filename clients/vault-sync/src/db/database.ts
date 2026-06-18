import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { SQL, SCHEMA_VERSION } from './schema';
import { logger } from '../services/logger';

let db: Database.Database | null = null;

export function openDatabase(dataDir: string): Database.Database {
  if (db) return db;

  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, 'vault-sync.db');

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('foreign_keys = ON');

  runMigrations(db);
  logger.info('db', `Database opened at ${dbPath}`);

  return db;
}

export function getDatabase(): Database.Database {
  if (!db) throw new Error('Database not opened. Call openDatabase first.');
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('db', 'Database closed');
  }
}

function runMigrations(database: Database.Database): void {
  database.exec(SQL.createTables);

  const version = database.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined;
  if (!version) {
    database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    logger.info('db', `Applied schema v${SCHEMA_VERSION}`);
  }
}
