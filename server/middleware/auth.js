const apiKeys = require('../services/api-keys');

function requireAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return next();
  }
  const apiKeyUser = apiKeys.authenticateKey(apiKeys.extractKey(req));
  if (apiKeyUser) {
    req.user = apiKeyUser;
    req.authType = 'api-key';
    return next();
  }
  res.status(401).json({ error: 'Not authenticated' });
}

module.exports = { requireAuth };
