const express = require('express');
const passport = require('passport');
const { requireAuth } = require('../middleware/auth');
const accounts = require('../services/accounts');
const apiKeys = require('../services/api-keys');
const db = require('../db/database');
const audit = require('../services/audit');
const router = express.Router();
const appUrl = require('../services/app-url');

const GITHUB_SCOPES = ['repo', 'user', 'read:org'];

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

router.get('/github', (req, res, next) => {
  passport.authenticate('github', { scope: GITHUB_SCOPES })(req, res, next);
});

router.get('/github/link', (req, res, next) => {
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

  const role = req.query.role === 'backup' ? 'backup' : 'storage';
  req.session.linkingForUserId = req.user.id;
  req.session.linkingRole = role;
  startOAuth();
});

router.get('/github/reconnect', (req, res, next) => {
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
  if (!req.isAuthenticated || !req.isAuthenticated()) {
    return res.json({ authenticated: false, app_url: appUrl.getAppUrl(req) });
  }
  res.json({
    authenticated: true,
    app_url: appUrl.getAppUrl(req),
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

module.exports = router;
