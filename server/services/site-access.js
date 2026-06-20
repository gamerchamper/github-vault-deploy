const crypto = require('crypto');
const db = require('../db/database');

const SETTING_KEY = 'site_access_key';

function normalizeKey(raw) {
  const s = String(raw ?? '').trim();
  return /^\d{6}$/.test(s) ? s : null;
}

function getDbSettingRaw() {
  try {
    const row = db.prepare('SELECT value FROM server_settings WHERE key = ?').get(SETTING_KEY);
    return row === undefined ? undefined : row.value;
  } catch {
    return undefined;
  }
}

function getConfiguredKey() {
  const raw = getDbSettingRaw();
  if (raw !== undefined) {
    if (raw === '' || raw == null) return null;
    return normalizeKey(raw);
  }
  return normalizeKey(process.env.SITE_ACCESS_KEY);
}

function isRequired() {
  return !!getConfiguredKey();
}

function keysMatch(provided) {
  const expected = getConfiguredKey();
  if (!expected) return true;
  const p = normalizeKey(provided);
  if (!p) return false;
  const a = Buffer.from(p, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function grantSession(req) {
  if (req.session) req.session.siteAccessVerified = true;
}

function isGranted(req) {
  if (!isRequired()) return true;
  if (req.session?.siteAccessVerified) return true;
  const header = req.get('x-vault-access-key') || req.get('x-site-access-key');
  if (header && keysMatch(header)) {
    grantSession(req);
    return true;
  }
  const queryKey = req.query?.access;
  if (queryKey && keysMatch(String(queryKey))) {
    grantSession(req);
    return true;
  }
  return false;
}

function status(req) {
  const required = isRequired();
  return {
    required,
    unlocked: !required || isGranted(req),
  };
}

function denyResponse(res, acceptsJson = true) {
  if (acceptsJson) {
    return res.status(403).json({
      error: 'Site access key required',
      code: 'SITE_ACCESS_REQUIRED',
    });
  }
  return res.status(403).type('text').send('Site access key required');
}

function getAdminStatus() {
  const raw = getDbSettingRaw();
  const dbKey = raw !== undefined && raw !== '' ? normalizeKey(raw) : null;
  const envKey = normalizeKey(process.env.SITE_ACCESS_KEY);
  const explicitlyDisabled = raw !== undefined && (raw === '' || raw == null);
  let source = 'none';
  let activeKey = null;
  if (dbKey) {
    source = 'database';
    activeKey = dbKey;
  } else if (!explicitlyDisabled && envKey) {
    source = 'environment';
    activeKey = envKey;
  } else if (explicitlyDisabled) {
    source = 'disabled';
  }
  return {
    required: !!activeKey,
    configured: !!activeKey,
    source,
    env_fallback_available: !!envKey && raw === undefined,
    explicitly_disabled: explicitlyDisabled,
    key_hint: activeKey ? `••••${activeKey.slice(-2)}` : null,
  };
}

function setConfiguredKey(key) {
  const normalized = normalizeKey(key);
  if (!normalized) throw new Error('Access key must be exactly 6 digits');
  db.prepare(`
    INSERT INTO server_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(SETTING_KEY, normalized);
  return normalized;
}

function clearConfiguredKey() {
  db.prepare(`
    INSERT INTO server_settings (key, value, updated_at) VALUES (?, '', datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = '', updated_at = excluded.updated_at
  `).run(SETTING_KEY);
}

function resetToEnvironment() {
  db.prepare('DELETE FROM server_settings WHERE key = ?').run(SETTING_KEY);
}

module.exports = {
  getConfiguredKey,
  isRequired,
  keysMatch,
  grantSession,
  isGranted,
  status,
  denyResponse,
  getAdminStatus,
  setConfiguredKey,
  clearConfiguredKey,
  resetToEnvironment,
};
