const localAuth = require('../services/local-auth');

function localAuthMiddleware(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  if (localAuth.shouldSkipPath(req)) return next();
  if (!localAuth.isEnabled()) return next();
  if (!localAuth.isLocalHostRequest(req)) return next();

  const user = localAuth.getPrimaryUser();
  if (!user) return next();

  req.logIn(user, (err) => {
    if (err) {
      console.warn('[local-auth] Auto-login failed:', err.message);
      return next();
    }

    req.authType = 'local';

    if (req.session && !req.session.localAuthLogged) {
      req.session.localAuthLogged = true;
      try {
        const audit = require('../services/audit');
        audit.log(user.id, 'login', {
          targetName: user.username,
          ip: req.ip,
          method: 'local',
        });
      } catch {
        /* ignore audit failures */
      }
    }

    next();
  });
}

module.exports = { localAuthMiddleware };
