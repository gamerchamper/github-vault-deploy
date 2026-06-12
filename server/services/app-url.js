function stripTrailingSlash(url) {
  return String(url).replace(/\/+$/, '');
}

function normalizeAppUrl(url) {
  if (!url) return null;
  const trimmed = String(url).trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    return stripTrailingSlash(`${parsed.protocol}//${parsed.host}`);
  } catch {
    return stripTrailingSlash(trimmed);
  }
}

function fromRequest(req) {
  if (!req) return null;

  const forwardedProto = req.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const proto = forwardedProto || (req.secure ? 'https' : 'http');

  const forwardedHost = req.get('x-forwarded-host')?.split(',')[0]?.trim();
  const host = forwardedHost || req.get('host');
  if (!host) return null;

  return stripTrailingSlash(`${proto}://${host}`);
}

function getConfiguredAppUrl() {
  return normalizeAppUrl(process.env.APP_URL);
}

function getAppUrl(req) {
  const configured = getConfiguredAppUrl();
  if (configured) return configured;

  const derived = fromRequest(req);
  if (derived) return derived;

  const port = process.env.PORT || 3000;
  return `http://localhost:${port}`;
}

function getOAuthCallbackUrl() {
  const configured = getConfiguredAppUrl();
  if (configured) return `${configured}/auth/github/callback`;

  const port = process.env.PORT || 3000;
  return `http://localhost:${port}/auth/github/callback`;
}

function isSecureAppUrl() {
  const configured = getConfiguredAppUrl();
  return configured ? configured.startsWith('https://') : false;
}

function publicUrl(req, pathname) {
  const base = getAppUrl(req);
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${base}${path}`;
}

module.exports = {
  getAppUrl,
  getConfiguredAppUrl,
  fromRequest,
  getOAuthCallbackUrl,
  isSecureAppUrl,
  publicUrl,
};
