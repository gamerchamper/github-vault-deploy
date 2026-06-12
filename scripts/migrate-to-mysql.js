#!/usr/bin/env node
require('dotenv').config();

const sqlite3 = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const sqlitePath = path.join(__dirname, '..', 'data', 'vault.db');
const mysql = require(path.join(__dirname, '..', 'server', 'db', 'mysql'));

function escapeMySQL(v) {
  if (v == null) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
}

async function migrate() {
  if (!fs.existsSync(sqlitePath)) {
    console.error('No SQLite database found at ' + sqlitePath);
    process.exit(1);
  }

  const sqlite = new sqlite3(sqlitePath, { readonly: true });
  const pool = await mysql.connect();

  const tables = [
    'users',
    'linked_accounts',
    'link_tokens',
    'storage_repos',
    'files',
    'chunks',
    'chunk_backups',
    'hls_segments',
    'tasks',
    'bandwidth_log',
    'share_shoutbox',
    'api_keys',
  ];

  let totalRows = 0;

  for (const table of tables) {
    const count = sqlite.prepare(`SELECT COUNT(*) as c FROM ${table}`).get();
    console.log(`Migrating ${table} (${count.c} rows)...`);

    if (count.c === 0) {
      // Clear MySQL table to keep in sync
      await pool.execute(`DELETE FROM ${table}`);
      continue;
    }

    const rows = sqlite.prepare(`SELECT * FROM ${table}`).all();
    totalRows += rows.length;

    // Clear first for clean migration
    await pool.execute(`DELETE FROM ${table}`);

    for (const row of rows) {
      const cols = Object.keys(row);
      const values = cols.map(c => escapeMySQL(row[c]));
      const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${values.join(', ')})`;
      try {
        await pool.execute(sql);
      } catch (err) {
        console.error(`  Error inserting into ${table} row id=${row.id}: ${err.message}`);
        throw err;
      }
    }
    console.log(`  ${table}: ${count.c} rows migrated`);
  }

  // Reset auto-increment counters
  for (const table of tables) {
    try {
      await pool.execute(`ALTER TABLE ${table} AUTO_INCREMENT = 1`);
    } catch {}
  }

  sqlite.close();
  console.log(`\nMigration complete: ${totalRows} rows across ${tables.length} tables migrated to MySQL.`);
  await pool.end();
}

migrate().catch(err => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
