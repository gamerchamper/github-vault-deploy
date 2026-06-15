const db = require('../db/database');

function parseRow(row) {
  if (!row) return null;
  const payload = row.payload ? JSON.parse(row.payload) : {};
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    title: row.title,
    phase: row.phase,
    percent: row.percent,
    error: row.error,
    created_at: row.created_at,
    updated_at: row.updated_at,
    fileName: row.title,
    chunksDone: payload.chunksDone || 0,
    chunksTotal: payload.chunksTotal || 0,
    currentRepo: payload.currentRepo || null,
    file: payload.file || null,
    ...payload,
  };
}

const { v4: uuidv4 } = require('uuid');

function create(userId, { id, type, title, payload = {} }) {
  const taskId = id || uuidv4();
  db.prepare(`
    INSERT INTO tasks (id, user_id, type, title, status, phase, percent, payload)
    VALUES (?, ?, ?, ?, 'processing', 'starting', 0, ?)
  `).run(taskId, userId, type, title, JSON.stringify(payload));
  return parseRow(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId));
}

function update(taskId, userId, patch) {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(taskId, userId);
  if (!row) return null;

  const payload = row.payload ? JSON.parse(row.payload) : {};
  const nextPayload = { ...payload };
  const payloadKeys = [
    'chunksDone', 'chunksTotal', 'currentRepo', 'file', 'ids', 'done', 'total', 'currentName',
    'fileId', 'parentPath', 'chunkSize', 'fileSize', 'mimeType', 'resumable', 'fileName', 'nextChunk', 'uploadMode', 'convertHls',
    'accountId', 'method', 'log', 'lastLog', 'gitBytesStaged', 'gitRepos', 'names', 'pauseReason',
    'segmentsDone', 'segmentsTotal',
    'seamlessPartSize', 'seamlessPartsTotal', 'seamlessPartsDone', 'seamlessPartsReceived', 'hlsTaskId',
    'linkedAccountId', 'source', 'capacityGbAdded', 'errors', 'partial',
  ];

  for (const key of payloadKeys) {
    if (patch[key] !== undefined) nextPayload[key] = patch[key];
  }

  const next = {
    status: patch.status ?? row.status,
    phase: patch.phase ?? row.phase,
    percent: patch.percent ?? row.percent,
    error: patch.error !== undefined ? patch.error : row.error,
    title: patch.title ?? row.title,
    payload: JSON.stringify(nextPayload),
  };

  db.prepare(`
    UPDATE tasks
    SET status = ?, phase = ?, percent = ?, error = ?, title = ?, payload = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ?
  `).run(
    next.status, next.phase, next.percent, next.error, next.title, next.payload,
    taskId, userId
  );

  return get(taskId, userId);
}

function get(taskId, userId) {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(taskId, userId);
  return parseRow(row);
}

function pause(taskId, userId, reason = 'Paused by user') {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(taskId, userId);
  if (!row) return null;
  if (row.status !== 'processing' && row.status !== 'pending') {
    throw new Error('Only active tasks can be paused');
  }
  appendLog(taskId, userId, reason);
  return update(taskId, userId, {
    status: 'paused',
    phase: 'paused',
    pauseReason: reason,
    resumable: true,
  });
}

function resumeTask(taskId, userId) {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(taskId, userId);
  if (!row) return null;

  const payload = row.payload ? JSON.parse(row.payload) : {};
  const canResume = row.status === 'paused'
    || (row.status === 'error' && payload.resumable)
    || (row.status === 'processing' && row.type === 'upload' && payload.resumable !== false);
  if (!canResume) throw new Error('Task is not resumable');

  appendLog(taskId, userId, 'Resuming...');
  const phase = row.status === 'paused' && row.phase === 'paused' ? 'upload' : (row.phase || 'upload');
  return update(taskId, userId, {
    status: 'processing',
    phase: phase === 'paused' ? 'upload' : phase,
    error: null,
    pauseReason: null,
    resumable: true,
  });
}

function cleanupStaleTasksAllUsers() {
  const cutoff = db.prepare("SELECT datetime('now', '-1 hour') as t").get().t;
  const stale = db.prepare(`
    SELECT id, user_id, type, title, status, phase, updated_at
    FROM tasks
    WHERE status IN ('processing', 'pending')
      AND updated_at < ?
  `).all(cutoff);

  let cleaned = 0;
  for (const task of stale) {
    update(task.id, task.user_id, {
      status: 'done',
      phase: 'cancelled',
      percent: 100,
      error: 'Auto-cancelled (stale > 1 hour)',
      resumable: false,
    });
    cleaned++;
  }
  return cleaned;
}

const HLS_ACTIVE_PHASES = new Set(['hls-convert', 'assembling', 'converting', 'playlist']);

function uploadTaskHasPendingHls(row, payload, fileRow) {
  if (HLS_ACTIVE_PHASES.has(row.phase)) return true;
  if (row.phase === 'uploading' && payload.segmentsTotal) return true;
  if (!payload.convertHls || !payload.fileId) return false;
  if (fileRow?.has_hls) return false;
  return fileRow?.upload_status === 'ready';
}

