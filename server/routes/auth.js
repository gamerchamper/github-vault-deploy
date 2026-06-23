const express = require('express');
const passport = require('passport');
const { requireAuth } = require('../middleware/auth');
const accounts = require('../services/accounts');
const apiKeys = require('../services/api-keys');
const db = require('../db/database');
const audit = require('../services/audit');
const router = express.Router();
const appUrl = require('../services/app-url');
const localAuth = require('../services/local-auth');
const siteAccess = require('../services/site-access');

const GITHUB_SCOPES = ['repo', 'user', 'read:org'];

function requireSiteAccessForAuth(req, res, next) {
  if (!siteAccess.isRequired() || siteAccess.isGranted(req)) return next();
  if (req.accepts('html')) {
    return res.redirect('/?site_access=1');
  }
  return siteAccess.denyResponse(res, true);
}

function linkErrorPage(message) {
  const safe = String(message).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link failed — GitHub Vault</title>
<link rel="stylesheet" href="/css/tokens.css">
<style>
body{font-family:var(--font);background:var(--bg-primary);color:var(--text-primary);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;margin:0}
.card{max-width:480px;background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:var(--radius-xl);padding:32px;box-shadow:var(--shadow-xl)}
.brand{font-size:13px;color:var(--accent);margin-bottom:16px;font-weight:600}
h1{font-size:20px;margin-bottom:12px}
p{line-height:1.6;color:var(--text-secondary);font-size:14px;margin-bottom:12px}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
</style></head><body>
<div class="card">
<div class="brand">📦 GitHub Vault</div>
<h1>Could not start account link</h1>
<p>${safe}</p>
<p>Go back to GitHub Vault on your main browser, open <strong>Storage Repositories</strong>, and copy a fresh link.</p>
<p><a href="/">Return to GitHub Vault</a></p>
</div></body></html>`;
}

router.get('/github', requireSiteAccessForAuth, (req, res, next) => {
  passport.authenticate('github', { scope: GITHUB_SCOPES })(req, res, next);
});

router.get('/github/link', requireSiteAccessForAuth, (req, res, next) => {
  const startOAuth = () => {
    passport.authenticate('github', { scope: GITHUB_SCOPES })(req, res, next);
  };

  if (req.query.token) {
    try {
      const row = accounts.peekLinkToken(req.query.token);
      req.session.linkingForUserId = row.user_id;
      req.session.linkingRole = row.role;
      req.session.linkingToken = req.query.token;
      return startOAuth();
    } catch (err) {
      return res.status(400).send(linkErrorPage(err.message));
    }
  }

  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.status(401).json({
      error: 'Not authenticated — open Storage Repositories and copy a one-time link instead',
    });
  }

  const role = accounts.parseLinkRole(req.query.role);
  req.session.linkingForUserId = req.user.id;
  req.session.linkingRole = role;
  startOAuth();
});

router.get('/github/reconnect', requireSiteAccessForAuth, (req, res, next) => {
  passport.authenticate('github', {
    scope: GITHUB_SCOPES,
    authorizationParams: { prompt: 'consent' },
  })(req, res, next);
});

router.get('/github/callback', (req, res, next) => {
  const wasLinking = !!(req.session?.linkingForUserId || req.session?.linkingToken);

  passport.authenticate('github', (err, user) => {
    if (err) {
      const reason = encodeURIComponent(err.message || 'Authentication failed');
      delete req.session.linkingForUserId;
      delete req.session.linkingRole;
      delete req.session.linkingToken;
      if (wasLinking) return res.redirect(`/?error=link_failed&reason=${reason}`);
      return res.redirect(`/?error=auth_failed&reason=${reason}`);
    }
    if (!user) {
      delete req.session.linkingToken;
      if (wasLinking) return res.redirect('/?error=link_failed');
      return res.redirect('/?error=auth_failed');
    }

    req.logIn(user, (loginErr) => {
      if (loginErr) return res.redirect('/?error=auth_failed');
      if (req.session.linkedSuccess) {
        delete req.session.linkedSuccess;
        return res.redirect('/?linked=1');
      }
      console.log(`User logged in: ${req.user.username} (id=${req.user.id})`);
      audit.log(req.user.id, 'login', { targetName: req.user.username, ip: req.ip });
      res.redirect('/');
    });
  })(req, res, next);
});

router.get('/me', (req, res) => {
  res.setHeader('Cache-Control', 'private, no-cache, must-revalidate');

  const site_access = siteAccess.status(req);

  const apiKeyUser = apiKeys.authenticateKey(apiKeys.extractKey(req));
  if (apiKeyUser) {
    return res.json({
      authenticated: true,
      app_url: appUrl.getAppUrl(req),
      auth_method: 'api-key',
      site_access,
      user: {
        id: apiKeyUser.id,
        username: apiKeyUser.username,
        avatar: apiKeyUser.avatar_url,
      },
    });
  }

  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.json({
      authenticated: false,
      app_url: appUrl.getAppUrl(req),
      local_auth: localAuth.getStatus(req),
      site_access,
    });
  }
  res.json({
    authenticated: true,
    app_url: appUrl.getAppUrl(req),
    auth_method: req.authType === 'local' ? 'local' : 'github',
    site_access,
    user: {
      id: req.user.id,
      username: req.user.username,
      avatar: req.user.avatar_url,
    },
  });
});

router.get('/api-keys', requireAuth, (req, res) => {
  res.json({ keys: apiKeys.listKeys(req.user.id) });
});

router.post('/api-keys', requireAuth, (req, res) => {
  try {
    const key = apiKeys.createKey(req.user.id, req.body.name);
    res.status(201).json({ key });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api-keys/:id', requireAuth, (req, res) => {
  const ok = apiKeys.revokeKey(req.user.id, req.params.id);
  if (!ok) return res.status(404).json({ error: 'API key not found' });
  res.json({ success: true });
});

const provisionTimestamps = new Map();
const PROVISION_COOLDOWN_MS = 30000;

router.post('/local-provision', (req, res) => {
  if (req.get('X-Vault-Local') !== '1') {
    return res.status(403).json({ error: 'Local provisioning requires X-Vault-Local header' });
  }

  const ip = req.ip || 'unknown';
  const last = provisionTimestamps.get(ip) || 0;
  if (Date.now() - last < PROVISION_COOLDOWN_MS) {
    return res.status(429).json({ error: 'Too many provisioning requests. Wait before retrying.' });
  }

  try {
    const firstUser = db.prepare('SELECT id, username FROM users ORDER BY id ASC LIMIT 1').get();
    if (!firstUser) return res.status(404).json({ error: 'No users found on server — sign in via the web UI first' });

    const key = apiKeys.createKey(firstUser.id, 'auto-provisioned');
    provisionTimestamps.set(ip, Date.now());
    res.json({
      key: key.key,
      serverUrl: `${req.protocol}://${req.get('host')}`,
      userId: firstUser.id,
      username: firstUser.username,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/logout', (req, res) => {
  audit.log(req.user?.id, 'logout', { targetName: req.user?.username, ip: req.ip });
  req.logout((err) => {
    if (err) return res.status(500).json({ error: 'Logout failed' });
    req.session = null;
    res.json({ success: true });
  });
});

