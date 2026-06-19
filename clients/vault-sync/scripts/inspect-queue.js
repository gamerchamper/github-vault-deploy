const path = require('path');
const { app } = require('electron');
const Database = require('better-sqlite3');

app.whenReady().then(() => {
  const dbPath = path.join(app.getPath('userData'), 'vault-sync-data', 'vault-sync.db');
  const db = new Database(dbPath, { readonly: true });

  console.log('uploading/hash:', db.prepare(
    "SELECT status, COUNT(*) c FROM upload_queue WHERE status IN ('uploading','hashing') GROUP BY status",
  ).all());
  console.log('error count:', db.prepare(
    "SELECT COUNT(*) c FROM upload_queue WHERE status='error'",
  ).get());
  console.log('duplicate pending paths:', db.prepare(
    "SELECT local_rel_path, COUNT(*) c FROM upload_queue WHERE status='pending' GROUP BY local_rel_path HAVING c>1 ORDER BY c DESC LIMIT 5",
  ).all());
  console.log('total unique pending paths:', db.prepare(
    "SELECT COUNT(DISTINCT local_rel_path) c FROM upload_queue WHERE status='pending'",
  ).get());
  console.log('next pending by priority:', db.prepare(
    "SELECT id, local_rel_path, priority, size, error FROM upload_queue WHERE status='pending' ORDER BY priority DESC, id ASC LIMIT 5",
  ).all());
  console.log('local_only without pending queue:', db.prepare(`
    SELECT COUNT(*) c FROM file_tree ft
    WHERE ft.sync_status='local_only' AND ft.is_folder=0
    AND NOT EXISTS (
      SELECT 1 FROM upload_queue uq
      WHERE uq.local_rel_path=ft.local_rel_path
      AND uq.status IN ('pending','hashing','uploading')
    )
  `).get());
  console.log('local_only WITH pending queue:', db.prepare(`
    SELECT COUNT(*) c FROM file_tree ft
    WHERE ft.sync_status='local_only' AND ft.is_folder=0
    AND EXISTS (
      SELECT 1 FROM upload_queue uq
      WHERE uq.local_rel_path=ft.local_rel_path
      AND uq.status IN ('pending','hashing','uploading')
    )
  `).get());

  db.close();
  app.quit();
});
