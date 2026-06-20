const crypto = require('crypto');

function normalizeKey(raw) {
  const s = String(raw ?? '').trim();
  return /^\d{6}$/.test(s) ? s : null;
}

function getConfiguredKey() {
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

module.exports = {
  getConfiguredKey,
  isRequired,
  keysMatch,
  grantSession,
  isGranted,
  status,
  denyResponse,
};
