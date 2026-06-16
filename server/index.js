require('dotenv').config();

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (server continuing):', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection (server continuing):', reason);
});

const express = require('express');
const cookieSession = require('cookie-session');
const passport = require('passport');
const GitHubStrategy = require('passport-github2').Strategy;
const path = require('path');
const db = require('./db/database');

const authRoutes = require('./routes/auth');
const fileRoutes = require('./routes/files');
const repoRoutes = require('./routes/repos');
const publicRoutes = require('./routes/public');
const cacheRoutes = require('./routes/cache');
const taskRoutes = require('./routes/tasks');
const accountRoutes = require('./routes/accounts');
const viewerRoutes = require('./routes/viewers');
const bandwidthRoutes = require('./routes/bandwidth');
const sharePageRoutes = require('./routes/share-page');
const playlistRoutes = require('./routes/playlists');
const { requireAuth } = require('./middleware/auth');
const { ensureSetup } = require('./middleware/setup');

const appUrlService = require('./services/app-url');
const {
  applySecurityHeaders,
  ensureUtf8Charset,
  staticAssetHeaders,
} = require('./middleware/http-headers');

const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '../public');
const sessionSecret = process.env.SESSION_SECRET || (() => {
  const gen = crypto.randomBytes(32).toString('hex');
  console.warn('SESSION_SECRET not set — generated random secret for this session. All sessions will be invalidated on restart. Set SESSION_SECRET in .env for persistent sessions.');
  return gen;
})();
const secureCookies = appUrlService.isSecureAppUrl();

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.set('etag', true);

app.use(applySecurityHeaders);
app.use(ensureUtf8Charset);
app.use(express.json());

app.use(cookieSession({
  name: 'vault.sid',
  keys: [sessionSecret],
  maxAge: 7 * 24 * 60 * 60 * 1000,
  sameSite: 'lax',
  httpOnly: true,
  secure: secureCookies,
  path: '/',
}));

// cookie-session does not implement regenerate/save; passport 0.7 requires both on login/logout
app.use((req, res, next) => {
  if (!req.session) return next();

  if (typeof req.session.regenerate !== 'function') {
    req.session.regenerate = function (cb) {
      for (const key of Object.keys(this)) {
        if (key !== 'regenerate' && key !== 'save') delete this[key];
      }
      cb(null);
    };
  }

  if (typeof req.session.save !== 'function') {
    req.session.save = function (cb) {
      cb(null);
    };
  }

  next();
});

passport.use(new GitHubStrategy({
  clientID: process.env.GITHUB_CLIENT_ID,
  clientSecret: process.env.GITHUB_CLIENT_SECRET,
  callbackURL: appUrlService.getOAuthCallbackUrl(),
  passReqToCallback: true,
}, async (req, accessToken, refreshToken, profile, done) => {
  try {
    if (!accessToken) return done(new Error('No access token received from GitHub'));

    const vaultUserId = req.session?.linkingForUserId;
    if (vaultUserId) {
      const role = req.session.linkingRole || 'storage';
      delete req.session.linkingForUserId;
      delete req.session.linkingRole;

      const accounts = require('./services/accounts');
      await accounts.linkAccount(vaultUserId, profile, accessToken, role);

      if (req.session.linkingToken) {
        try {
          accounts.consumeLinkToken(req.session.linkingToken);
        } catch {
          // token may already be consumed
        }
        delete req.session.linkingToken;
      }

      const vaultUser = db.prepare(
        'SELECT id, github_id, username, avatar_url FROM users WHERE id = ?'
      ).get(vaultUserId);
      if (!vaultUser) return done(new Error('Vault session expired. Sign in again.'));

      req.session.linkedSuccess = true;
      return done(null, vaultUser);
    }

    const githubId = String(profile.id);
    let user = db.prepare('SELECT * FROM users WHERE github_id = ?').get(githubId);

    if (user) {
      db.prepare('UPDATE users SET access_token = ?, username = ?, avatar_url = ? WHERE id = ?')
        .run(accessToken, profile.username, profile.photos?.[0]?.value, user.id);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    } else {
      const result = db.prepare(
        'INSERT INTO users (github_id, username, avatar_url, access_token) VALUES (?, ?, ?, ?)'
      ).run(githubId, profile.username, profile.photos?.[0]?.value, accessToken);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
    }

    return done(null, user);
  } catch (err) {
    console.error('GitHub strategy error:', err);
    return done(err);
  }
}));

passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser((id, done) => {
  try {
    const user = db.prepare('SELECT id, github_id, username, avatar_url FROM users WHERE id = ?').get(id);
    if (!user) return done(null, false);
    done(null, user);
  } catch (err) {
    done(err);
  }
});

app.get('/health', (req, res) => {
  try {
    const workloadGovernor = require('./services/workload-governor');
    const rateLimit = require('./services/github-rate-limit');
    const github = require('./services/github');
    const maintenance = require('./services/maintenance');
    const hlsStream = require('./services/hls-stream');
    const chunkSession = require('./services/chunk-session');
    const geoip = require('./services/geoip');
    res.json({
      ok: true,
      ...workloadGovernor.stats(),
      api_calls: rateLimit.getApiCallStats(),
      repo_cache: github.getRepoCacheStats(),
      maintenance: maintenance.getStats(),
      hls_sessions: hlsStream.getActiveSessionCount(),
      chunk_sessions: chunkSession.getSessionCount(),
      geo_cache: geoip.getCacheSize(),
    });
  } catch {
    res.json({ ok: true });
  }
});