const bitbucketOauth = require('../services/bitbucket-oauth');
const codebergOauth = require('../services/codeberg-oauth');
const storageProvider = require('../services/storage-provider');

router.get('/storage-providers', (req, res) => {
  res.json({
    providers: storageProvider.listProviders().map((p) => ({
      ...p,
      configured: storageProvider.isConfigured(p.id),
    })),
  });
});

router.get('/bitbucket/link', requireSiteAccessForAuth, (req, res) => {
  if (!bitbucketOauth.isConfigured()) {
    return res.status(503).send(linkErrorPage('Bitbucket OAuth is not configured on this server (BITBUCKET_CLIENT_ID / BITBUCKET_CLIENT_SECRET)'));
  }

  const startOAuth = () => {
    const state = req.session.linkingToken || '';
    res.redirect(bitbucketOauth.buildAuthorizeUrl(req, state));
  };

  if (req.query.token) {
    try {
      const row = accounts.peekLinkToken(req.query.token);
      if (storageProvider.normalizeProvider(row.provider) !== 'bitbucket') {
        return res.status(400).send(linkErrorPage('This link is for Bitbucket — generate a Bitbucket link from Storage Repositories'));
      }
      req.session.linkingForUserId = row.user_id;
      req.session.linkingRole = row.role;
      req.session.linkingToken = req.query.token;
      req.session.linkingProvider = 'bitbucket';
      return startOAuth();
    } catch (err) {
      return res.status(400).send(linkErrorPage(err.message));
    }
  }

  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.status(401).json({
      error: 'Not authenticated — open Storage Repositories and copy a one-time Bitbucket link',
    });
  }

  req.session.linkingForUserId = req.user.id;
  req.session.linkingRole = accounts.parseLinkRole(req.query.role);
  req.session.linkingProvider = 'bitbucket';
  startOAuth();
});

