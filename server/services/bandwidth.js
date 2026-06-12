const db = require('../db/database');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MONTH_MS = 30 * DAY_MS;

function recordBytes(userId, fileId, bytes, type = 'stream') {
  if (!userId || !bytes || bytes <= 0) return;
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO bandwidth_log (user_id, file_id, bytes, type, recorded_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, fileId || null, bytes, type, now);

  db.prepare(`
    UPDATE users SET bandwidth_bytes = COALESCE(bandwidth_bytes, 0) + ? WHERE id = ?
  `).run(bytes, userId);
}

function getBandwidth(userId, period = 'all') {
  let since;
  const now = Date.now();
  if (period === 'hour') since = new Date(now - HOUR_MS).toISOString();
  else if (period === 'day') since = new Date(now - DAY_MS).toISOString();
  else if (period === 'month') since = new Date(now - MONTH_MS).toISOString();
  else since = null;

  let totalBytes = 0;
  let streamBytes = 0;
  let downloadBytes = 0;
  let viewBytes = 0;
  let hlsUploadBytes = 0;

  if (since) {
    const rows = db.prepare(
      'SELECT COALESCE(SUM(bytes), 0) as total, type FROM bandwidth_log WHERE user_id = ? AND recorded_at >= ? GROUP BY type'
    ).all(userId, since);
    for (const row of rows) {
      if (row.type === 'stream') streamBytes = row.total;
      else if (row.type === 'download') downloadBytes = row.total;
      else if (row.type === 'view') viewBytes = row.total;
      else if (row.type === 'hls_upload') hlsUploadBytes = row.total;
      totalBytes += row.total;
    }
  } else {
    const row = db.prepare('SELECT COALESCE(bandwidth_bytes, 0) as total FROM users WHERE id = ?').get(userId);
    totalBytes = row?.total || 0;
  }

  return { totalBytes, streamBytes, downloadBytes, viewBytes, hlsUploadBytes, period };
}

function getBandwidthSummary(userId) {
  const hour = getBandwidth(userId, 'hour');
  const day = getBandwidth(userId, 'day');
  const month = getBandwidth(userId, 'month');
  const total = getBandwidth(userId, 'all');

  const topFiles = db.prepare(`
    SELECT f.name, f.size, f.mime_type, COALESCE(SUM(bl.bytes), 0) as total_bytes
    FROM bandwidth_log bl
    JOIN files f ON f.id = bl.file_id AND f.user_id = bl.user_id
    WHERE bl.user_id = ? AND bl.recorded_at >= datetime('now', '-30 days')
    GROUP BY bl.file_id
    ORDER BY total_bytes DESC
    LIMIT 10
  `).all(userId);

  return { hour, day, month, total, topFiles };
}

module.exports = { recordBytes, getBandwidth, getBandwidthSummary };