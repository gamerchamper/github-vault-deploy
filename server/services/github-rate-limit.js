const crypto = require('crypto');

const blockedUntil = new Map();
const quotas = new Map();
/** @type {Map<string, Set<Function>>} */
const waitCallbacks = new Map();
/** @type {Map<string, Promise<void>>} */
const refreshInFlight = new Map();
const refreshFailedAt = new Map();
const apiCallCounts = new Map(); // op -> count
const subsystemCounts = new Map(); // subsystem -> count
const apiCallTimestamps = [];
let attemptedCallCount = 0;
let rateLimitedCallCount = 0;
let activeSubsystem = 'api';

const MIN_BUFFER_MS = 2000;
const QUOTA_STALE_MS = 300000; // 5 minutes between rate-limit refreshes
const REFRESH_FAIL_BACKOFF_MS = 300000;

function keyForToken(token) {
  if (!token) return 'anon';
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 16);
}

function isRateLimitError(err) {
  if (!err) return false;
  const status = err.status || err.response?.status;
  const msg = (err.response?.data?.message || err.message || '').toLowerCase();
  if (status === 429) return true;
  if (status === 403 && /rate limit|secondary rate|abuse detection/i.test(msg)) return true;
  return false;
}

function resetAtFromError(err) {
  const headers = err.response?.headers || {};
  const retryAfter = headers['retry-after'] || headers['Retry-After'];
  if (retryAfter) {
    const sec = parseInt(retryAfter, 10);
    if (Number.isFinite(sec)) return Date.now() + sec * 1000 + MIN_BUFFER_MS;
  }
  const reset = headers['x-ratelimit-reset'] || headers['X-RateLimit-Reset'];
  if (reset) {
    const ts = parseInt(reset, 10);
    if (Number.isFinite(ts)) return ts * 1000 + MIN_BUFFER_MS;
  }
  return Date.now() + 60 * 1000;
}

function blockUntil(tokenKey, err) {
  const until = resetAtFromError(err);
  const prev = blockedUntil.get(tokenKey) || 0;
  const next = Math.max(prev, until);
  blockedUntil.set(tokenKey, next);
  return next;
}

function noteHeaders(tokenKey, headers = {}) {
  const remaining = headers['x-ratelimit-remaining'] ?? headers['X-RateLimit-Remaining'];
  const reset = headers['x-ratelimit-reset'] ?? headers['X-RateLimit-Reset'];
  const limit = headers['x-ratelimit-limit'] ?? headers['X-RateLimit-Limit'];
  if (remaining == null) return;
  const prev = quotas.get(tokenKey) || {};
  quotas.set(tokenKey, {
    remaining: parseInt(remaining, 10),
    limit: limit ? parseInt(limit, 10) : (prev.limit ?? 5000),
    reset: reset ? parseInt(reset, 10) : (prev.reset ?? null),
    updatedAt: Date.now(),
  });
}

function setQuotaFromCore(tokenKey, core) {
  if (!core) return;
  quotas.set(tokenKey, {
    remaining: core.remaining,
    limit: core.limit ?? 5000,
    reset: core.reset ?? null,
    updatedAt: Date.now(),
  });
}

function getQuotaStatus(tokenKey) {
  const quota = quotas.get(tokenKey);
  const pause = getPauseInfo(tokenKey);
  const limit = quota?.limit ?? 5000;
  const remaining = quota?.remaining ?? null;
  const used = remaining != null ? Math.max(0, limit - remaining) : null;
  const percentUsed = used != null && limit > 0
    ? Math.round((used / limit) * 1000) / 10
    : null;
  const reset = quota?.reset ?? null;
  const nowSec = Math.floor(Date.now() / 1000);
  const exhausted = remaining === 0 && reset != null && reset > nowSec;

  return {
    limit,
    remaining,
    used,
    percent_used: percentUsed,
    reset_at: reset ? new Date(reset * 1000).toISOString() : null,
    reset_in_seconds: reset ? Math.max(0, reset - nowSec) : null,
    paused: !!pause || exhausted,
    pause_seconds_left: pause?.seconds_left ?? (exhausted ? reset - nowSec : null),
    exhausted: !!exhausted,
    recommended_concurrency: getRecommendedConcurrency(tokenKey),
    known: remaining != null,
    updated_at: quota?.updatedAt ? new Date(quota.updatedAt).toISOString() : null,
  };
}

