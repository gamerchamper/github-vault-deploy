/**
 * Bitbucket Cloud OAuth 2.0 helpers.
 * @see https://developer.atlassian.com/cloud/bitbucket/oauth-2/
 */
const appUrl = require('./app-url');

const AUTHORIZE_URL = 'https://bitbucket.org/site/oauth2/authorize';
const TOKEN_URL = 'https://bitbucket.org/site/oauth2/access_token';
const USER_URL = 'https://api.bitbucket.org/2.0/user';
const SCOPES = ['repository', 'repository:write', 'account'];

function isConfigured() {
  return !!(process.env.BITBUCKET_CLIENT_ID && process.env.BITBUCKET_CLIENT_SECRET);
}

function getCallbackUrl(req = null) {
  return appUrl.publicUrl(req, '/auth/bitbucket/callback');
}

function buildAuthorizeUrl(req, state = '') {
  const clientId = process.env.BITBUCKET_CLIENT_ID;
  if (!clientId) throw new Error('BITBUCKET_CLIENT_ID is not configured');
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: getCallbackUrl(req),
  });
  if (state) params.set('state', state);
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

async function exchangeCode(code, req = null) {
  const clientId = process.env.BITBUCKET_CLIENT_ID;
  const clientSecret = process.env.BITBUCKET_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('Bitbucket OAuth is not configured (BITBUCKET_CLIENT_ID / BITBUCKET_CLIENT_SECRET)');
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: getCallbackUrl(req),
  });

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error_description || data.error || `Token exchange failed (${res.status})`);
  }
  if (!data.access_token) throw new Error('No access token received from Bitbucket');
  return data;
}

async function fetchProfile(accessToken) {
  const res = await fetch(USER_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error?.message || `Failed to fetch Bitbucket profile (${res.status})`);
  }

  const avatar = data.links?.avatar?.href || null;
  return {
    id: String(data.uuid || data.account_id || data.username),
    username: data.username,
    displayName: data.display_name || data.username,
    photos: avatar ? [{ value: avatar }] : [],
    provider: 'bitbucket',
  };
}

module.exports = {
  SCOPES,
  AUTHORIZE_URL,
  TOKEN_URL,
  isConfigured,
  getCallbackUrl,
  buildAuthorizeUrl,
  exchangeCode,
  fetchProfile,
};
