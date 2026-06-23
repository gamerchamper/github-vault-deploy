/**
 * Codeberg (Forgejo/Gitea) API rate limits.
 * @see https://codeberg.org/api/swagger
 * @see https://codeberg.org/Codeberg/Community/issues/2721 (limits not fully documented)
 *
 * Forgejo exposes X-RateLimit-Limit / X-RateLimit-Remaining / X-RateLimit-Reset on API responses.
 * Default Gitea/Forgejo installs often use ~60 authenticated requests/minute; Codeberg may tune this.
 * We track a rolling minute window from headers + local counts, with conservative defaults.
 */
const crypto = require('crypto');

const DEFAULT_LIMIT_MINUTE = Number(process.env.CODEBERG_RATE_LIMIT_MINUTE) || 60;
const DEFAULT_LIMIT_HOUR = Number(process.env.CODEBERG_RATE_LIMIT_HOUR) || DEFAULT_LIMIT_MINUTE * 60;
const RAW_LIMIT = Number(process.env.CODEBERG_RAW_RATE_LIMIT_HOUR) || DEFAULT_LIMIT_HOUR;
const MIN_BUFFER_MS = 1500;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const blockedUntil = new Map();
const quotas = new Map();
const requestLog = new Map();
const apiCallCounts = new Map();
let attemptedCallCount = 0;
let rateLimitedCallCount = 0;

function keyForToken(token) {
  if (!token) return 'anon';
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
}

function isRateLimitError(err) {
  if (!err) return false;
  const status = err.status || err.response?.status;
  if (status === 429) return true;
  const msg = (err.message || err.response?.data?.message || '').toLowerCase();
  if (status === 403 && /rate limit|too many requests/i.test(msg)) return true;
  return false;
}

function recordRequest(tokenKey, { resource = 'api' } = {}) {
  const now = Date.now();
  const logKey = `${tokenKey}:${resource}`;
  let log = requestLog.get(logKey);
  if (!log) {
    log = [];
    requestLog.set(logKey, log);
  }
  log.push(now);
  const windowMs = resource === 'raw' ? HOUR_MS : MINUTE_MS;
  const cutoff = now - windowMs;
  while (log.length && log[0] < cutoff) log.shift();

  const limit = resource === 'raw'
    ? RAW_LIMIT
    : (quotas.get(tokenKey)?.limit ?? DEFAULT_LIMIT_MINUTE);
  const used = log.length;
  const remaining = Math.max(0, limit - used);
  quotas.set(tokenKey, {
    remaining,
    limit,
    reset: Math.floor((now + windowMs) / 1000),
    updatedAt: now,
    resource,
  });
  return { remaining, limit, used };
}

function noteHeaders(tokenKey, headers = {}, { resource = 'api' } = {}) {
  const limitHeader = headers['x-ratelimit-limit'] ?? headers['X-RateLimit-Limit'];
  const remainingHeader = headers['x-ratelimit-remaining'] ?? headers['X-RateLimit-Remaining'];
  const resetHeader = headers['x-ratelimit-reset'] ?? headers['X-RateLimit-Reset'];

  if (limitHeader != null || remainingHeader != null) {
    const limit = limitHeader != null ? parseInt(limitHeader, 10) : DEFAULT_LIMIT_MINUTE;
    const remaining = remainingHeader != null ? parseInt(remainingHeader, 10) : null;
    const reset = resetHeader != null ? parseInt(resetHeader, 10) : Math.floor((Date.now() + MINUTE_MS) / 1000);
    quotas.set(tokenKey, {
      remaining: Number.isFinite(remaining) ? remaining : (quotas.get(tokenKey)?.remaining ?? limit),
      limit: Number.isFinite(limit) ? limit : DEFAULT_LIMIT_MINUTE,
      reset,
      updatedAt: Date.now(),
      resource,
    });
  }
  recordRequest(tokenKey, { resource });
}

function blockUntil(tokenKey) {
  const until = Date.now() + MINUTE_MS + MIN_BUFFER_MS;
  const prev = blockedUntil.get(tokenKey) || 0;
  blockedUntil.set(tokenKey, Math.max(prev, until));
  return blockedUntil.get(tokenKey);
}

function getQuotaStatus(tokenKey) {
  const quota = quotas.get(tokenKey);
  const pause = getPauseInfo(tokenKey);
  const limit = quota?.limit ?? DEFAULT_LIMIT_MINUTE;
  let remaining = quota?.remaining;
  if (remaining == null) {
    const log = requestLog.get(`${tokenKey}:api`) || [];
    const cutoff = Date.now() - MINUTE_MS;
    const used = log.filter((t) => t >= cutoff).length;
    remaining = Math.max(0, limit - used);
  }
  const used = Math.max(0, limit - remaining);
  const percentUsed = limit > 0 ? Math.round((used / limit) * 1000) / 10 : null;
  const reset = quota?.reset ?? Math.floor((Date.now() + MINUTE_MS) / 1000);
  const nowSec = Math.floor(Date.now() / 1000);
  const exhausted = remaining === 0 && reset > nowSec;

  return {
    limit,
    limit_hour_estimate: DEFAULT_LIMIT_HOUR,
    remaining,
    used,
    percent_used: percentUsed,
    reset_at: new Date(reset * 1000).toISOString(),
    reset_in_seconds: Math.max(0, reset - nowSec),
    paused: !!pause || exhausted,
    pause_seconds_left: pause?.seconds_left ?? (exhausted ? reset - nowSec : null),
    exhausted: !!exhausted,
    recommended_concurrency: getRecommendedConcurrency(tokenKey),
    known: remaining != null,
    updated_at: quota?.updatedAt ? new Date(quota.updatedAt).toISOString() : null,
    provider: 'codeberg',
    window: 'minute',
  };
}