function cleanupStaleUploadTasks(userId) {
  const rows = db.prepare(`
    SELECT id, title, phase, percent, payload, updated_at
    FROM tasks
    WHERE user_id = ? AND type = 'upload' AND status IN ('processing', 'pending', 'paused')
  `).all(userId);

  let cleaned = 0;
  for (const row of rows) {
    const payload = row.payload ? JSON.parse(row.payload) : {};
    const fileName = payload.fileName || row.title;
    let file = null;
    if (payload.fileId) {
      file = db.prepare('SELECT upload_status, has_hls FROM files WHERE id = ? AND user_id = ?')
        .get(payload.fileId, userId);
    } else if (fileName) {
      file = db.prepare(`
        SELECT upload_status, has_hls FROM files
        WHERE user_id = ? AND name = ? AND is_folder = 0
        ORDER BY updated_at DESC LIMIT 1
      `).get(userId, fileName);
    }

    if (file?.upload_status === 'ready') {
      if (uploadTaskHasPendingHls(row, payload, file)) continue;
      update(row.id, userId, {
        status: 'done',
        phase: 'done',
        percent: 100,
        resumable: false,
        error: null,
      });
      cleaned += 1;
      continue;
    }

    const staleStarting = row.phase === 'starting'
      && row.updated_at < db.prepare("SELECT datetime('now', '-2 minutes') as t").get().t;
    const staleIdle = row.percent === 0
      && row.updated_at < db.prepare("SELECT datetime('now', '-10 minutes') as t").get().t;
    if (staleStarting || staleIdle) {
      update(row.id, userId, {
        status: 'error',
        phase: 'cancelled',
        error: 'Timed out',
        resumable: false,
      });
      cleaned += 1;
    }
  }
  return cleaned;
}

async function cancelTask(taskId, userId) {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(taskId, userId);
  if (!row) return null;

  const payload = row.payload ? JSON.parse(row.payload) : {};

  if (row.type === 'upload') {
    if (payload.fileId) {
      try {
        await require('./storage').cancelUploadSession(userId, payload.fileId);
      } catch {
        // file may already be gone or completed
      }
    }
  }

  if (row.type === 'hls-convert' && payload.fileId) {
    try {
      const hlsConvert = require('./hls-convert');
      await hlsConvert.cancelConversion(userId, payload.fileId);
    } catch {
      // conversion may already be finished
    }
  }

  if (row.type === 'repo-batch') {
    try {
      require('./repo-batch').cancelBatch(taskId);
    } catch {
      /* ignore */
    }
  }

  return update(taskId, userId, {
    status: 'error',
    phase: 'cancelled',
    error: 'Cancelled',
    resumable: false,
  });
}

function cleanupStaleHlsConvertTasks() {
  const rows = db.prepare(`
    SELECT id, user_id FROM tasks
    WHERE type = 'hls-convert' AND status IN ('processing', 'pending')
  `).all();
  for (const row of rows) {
    update(row.id, row.user_id, {
      status: 'error',
      phase: 'cancelled',
      error: 'Interrupted',
      resumable: false,
    });
  }
  return rows.length;
}

function list(userId, { activeOnly = true, includeResumable = false } = {}) {
  cleanupStaleUploadTasks(userId);
  try {
    require('./backup-sync').dedupeAllBackupTasks(userId);
  } catch {
    // backup-sync may be unavailable during tests
  }

  let rows;
  if (includeResumable) {
    rows = db.prepare(`
      SELECT * FROM tasks
      WHERE user_id = ? AND (
        status IN ('pending', 'processing', 'paused')
        OR (status = 'error' AND payload LIKE '%"resumable":true%')
      )
      ORDER BY created_at ASC
    `).all(userId);
  } else if (activeOnly) {
    rows = db.prepare(`
      SELECT * FROM tasks
      WHERE user_id = ? AND status IN ('pending', 'processing', 'paused')
      ORDER BY created_at ASC
    `).all(userId);
  } else {
    rows = db.prepare(`
      SELECT * FROM tasks
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 20
    `).all(userId);
  }
  return rows.map(parseRow);
}

function appendLog(taskId, userId, message, meta = {}) {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ? AND user_id = ?').get(taskId, userId);
  if (!row) return null;

  const payload = row.payload ? JSON.parse(row.payload) : {};
  const log = Array.isArray(payload.log) ? [...payload.log] : [];
  log.push({
    ts: new Date().toISOString(),
    msg: message,
    ...meta,
  });
  if (log.length > 120) log.splice(0, log.length - 120);

  return update(taskId, userId, { log, lastLog: message });
}

function remove(taskId, userId) {
  const result = db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').run(taskId, userId);
  return result.changes > 0;
}

function removeFailed(userId) {
  const result = db.prepare('DELETE FROM tasks WHERE user_id = ? AND status = ?').run(userId, 'error');
  return result.changes;
}

function cleanup() {
  cleanupStaleTasksAllUsers();
  db.prepare(`
    DELETE FROM tasks
    WHERE status = 'done'
      AND updated_at < datetime('now', '-1 hour')
  `).run();
  db.prepare(`
    DELETE FROM tasks
    WHERE status = 'error'
      AND (payload NOT LIKE '%"resumable":true%' AND payload NOT LIKE '%"resumable": true%')
      AND updated_at < datetime('now', '-1 hour')
  `).run();
  db.prepare(`
    DELETE FROM tasks
    WHERE status = 'error'
      AND (payload LIKE '%"resumable":true%' OR payload LIKE '%"resumable": true%')
      AND updated_at < datetime('now', '-7 days')
  `).run();
}

setInterval(cleanup, 10 * 60 * 1000);

module.exports = {
  create,
  update,
  get,
  list,
  appendLog,
  pause,
  resumeTask,
  cancelTask,
  cleanupStaleHlsConvertTasks,
  cleanupStaleUploadTasks,
  cleanupStaleTasksAllUsers,
  remove,
  removeFailed,
  cleanup,
};