router.get('/bitbucket/callback', async (req, res) => {
  const wasLinking = !!(req.session?.linkingForUserId || req.session?.linkingToken);
  const code = req.query.code;
  if (!code) {
    const reason = encodeURIComponent(req.query.error_description || req.query.error || 'Missing authorization code');
    return res.redirect(`/?error=link_failed&reason=${reason}`);
  }

  try {
    const tokenData = await bitbucketOauth.exchangeCode(code, req);
    const profile = await bitbucketOauth.fetchProfile(tokenData.access_token);
    const linkToken = req.session.linkingToken;
    let userId = req.session.linkingForUserId;
    let role = req.session.linkingRole || 'storage';

    if (linkToken) {
      const row = accounts.consumeLinkToken(linkToken);
      userId = row.user_id;
      role = row.role;
    }
    if (!userId) throw new Error('Vault session expired — generate a fresh link');

    await accounts.linkAccount(userId, profile, tokenData.access_token, role, 'bitbucket');

    delete req.session.linkingForUserId;
    delete req.session.linkingRole;
    delete req.session.linkingToken;
    delete req.session.linkingProvider;

    const vaultUser = db.prepare(
      'SELECT id, github_id, username, avatar_url FROM users WHERE id = ?'
    ).get(userId);
    if (!vaultUser) throw new Error('Vault user not found');

    req.session.linkedSuccess = true;
    req.session.linkedProvider = 'bitbucket';
    req.logIn(vaultUser, (loginErr) => {
      if (loginErr) return res.redirect('/?error=link_failed');
      return res.redirect('/?linked=1&provider=bitbucket');
    });
  } catch (err) {
    console.error('Bitbucket link callback error:', err);
    delete req.session.linkingForUserId;
    delete req.session.linkingRole;
    delete req.session.linkingToken;
    delete req.session.linkingProvider;
    const reason = encodeURIComponent(err.message || 'Bitbucket link failed');
    if (wasLinking) return res.redirect(`/?error=link_failed&reason=${reason}`);
    return res.redirect(`/?error=auth_failed&reason=${reason}`);
  }
});

router.get('/codeberg/link', requireSiteAccessForAuth, (req, res) => {
  if (!codebergOauth.isConfigured()) {
    return res.status(503).send(linkErrorPage('Codeberg OAuth is not configured on this server (CODEBERG_CLIENT_ID / CODEBERG_CLIENT_SECRET)'));
  }

  const startOAuth = () => {
    const state = req.session.linkingToken || '';
    res.redirect(codebergOauth.buildAuthorizeUrl(req, state));
  };

  if (req.query.token) {
    try {
      const row = accounts.peekLinkToken(req.query.token);
      if (storageProvider.normalizeProvider(row.provider) !== 'codeberg') {
        return res.status(400).send(linkErrorPage('This link is for Codeberg — generate a Codeberg link from Storage Repositories'));
      }
      req.session.linkingForUserId = row.user_id;
      req.session.linkingRole = row.role;
      req.session.linkingToken = req.query.token;
      req.session.linkingProvider = 'codeberg';
      return startOAuth();
    } catch (err) {
      return res.status(400).send(linkErrorPage(err.message));
    }
  }

  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.status(401).json({
      error: 'Not authenticated — open Storage Repositories and copy a one-time Codeberg link',
    });
  }

  req.session.linkingForUserId = req.user.id;
  req.session.linkingRole = accounts.parseLinkRole(req.query.role);
  req.session.linkingProvider = 'codeberg';
  startOAuth();
});