function isQuotaStale(tokenKey, maxAgeMs = QUOTA_STALE_MS) {
  const quota = quotas.get(tokenKey);
  if (!quota?.updatedAt) return true;
  return Date.now() - quota.updatedAt > maxAgeMs;
}

function touchQuotaUpdated(tokenKey) {
  const prev = quotas.get(tokenKey) || {};
  quotas.set(tokenKey, { ...prev, updatedAt: Date.now() });
}

async function refreshQuotaIfNeeded(tokenKey, accessToken) {
  if (!accessToken) return getQuotaStatus(tokenKey);

  const failedAt = refreshFailedAt.get(tokenKey);
  if (failedAt && Date.now() - failedAt < REFRESH_FAIL_BACKOFF_MS) {
    return getQuotaStatus(tokenKey);
  }

  if (!isQuotaStale(tokenKey)) {
    return getQuotaStatus(tokenKey);
  }

  const inFlight = refreshInFlight.get(tokenKey);
  if (inFlight) {
    await inFlight.catch(() => {});
    return getQuotaStatus(tokenKey);
  }

  const github = require('./github');
  const job = github.fetchCoreRateLimit(accessToken)
    .then(() => {
      refreshFailedAt.delete(tokenKey);
    })
    .catch(() => {
      refreshFailedAt.set(tokenKey, Date.now());
      touchQuotaUpdated(tokenKey);
    })
    .finally(() => {
      refreshInFlight.delete(tokenKey);
    });

  refreshInFlight.set(tokenKey, job);
  await job;
  return getQuotaStatus(tokenKey);
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

function getRecommendedConcurrency(tokenKey, defaultConcurrency = 16) {
  const pause = getPauseInfo(tokenKey);
  if (pause) return 1;
  const quota = quotas.get(tokenKey);
  if (!quota) return defaultConcurrency;
  if (quota.remaining <= 0) return 1;
  if (quota.remaining < 50) return 2;
  if (quota.remaining < 150) return 4;
  if (quota.remaining < 400) return 8;
  if (quota.remaining < 1000) return 12;
  return defaultConcurrency;
}

function setWaitCallback(tokenKey, fn) {
  if (!fn) return () => {};
  if (!waitCallbacks.has(tokenKey)) waitCallbacks.set(tokenKey, new Set());
  waitCallbacks.get(tokenKey).add(fn);
  return () => waitCallbacks.get(tokenKey)?.delete(fn);
}

function clearWaitCallbacks(tokenKey) {
  waitCallbacks.delete(tokenKey);
}

function notifyWait(tokenKey, info) {
  const cbs = waitCallbacks.get(tokenKey);
  if (!cbs) return;
  for (const cb of cbs) cb(info);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitIfNeeded(tokenKey) {
  const until = blockedUntil.get(tokenKey);
  if (!until || Date.now() >= until) return;
  const waitMs = until - Date.now();
  notifyWait(tokenKey, { until, waitMs, message: 'Waiting for GitHub rate limit reset' });
  await sleep(waitMs);
}

async function withRetry(tokenKey, fn, opts = {}) {
  attemptedCallCount++;
  const workloadGovernor = require('./workload-governor');
  const slot = await workloadGovernor.acquireGitHubOp();
  try {
    while (true) {
      await waitIfNeeded(tokenKey);
      try {
        return await fn();
      } catch (err) {
        if (!isRateLimitError(err)) throw err;
        rateLimitedCallCount++;
        const until = blockUntil(tokenKey, err);
        const waitMs = Math.max(0, until - Date.now());
        notifyWait(tokenKey, {
          until,
          waitMs,
          message: err.response?.data?.message || err.message,
        });
        if (opts.failFastRateLimit) {
          const failErr = new Error(err.response?.data?.message || err.message || 'GitHub rate limit exceeded');
          failErr.isRateLimitFailFast = true;
          failErr.status = err.status;
          failErr.response = err.response;
          throw failErr;
        }
        console.warn(
          `[GitHub rate limit] token ${tokenKey} — pausing ${Math.ceil(waitMs / 1000)}s`
        );
        await sleep(waitMs);
      }
    }
  } finally {
    slot.release();
  }
}

function setCallSubsystem(subsystem) {
  activeSubsystem = subsystem || 'api';
}

function clearCallSubsystem() {
  activeSubsystem = 'api';
}

async function runWithSubsystem(subsystem, fn) {
  const prev = activeSubsystem;
  activeSubsystem = subsystem || 'api';
  try {
    return await fn();
  } finally {
    activeSubsystem = prev;
  }
}

function logApiCall(tokenKey, operation) {
  const now = Date.now();
  apiCallCounts.set(operation, (apiCallCounts.get(operation) || 0) + 1);
  subsystemCounts.set(activeSubsystem, (subsystemCounts.get(activeSubsystem) || 0) + 1);
  apiCallTimestamps.push({ t: now, op: operation, token: tokenKey, subsystem: activeSubsystem });
  while (apiCallTimestamps.length > 1000) apiCallTimestamps.shift();
}

function getApiCallStats() {
  const ops = [...apiCallCounts.entries()]
    .map(([op, count]) => ({ operation: op, count }))
    .sort((a, b) => b.count - a.count);
  const subsystems = [...subsystemCounts.entries()]
    .map(([name, count]) => ({ subsystem: name, count }))
    .sort((a, b) => b.count - a.count);
  const total = apiCallCounts.size > 0
    ? [...apiCallCounts.values()].reduce((a, b) => a + b, 0)
    : 0;
  const oneMinuteAgo = Date.now() - 60000;
  const recentEntries = apiCallTimestamps.filter((e) => e.t > oneMinuteAgo);
  const recent = recentEntries.length;
  const requestsPerMinute = recent;
  const recentBySubsystem = {};
  for (const e of recentEntries) {
    recentBySubsystem[e.subsystem] = (recentBySubsystem[e.subsystem] || 0) + 1;
  }
  let chunkLookup = null;
  try {
    chunkLookup = require('./chunk-lookup-cache').getCacheStats();
  } catch { /* optional */ }
  return {
    total,
    recent,
    requests_per_minute: requestsPerMinute,
    attempted: attemptedCallCount,
    rate_limited: rateLimitedCallCount,
    operations: ops.slice(0, 30),
    subsystems,
    recent_by_subsystem: recentBySubsystem,
    chunk_lookup_cache: chunkLookup,
  };
}

function resetApiCallStats() {
  apiCallCounts.clear();
  subsystemCounts.clear();
  apiCallTimestamps.length = 0;
  attemptedCallCount = 0;
  rateLimitedCallCount = 0;
}

module.exports = {
  keyForToken,
  isRateLimitError,
  blockUntil,
  noteHeaders,
  setQuotaFromCore,
  getQuotaStatus,
  isQuotaStale,
  getPauseInfo,
  isPaused,
  getRecommendedConcurrency,
  setWaitCallback,
  clearWaitCallbacks,
  withRetry,
  refreshQuotaIfNeeded,
  touchQuotaUpdated,
  logApiCall,
  getApiCallStats,
  resetApiCallStats,
  setCallSubsystem,
  clearCallSubsystem,
  runWithSubsystem,
  QUOTA_STALE_MS,
};
