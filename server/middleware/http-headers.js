/**
 * Global HTTP headers: security, charset, cache policy for static assets.
 */
const path = require('path');
const pkg = require('../../package.json');

const ASSET_VERSION = process.env.ASSET_VERSION || pkg.version || '1';

function applySecurityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
}

const CHARSET_TYPES = new Set([
  'application/json',
  'application/javascript',
  'application/manifest+json',
  'application/xml',
  'text/xml',
]);

function normalizeContentType(value) {
  if (typeof value !== 'string') return value;
  const parts = value.split(';').map((p) => p.trim());
  const base = parts[0].toLowerCase();

  const noCharset = /^(image|video|audio|font)\//i.test(base)
    || base === 'application/octet-stream'
    || base === 'application/vnd.apple.mpegurl'
    || base === 'image/x-icon';

  if (noCharset) return parts[0];

  const hasCharset = parts.some((p) => /^charset=/i.test(p));
  if (hasCharset) return value;

  if (/^text\//i.test(base) || CHARSET_TYPES.has(base)) {
    return `${parts[0]}; charset=utf-8`;
  }

  return parts[0];
}

function ensureUtf8Charset(req, res, next) {
  const originalSetHeader = res.setHeader.bind(res);
  res.setHeader = (name, value) => {
    if (typeof name === 'string' && typeof value === 'string'
      && name.toLowerCase() === 'content-type') {
      return originalSetHeader(name, normalizeContentType(value));
    }
    return originalSetHeader(name, value);
  };
  next();
}

function staticAssetHeaders(res, filePath, publicRoot) {
  const rel = path.relative(publicRoot, filePath).replace(/\\/g, '/');
  if (/\.html?$/i.test(rel)) {
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
    return;
  }
  if (/\.webmanifest$/i.test(rel)) {
    res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return;
  }
  if (/favicon\.ico$/i.test(rel)) {
    res.setHeader('Content-Type', 'image/x-icon');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return;
  }
  if (/\.(js|css|mjs|woff2?|ttf|otf|ico|png|jpe?g|gif|webp|svg|webmanifest)$/i.test(rel)) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  }
}

module.exports = {
  ASSET_VERSION,
  applySecurityHeaders,
  ensureUtf8Charset,
  staticAssetHeaders,
};
