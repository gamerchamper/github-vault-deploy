const db = require('../db/database');

function log(userId, action, meta = {}) {
  try {
    db.prepare(`
      INSERT INTO audit_log (user_id, action, target_type, target_id, target_name, ip, details)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      userId || null,
      action,
      meta.targetType || null,
      meta.targetId || null,
      meta.targetName || null,
      meta.ip || null,
      meta.details || null
    );
  } catch (err) {
    console.error(`[audit] Failed to log ${action}: ${err.message}`);
  }
}

function query(userId = null, opts = {}) {
  const { action, limit = 100, offset = 0 } = opts;
  let sql = 'SELECT * FROM audit_log';
  const params = [];
  const conditions = [];

  if (userId) {
    conditions.push('user_id = ?');
    params.push(userId);
  }
  if (action) {
    conditions.push('action = ?');
    params.push(action);
  }
  if (conditions.length) {
    sql += ' WHERE ' + conditions.join(' AND ');
  }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(sql).all(...params);
}

function cleanup(days = 90) {
  db.prepare(
    "DELETE FROM audit_log WHERE created_at < datetime('now', ? || ' days')"
  ).run(String(-days));
}

module.exports = { log, query, cleanup };