function getPauseInfo(tokenKey) {
  const until = blockedUntil.get(tokenKey);
  if (!until || Date.now() >= until) return null;
  return {
    until,
    seconds_left: Math.ceil((until - Date.now()) / 1000),
  };
}

function isPaused(tokenKey) {
  return !!getPauseInfo(tokenKey);
}

function getRecommendedConcurrency(tokenKey, defaultConcurrency = 6) {
  const pause = getPauseInfo(tokenKey);
  if (pause) return 1;
  const quota = quotas.get(tokenKey);
  const remaining = quota?.remaining ?? DEFAULT_LIMIT_MINUTE;
  if (remaining <= 0) return 1;
  if (remaining < 5) return 1;
  if (remaining < 15) return 2;
  if (remaining < 30) return 4;
  if (remaining < 45) return 5;
  return defaultConcurrency;
}

function isQuotaStale() {
  return false;
}

async function refreshQuotaIfNeeded(tokenKey) {
  return getQuotaStatus(tokenKey);
}

function touchQuotaUpdated(tokenKey) {
  const prev = quotas.get(tokenKey) || {};
  quotas.set(tokenKey, { ...prev, updatedAt: Date.now() });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitIfNeeded(tokenKey) {
  const until = blockedUntil.get(tokenKey);
  if (!until || Date.now() >= until) return;
  await sleep(until - Date.now());
}

async function withRetry(tokenKey, fn, opts = {}) {
  attemptedCallCount++;
  const workloadGovernor = require('./workload-governor');
  const slot = await workloadGovernor.acquireGitHubOp();
  try {
    while (true) {
      await waitIfNeeded(tokenKey);
      const status = getQuotaStatus(tokenKey);
      if (status.remaining <= 0 && !opts.skipQuotaCheck) {
        if (opts.failFastRateLimit) {
          const failErr = new Error('Codeberg rate limit exceeded');
          failErr.isRateLimitFailFast = true;
          failErr.status = 429;
          throw failErr;
        }
        await sleep(Math.min(MINUTE_MS, 30 * 1000));
        continue;
      }
      try {
        const result = await fn();
        recordRequest(tokenKey, { resource: opts.resource || 'api' });
        return result;
      } catch (err) {
        if (!isRateLimitError(err)) throw err;
        rateLimitedCallCount++;
        blockUntil(tokenKey);
        if (opts.failFastRateLimit) {
          const failErr = new Error(err.message || 'Codeberg rate limit exceeded');
          failErr.isRateLimitFailFast = true;
          failErr.status = err.status || 429;
          failErr.response = err.response;
          throw failErr;
        }
        console.warn(`[Codeberg rate limit] token ${tokenKey} — pausing 45s`);
        await sleep(45 * 1000);
      }
    }
  } finally {
    slot.release();
  }
}

function logApiCall(tokenKey, operation) {
  apiCallCounts.set(operation, (apiCallCounts.get(operation) || 0) + 1);
}

function getApiCallStats() {
  const ops = [...apiCallCounts.entries()]
    .map(([operation, count]) => ({ operation, count }))
    .sort((a, b) => b.count - a.count);
  const total = ops.reduce((a, b) => a + b.count, 0);
  return {
    total,
    attempted: attemptedCallCount,
    rate_limited: rateLimitedCallCount,
    operations: ops.slice(0, 30),
    provider: 'codeberg',
  };
}

function resetApiCallStats() {
  apiCallCounts.clear();
  attemptedCallCount = 0;
  rateLimitedCallCount = 0;
}

async function runWithSubsystem(subsystem, fn) {
  return fn();
}

function setWaitCallback() {
  return () => {};
}

function clearWaitCallbacks() {}

function notifyWait() {}

module.exports = {
  PROVIDER: 'codeberg',
  DEFAULT_LIMIT: DEFAULT_LIMIT_HOUR,
  DEFAULT_LIMIT_MINUTE,
  RAW_LIMIT,
  keyForToken,
  isRateLimitError,
  blockUntil,
  noteHeaders,
  getQuotaStatus,
  isQuotaStale,
  getPauseInfo,
  isPaused,
  getRecommendedConcurrency,
  withRetry,
  refreshQuotaIfNeeded,
  touchQuotaUpdated,
  logApiCall,
  getApiCallStats,
  resetApiCallStats,
  runWithSubsystem,
  recordRequest,
  setWaitCallback,
  clearWaitCallbacks,
};
