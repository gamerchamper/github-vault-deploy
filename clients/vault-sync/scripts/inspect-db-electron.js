const path = require('path');
const { app } = require('electron');
const Database = require('better-sqlite3');

app.whenReady().then(() => {
  const dbPath = path.join(app.getPath('userData'), 'vault-sync-data', 'vault-sync.db');
  console.log('userData:', app.getPath('userData'));
  console.log('DB:', dbPath);

  const db = new Database(dbPath, { readonly: true });
  console.log('file_tree:', db.prepare(
    'SELECT sync_status, is_folder, COUNT(*) c FROM file_tree GROUP BY sync_status, is_folder',
  ).all());
  console.log('upload_queue:', db.prepare(
    'SELECT status, COUNT(*) c FROM upload_queue GROUP BY status',
  ).all());
  console.log('local_only files:', db.prepare(
    "SELECT local_rel_path, size, is_folder FROM file_tree WHERE sync_status = 'local_only' AND is_folder = 0 LIMIT 10",
  ).all());
  console.log('local_only folders:', db.prepare(
    "SELECT local_rel_path FROM file_tree WHERE sync_status = 'local_only' AND is_folder = 1 LIMIT 10",
  ).all());
  console.log('pending queue:', db.prepare(
    "SELECT id, local_rel_path, status, error FROM upload_queue WHERE status IN ('pending','uploading','error','hashing') LIMIT 10",
  ).all());
  console.log('settings:', db.prepare(
    "SELECT key, CASE WHEN key='apiKey' THEN '***' ELSE value END value FROM settings",
  ).all());

  db.close();
  app.quit();
});
