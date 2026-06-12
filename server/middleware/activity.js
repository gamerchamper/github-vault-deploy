const workloadGovernor = require('../services/workload-governor');

const PASSIVE_PREFIXES = [
  '/api/tasks',
  '/api/accounts/backup-status',
  '/api/accounts/views',
  '/api/accounts/rate-limits',
];

function isPassiveRequest(req) {
  const path = (req.originalUrl || req.url || '').split('?')[0];
  return PASSIVE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function trackUserActivity(req, res, next) {
  const userId = req.user?.id || null;
  if (userId && !isPassiveRequest(req)) {
    workloadGovernor.noteInteractiveActivity(userId);
  }

  return workloadGovernor.runWithContext(
    { tier: 'interactive', userId },
    () => next()
  );
}

module.exports = { trackUserActivity };