router.get('/codeberg/callback', async (req, res) => {
  const wasLinking = !!(req.session?.linkingForUserId || req.session?.linkingToken);
  const code = req.query.code;
  if (!code) {
    const reason = encodeURIComponent(req.query.error_description || req.query.error || 'Missing authorization code');
    return res.redirect(`/?error=link_failed&reason=${reason}`);
  }

  try {
    const tokenData = await codebergOauth.exchangeCode(code, req);
    const profile = await codebergOauth.fetchProfile(tokenData.access_token);
    const linkToken = req.session.linkingToken;
    let userId = req.session.linkingForUserId;
    let role = req.session.linkingRole || 'storage';

    if (linkToken) {
      const row = accounts.consumeLinkToken(linkToken);
      userId = row.user_id;
      role = row.role;
    }
    if (!userId) throw new Error('Vault session expired — generate a fresh link');

    await accounts.linkAccount(userId, profile, tokenData.access_token, role, 'codeberg');

    delete req.session.linkingForUserId;
    delete req.session.linkingRole;
    delete req.session.linkingToken;
    delete req.session.linkingProvider;

    const vaultUser = db.prepare(
      'SELECT id, github_id, username, avatar_url FROM users WHERE id = ?'
    ).get(userId);
    if (!vaultUser) throw new Error('Vault user not found');

    req.session.linkedSuccess = true;
    req.session.linkedProvider = 'codeberg';
    req.logIn(vaultUser, (loginErr) => {
      if (loginErr) return res.redirect('/?error=link_failed');
      return res.redirect('/?linked=1&provider=codeberg');
    });
  } catch (err) {
    console.error('Codeberg link callback error:', err);
    delete req.session.linkingForUserId;
    delete req.session.linkingRole;
    delete req.session.linkingToken;
    delete req.session.linkingProvider;
    const reason = encodeURIComponent(err.message || 'Codeberg link failed');
    if (wasLinking) return res.redirect(`/?error=link_failed&reason=${reason}`);
    return res.redirect(`/?error=auth_failed&reason=${reason}`);
  }
});

const pastebinAuth = require('../services/pastebin-auth');

