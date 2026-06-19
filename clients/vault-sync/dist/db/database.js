"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.openDatabase = openDatabase;
exports.getDatabase = getDatabase;
exports.closeDatabase = closeDatabase;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const schema_1 = require("./schema");
const logger_1 = require("../services/logger");
let db = null;
function openDatabase(dataDir) {
    if (db)
        return db;
    fs_1.default.mkdirSync(dataDir, { recursive: true });
    const dbPath = path_1.default.join(dataDir, 'vault-sync.db');
    db = new better_sqlite3_1.default(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    logger_1.logger.info('db', `Database opened at ${dbPath}`);
    return db;
}
function getDatabase() {
    if (!db)
        throw new Error('Database not opened. Call openDatabase first.');
    return db;
}
function closeDatabase() {
    if (db) {
        db.close();
        db = null;
        logger_1.logger.info('db', 'Database closed');
    }
}
function runMigrations(database) {
    database.exec(schema_1.SQL.createTables);
    const versionRow = database.prepare('SELECT version FROM schema_version').get();
    const version = versionRow?.version ?? 0;
    if (version === 0) {
        database.prepare('INSERT INTO schema_version (version) VALUES (?)').run(schema_1.SCHEMA_VERSION);
        logger_1.logger.info('db', `Applied schema v${schema_1.SCHEMA_VERSION}`);
        return;
    }
    if (version < 2) {
        database.prepare("UPDATE file_tree SET local_rel_path = REPLACE(local_rel_path, '\\', '/')").run();
        database.prepare("UPDATE upload_queue SET local_rel_path = REPLACE(local_rel_path, '\\', '/')").run();
        database.prepare('UPDATE schema_version SET version = 2').run();
        logger_1.logger.info('db', 'Migrated paths to forward slashes (v2)');
    }
}
//# sourceMappingURL=database.js.map