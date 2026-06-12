const { v4: uuidv4 } = require('uuid');
const nodeCrypto = require('crypto');

const sessions = new Map();
const TTL_MS = 30 * 60 * 1000;

function create({ userId, fileId, view = null, token = null }) {
  const id = uuidv4();
  const authToken = nodeCrypto.randomBytes(24).toString('hex');
  sessions.set(id, {
    id,
    userId,
    fileId,
    view,
    token,
    authToken,
    fetched: 0,
    total: 0,
    stage: 'starting',
    ready: false,
    error: null,
    buffer: null,
    file: null,
    createdAt: Date.now(),
    lastAccess: Date.now(),
  });
  return id;
}

function touch(session) {
  if (session) session.lastAccess = Date.now();
}

function get(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (Date.now() - session.createdAt > TTL_MS) {
    sessions.delete(sessionId);
    return null;
  }
  touch(session);
  return session;
}

function validate(sessionId, authToken) {
  const session = get(sessionId);
  if (!session || !authToken || session.authToken !== authToken) return null;
  return session;
}

function update(sessionId, patch) {
  const session = get(sessionId);
  if (!session) return null;
  Object.assign(session, patch);
  return session;
}

function complete(sessionId, buffer, file) {
  const session = get(sessionId);
  return update(sessionId, {
    buffer,
    file,
    ready: true,
    stage: 'done',
    fetched: session?.total || session?.fetched || 0,
  });
}

function fail(sessionId, error) {
  return update(sessionId, { error: String(error), stage: 'error' });
}

function remove(sessionId) {
  sessions.delete(sessionId);
}

function toStatus(session) {
  if (!session) return null;
  const total = session.total || 0;
  const fetched = session.fetched || 0;
  let percent = 0;
  if (session.stage === 'cached' || session.stage === 'done') {
    percent = 100;
  } else if (session.stage === 'decrypting') {
    percent = total > 0 ? Math.min(99, Math.round((fetched / total) * 100) + 5) : 95;
  } else if (total > 0) {
    percent = Math.round((fetched / total) * 100);
  }
  const expiresAt = session.createdAt + TTL_MS;
  return {
    fetched,
    total,
    stage: session.stage,
    ready: session.ready,
    error: session.error,
    percent,
    fileName: session.file?.name || null,
    expiresAt,
  };
}

function sendPreparedFile(res, session, mimeType, fileName) {
  const { buffer, file } = session;
  res.setHeader('Content-Type', mimeType || file?.mime_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(fileName || file?.name || 'download')}"`);
  res.setHeader('Content-Length', buffer.length);
  return res.send(buffer);
}

function cleanup() {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > TTL_MS) sessions.delete(id);
  }
}

setInterval(cleanup, 60000);

module.exports = {
  create,
  get,
  validate,
  update,
  complete,
  fail,
  remove,
  toStatus,
  sendPreparedFile,
  TTL_MS,
};
