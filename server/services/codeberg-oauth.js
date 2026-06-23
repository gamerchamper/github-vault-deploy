/**
 * Codeberg OAuth 2.0 helpers (Forgejo/Gitea-compatible).
 * @see https://docs.codeberg.org/advanced/access-token/
 * @see https://codeberg.org/api/swagger
 */
const appUrl = require('./app-url');

const CODEBERG_BASE = (process.env.CODEBERG_BASE_URL || 'https://codeberg.org').replace(/\/$/, '');
const AUTHORIZE_URL = `${CODEBERG_BASE}/login/oauth/authorize`;
const TOKEN_URL = `${CODEBERG_BASE}/login/oauth/access_token`;
const USER_URL = `${CODEBERG_BASE}/api/v1/user`;
const SCOPES = ['read:user', 'read:repository', 'write:repository', 'read:organization'];

function isConfigured() {
  return !!(process.env.CODEBERG_CLIENT_ID && process.env.CODEBERG_CLIENT_SECRET);
}

function getCallbackUrl(req = null) {
  return appUrl.publicUrl(req, '/auth/codeberg/callback');
}

function buildAuthorizeUrl(req, state = '') {
  const clientId = process.env.CODEBERG_CLIENT_ID;
  if (!clientId) throw new Error('CODEBERG_CLIENT_ID is not configured');
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: getCallbackUrl(req),
  });
  if (state) params.set('state', state);
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function exchangeCode(code, req = null) {
  const clientId = process.env.CODEBERG_CLIENT_ID;
  const clientSecret = process.env.CODEBERG_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Codeberg OAuth is not configured (CODEBERG_CLIENT_ID / CODEBERG_CLIENT_SECRET)');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: getCallbackUrl(req),
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error_description || data.error || `Token exchange failed (${res.status})`);
  }
  if (!data.access_token) throw new Error('No access token received from Codeberg');
  return data;
}

async function fetchProfile(accessToken) {
  const res = await fetch(USER_URL, {
    headers: {
      Authorization: `token ${accessToken}`,
      Accept: 'application/json',
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.message || `Failed to fetch Codeberg profile (${res.status})`);
  }

  const avatar = data.avatar_url || null;
  return {
    id: String(data.id || data.login),
    username: data.login || data.username,
    displayName: data.full_name || data.login,
    photos: avatar ? [{ value: avatar }] : [],
    provider: 'codeberg',
  };
}

module.exports = {
  SCOPES,
  CODEBERG_BASE,
  AUTHORIZE_URL,
  TOKEN_URL,
  isConfigured,
  getCallbackUrl,
  buildAuthorizeUrl,
  exchangeCode,
  fetchProfile,
};
