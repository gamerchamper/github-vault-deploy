const siteAccess = require('../services/site-access');

function requireSiteAccess(req, res, next) {
  if (!siteAccess.isRequired() || siteAccess.isGranted(req)) {
    return next();
  }
  const wantsJson = req.xhr
    || (req.get('accept') || '').includes('application/json')
    || req.path.startsWith('/api/')
    || req.path.startsWith('/share/');
  return siteAccess.denyResponse(res, wantsJson);
}

module.exports = { requireSiteAccess };