function pastebinLinkPage({ token, role, error = null }) {
  const safeError = error
    ? String(error).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    : '';
  const roleLabel = accounts.linkRoleLabel(role);
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link Pastebin — GitHub Vault</title>
<link rel="stylesheet" href="/css/tokens.css">
<style>
body{font-family:var(--font);background:var(--bg-primary);color:var(--text-primary);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;margin:0}
.card{max-width:440px;width:100%;background:var(--glass-bg);border:1px solid var(--glass-border);border-radius:var(--radius-xl);padding:32px;box-shadow:var(--shadow-xl)}
.brand{font-size:13px;color:var(--accent);margin-bottom:16px;font-weight:600}
h1{font-size:20px;margin-bottom:8px}
p{line-height:1.6;color:var(--text-secondary);font-size:14px;margin-bottom:16px}
label{display:block;font-size:13px;margin-bottom:6px;color:var(--text-secondary)}
input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:var(--radius-md);border:1px solid var(--glass-border);background:var(--bg-secondary);color:var(--text-primary);margin-bottom:14px}
button{width:100%;padding:12px;border:none;border-radius:var(--radius-md);background:var(--accent);color:#fff;font-weight:600;cursor:pointer}
.error{background:rgba(255,80,80,.12);border:1px solid rgba(255,80,80,.35);padding:10px 12px;border-radius:var(--radius-md);margin-bottom:14px;font-size:13px;color:#ffb4b4}
.note{font-size:12px;color:var(--text-muted)}
</style></head><body>
<div class="card">
<div class="brand">📦 GitHub Vault · Pastebin</div>
<h1>Link Pastebin account</h1>
<p>Sign in with your Pastebin member credentials to link this account for <strong>${roleLabel}</strong>. Your password is sent once to obtain an API session key and is not stored.</p>
${safeError ? `<div class="error">${safeError}</div>` : ''}
<form method="POST" action="/auth/pastebin/link">
<input type="hidden" name="token" value="${String(token || '').replace(/"/g, '&quot;')}">
<label for="username">Pastebin username</label>
<input id="username" name="username" autocomplete="username" required>
<label for="password">Pastebin password</label>
<input id="password" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Link Pastebin account</button>
</form>
<p class="note">Requires <code>PASTEBIN_DEV_KEY</code> on the vault server. Chunks are stored as unlisted pastes (max ~512 KB each on free accounts).</p>
</div></body></html>`;
}

function beginPastebinLink(req, res, { token = null, role = 'storage' } = {}) {
  if (!pastebinAuth.isConfigured()) {
    return res.status(503).send(linkErrorPage('Pastebin API is not configured on this server (PASTEBIN_DEV_KEY)'));
  }
  if (token) {
    try {
      const row = accounts.peekLinkToken(token);
      if (storageProvider.normalizeProvider(row.provider) !== 'pastebin') {
        return res.status(400).send(linkErrorPage('This link is for Pastebin — generate a Pastebin link from Storage Repositories'));
      }
      req.session.linkingForUserId = row.user_id;
      req.session.linkingRole = row.role;
      req.session.linkingToken = token;
      req.session.linkingProvider = 'pastebin';
      return res.send(pastebinLinkPage({ token, role: row.role }));
    } catch (err) {
      return res.status(400).send(linkErrorPage(err.message));
    }
  }
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.status(401).send(linkErrorPage('Not authenticated — copy a one-time Pastebin link from Storage Repositories'));
  }
  req.session.linkingForUserId = req.user.id;
  req.session.linkingRole = role;
  req.session.linkingProvider = 'pastebin';
  return res.send(pastebinLinkPage({ token: '', role }));
}

router.get('/pastebin/link', requireSiteAccessForAuth, (req, res) => {
  beginPastebinLink(req, res, {
    token: req.query.token || null,
    role: accounts.parseLinkRole(req.query.role),
  });
});

router.post('/pastebin/link', requireSiteAccessForAuth, express.urlencoded({ extended: false }), async (req, res) => {
  const wasLinking = !!(req.session?.linkingForUserId || req.session?.linkingToken);
  try {
    if (!pastebinAuth.isConfigured()) {
      throw new Error('Pastebin API is not configured on this server (PASTEBIN_DEV_KEY)');
    }

    const token = req.body?.token || req.session.linkingToken;
    let userId = req.session.linkingForUserId;
    let role = req.session.linkingRole || 'storage';

    if (token) {
      const row = accounts.peekLinkToken(token);
      userId = row.user_id;
      role = row.role;
    }
    if (!userId) throw new Error('Vault session expired — generate a fresh link');

    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    if (!username || !password) {
      throw new Error('Pastebin username and password are required');
    }

    const { api_user_key, profile } = await pastebinAuth.login(username, password);
    if (token) accounts.consumeLinkToken(token);
    await accounts.linkAccount(userId, profile, api_user_key, role, 'pastebin');

    delete req.session.linkingForUserId;
    delete req.session.linkingRole;
    delete req.session.linkingToken;
    delete req.session.linkingProvider;

    const vaultUser = db.prepare(
      'SELECT id, github_id, username, avatar_url FROM users WHERE id = ?'
    ).get(userId);
    if (!vaultUser) throw new Error('Vault user not found');

    req.session.linkedSuccess = true;
    req.session.linkedProvider = 'pastebin';
    req.logIn(vaultUser, (loginErr) => {
      if (loginErr) return res.redirect('/?error=link_failed');
      return res.redirect('/?linked=1&provider=pastebin');
    });
  } catch (err) {
    console.error('Pastebin link error:', err);
    const token = req.body?.token || req.session?.linkingToken || '';
    const role = req.session?.linkingRole || 'storage';
    if (wasLinking && token) {
      return res.status(400).send(pastebinLinkPage({ token, role, error: err.message }));
    }
    const reason = encodeURIComponent(err.message || 'Pastebin link failed');
    if (wasLinking) return res.redirect(`/?error=link_failed&reason=${reason}`);
    return res.redirect(`/?error=auth_failed&reason=${reason}`);
  }
});

module.exports = router;