// Dynamic share pages with Open Graph embed tags (Discord, Slack, etc.)
// Serve static assets under /share (e.g. sw.js) before dynamic routes
app.use('/share', express.static(path.join(PUBLIC_DIR, 'share'), {
  cacheControl: false,
  setHeaders: (res, filePath) => staticAssetHeaders(res, filePath, path.join(PUBLIC_DIR, 'share')),
}));
app.use('/share', sharePageRoutes);

// Serve static assets before passport so the UI shell loads even under heavy background work
app.use(express.static(PUBLIC_DIR, {
  cacheControl: false,
  etag: true,
  lastModified: true,
  setHeaders: (res, filePath) => staticAssetHeaders(res, filePath, PUBLIC_DIR),
}));

app.use(passport.initialize());
app.use(passport.session());
app.use(require('./middleware/local-auth').localAuthMiddleware);

const { trackUserActivity } = require('./middleware/activity');
app.use('/api', trackUserActivity);

app.use('/auth', authRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/playlists', requireAuth, ensureSetup, playlistRoutes);
app.use('/api/repos', repoRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/cache', cacheRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/settings', require('./routes/settings'));
app.use('/api/plex', requireAuth, ensureSetup, require('./routes/plex'));
app.use('/api/accounts', accountRoutes);
app.use('/api/viewers', viewerRoutes);
app.use('/api/bandwidth', bandwidthRoutes);
app.use('/api/network', require('./routes/network'));

app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  res.type('html');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.listen(PORT, () => {
  const configured = appUrlService.getConfiguredAppUrl();
  const listenAt = configured || `http://localhost:${PORT}`;
  console.log(`GitHub Vault running at ${listenAt}`);
  if (!configured) {
    console.warn(
      'APP_URL not set — share/link URLs use the request Host (or X-Forwarded-* behind a proxy). '
      + 'Set APP_URL to your public URL (e.g. Cloudflare tunnel) for OAuth callbacks.'
    );
  }
  try {
    const hlsConvert = require('./services/hls-convert');
    const tasks = require('./services/tasks');
    hlsConvert.resumeInterruptedConversions();
    const stale = tasks.cleanupStaleHlsConvertTasks();
    if (stale > 0) console.log(`[HLS] Marked ${stale} interrupted conversion task(s) as cancelled`);
    const seamless = require('./services/seamless-upload');
    seamless.resumePendingOnStartup();
  } catch (err) {
    console.warn('HLS recovery check skipped:', err.message);
  }

  setTimeout(() => {
    try {
      const backupSync = require('./services/backup-sync');
      const tasks = require('./services/tasks');
      const users = db.prepare(
        'SELECT DISTINCT user_id FROM linked_accounts WHERE role = ? AND is_active = 1'
      ).all('backup');
      for (const { user_id: userId } of users) {
        backupSync.dedupeAllBackupTasks(userId);
        const active = db.prepare(`
          SELECT id FROM tasks
          WHERE user_id = ? AND type = 'backup-sync' AND status = 'processing'
        `).all(userId);
        for (const row of active) {
          tasks.update(row.id, userId, {
            status: 'paused',
            phase: 'paused',
            pauseReason: 'Server restarted — will resume when idle',
            resumable: true,
          });
        }
      }
      setInterval(() => {
        try {
          for (const { user_id: userId } of users) {
            backupSync.maybeResumeSync(userId);
          }
        } catch {
          // ignore periodic resume errors
        }
      }, 2 * 60 * 1000);
    } catch (err) {
      console.warn('Backup sync startup skipped:', err.message);
    }
  }, 60000);
  if (!process.env.GITHUB_CLIENT_ID) {
    console.warn('WARNING: GITHUB_CLIENT_ID not set. Copy .env.example to .env and configure OAuth.');
  }

  try {
    const maintenance = require('./services/maintenance');
    maintenance.startMaintenance();
  } catch (err) {
    console.warn('[maintenance] startup skipped:', err.message);
  }

  try {
    const autoRepo = require('./services/auto-repo');
    autoRepo.startAutoRepoScheduler();
  } catch (err) {
    console.warn('[auto-repo] startup skipped:', err.message);
  }

  // Schedule daily audit log cleanup (runs once per 24h, first run after 1 hour)
  setTimeout(() => {
    try {
      const audit = require('./services/audit');
      audit.cleanup(90);
      console.log('[audit] Cleanup complete');
    } catch (err) {
      console.error('[audit] Cleanup failed:', err.message);
    }
    setInterval(() => {
      try {
        const audit = require('./services/audit');
        audit.cleanup(90);
      } catch (err) {
        console.error('[audit] Cleanup failed:', err.message);
      }
    }, 86400000);
  }, 3600000);
});
