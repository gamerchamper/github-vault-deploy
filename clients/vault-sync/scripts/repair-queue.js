const path = require('path');
const { app } = require('electron');
const Database = require('better-sqlite3');

app.whenReady().then(() => {
  const dbPath = path.join(app.getPath('userData'), 'vault-sync-data', 'vault-sync.db');
  const db = new Database(dbPath);

  db.prepare("UPDATE file_tree SET local_rel_path = REPLACE(local_rel_path, '\\', '/')").run();
  db.prepare("UPDATE upload_queue SET local_rel_path = REPLACE(local_rel_path, '\\', '/')").run();

  const cancelled = db.prepare(`
    UPDATE upload_queue
    SET status = 'error', error = 'Invalid queue entry (zero size)'
    WHERE status = 'pending' AND size <= 0
  `).run().changes;

  const deduped = db.prepare(`
    DELETE FROM upload_queue
    WHERE status = 'pending'
      AND id NOT IN (
        SELECT MAX(id) FROM upload_queue WHERE status = 'pending' GROUP BY local_rel_path
      )
  `).run().changes;

  db.prepare("UPDATE upload_queue SET priority = 10 WHERE status = 'pending' AND priority < 10").run();
  const sessionsCleared = db.prepare(`
    UPDATE upload_queue
    SET file_id = NULL, task_id = NULL, session_json = NULL
    WHERE status IN ('pending', 'error') AND (file_id IS NOT NULL OR task_id IS NOT NULL)
  `).run().changes;
  db.prepare('UPDATE schema_version SET version = 2').run();

  console.log('Cleanup complete:', { cancelled, deduped, sessionsCleared });
  console.log('pending now:', db.prepare("SELECT COUNT(*) c FROM upload_queue WHERE status='pending'").get());
  console.log('next:', db.prepare(
    "SELECT id, local_rel_path, priority, size FROM upload_queue WHERE status='pending' ORDER BY priority DESC, id ASC LIMIT 3",
  ).all());

  db.close();
  app.quit();
});
