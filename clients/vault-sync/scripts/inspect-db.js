const path = require('path');
const Database = require('better-sqlite3');

const dbPath = path.join(
  process.env.APPDATA || process.env.HOME,
  'Electron',
  'vault-sync-data',
  'vault-sync.db',
);

const db = new Database(dbPath, { readonly: true });

console.log('DB:', dbPath);
console.log('file_tree:', db.prepare(
  'SELECT sync_status, COUNT(*) c FROM file_tree WHERE is_folder = 0 GROUP BY sync_status',
).all());
console.log('upload_queue:', db.prepare(
  'SELECT status, COUNT(*) c FROM upload_queue GROUP BY status',
).all());
console.log('local_only sample:', db.prepare(
  "SELECT local_rel_path, size, sync_status FROM file_tree WHERE sync_status = 'local_only' AND is_folder = 0 LIMIT 8",
).all());
console.log('pending queue:', db.prepare(
  "SELECT id, local_rel_path, status, error FROM upload_queue WHERE status IN ('pending', 'uploading', 'error') LIMIT 8",
).all());
console.log('settings:', db.prepare("SELECT key, CASE WHEN key = 'apiKey' THEN '***' ELSE value END AS value FROM settings").all());
