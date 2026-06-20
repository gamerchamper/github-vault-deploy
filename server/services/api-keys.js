const crypto = require('crypto');
const db = require('../db/database');

const KEY_PREFIX = 'gv';

function hashKey(key) {
  return crypto.createHash('sha256').update(String(key || ''), 'utf8').digest('hex');
}

function generateKey() {
  return `${KEY_PREFIX}_${crypto.randomBytes(32).toString('base64url')}`;
}

function sanitizeName(name) {
  const value = String(name || 'Client API key').trim();
  return value.slice(0, 80) || 'Client API key';
}

function createKey(userId, name) {
  const key = generateKey();
  const keyHash = hashKey(key);
  const keyPrefix = key.slice(0, 12);
  const result = db.prepare(`
    INSERT INTO api_keys (user_id, name, key_hash, key_prefix, key_secret)
    VALUES (?, ?, ?, ?, ?)
  `).run(userId, sanitizeName(name), keyHash, keyPrefix, key);
  const row = db.prepare(`
    SELECT id, name, key_prefix, key_secret, created_at, last_used_at, revoked_at
    FROM api_keys WHERE id = ? AND user_id = ?
  `).get(result.lastInsertRowid, userId);
  return { ...row, key };
}

function listKeys(userId) {
  return db.prepare(`
    SELECT id, name, key_prefix, key_secret, created_at, last_used_at, revoked_at
    FROM api_keys
    WHERE user_id = ?
    ORDER BY created_at DESC, id DESC
  `).all(userId);
}

function revokeKey(userId, keyId) {
  const result = db.prepare(`
    UPDATE api_keys
    SET revoked_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = ? AND revoked_at IS NULL
  `).run(keyId, userId);
  return result.changes > 0;
}

function authenticateKey(rawKey) {
  if (!rawKey || !String(rawKey).startsWith(`${KEY_PREFIX}_`)) return null;
  const keyHash = hashKey(rawKey);
  const row = db.prepare(`
    SELECT ak.id as key_id, ak.name as key_name, u.id, u.github_id, u.username, u.avatar_url
    FROM api_keys ak
    JOIN users u ON u.id = ak.user_id
    WHERE ak.key_hash = ? AND ak.revoked_at IS NULL
  `).get(keyHash);
  if (!row) return null;
  db.prepare(`
    UPDATE api_keys
    SET last_used_at = CURRENT_TIMESTAMP
    WHERE id = ? AND (last_used_at IS NULL OR last_used_at < datetime('now', '-1 minute'))
  `).run(row.key_id);
  return {
    id: row.id,
    github_id: row.github_id,
    username: row.username,
    avatar_url: row.avatar_url,
    apiKey: { id: row.key_id, name: row.key_name },
  };
}

function extractKey(req) {
  const header = req.get('authorization') || '';
  const bearer = header.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  return req.get('x-api-key') || req.query.api_key || null;
}

module.exports = { createKey, listKeys, revokeKey, authenticateKey, extractKey, hashKey };
