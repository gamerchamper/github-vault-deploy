/**
 * Pastebin API rate limits (estimated rolling 1-hour window).
 * Pastebin does not publish official limits; these defaults are conservative.
 *
 * Account paste quotas (from Pastebin API docs):
 * - Free: max 25 unlisted pastes, max 10 private pastes per account
 * - Max paste size: ~512 KB (free), up to 10 MB (PRO) — configure via PASTEBIN_MAX_PASTE_KB
 */
const crypto = require('crypto');

const DEFAULT_LIMIT = Number(process.env.PASTEBIN_RATE_LIMIT_HOUR) || 3000;
const RAW_LIMIT = Number(process.env.PASTEBIN_RAW_RATE_LIMIT_HOUR) || 10000;
const MIN_BUFFER_MS = 1500;
const WINDOW_MS = 60 * 60 * 1000;

const blockedUntil = new Map();
const quotas = new Map();
const requestLog = new Map();
const apiCallCounts = new Map();
let attemptedCallCount = 0;
let rateLimitedCallCount = 0;

function keyForToken(token) {
  if (!token) return 'anon';
  return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16);
}

function isRateLimitError(err) {
  if (!err) return false;
  const msg = String(err.message || '').toLowerCase();
  if (/too many|rate limit|try again later|temporarily blocked/i.test(msg)) return true;
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
  const cutoff = now - WINDOW_MS;
  while (log.length && log[0] < cutoff) log.shift();

  const limit = resource === 'raw' ? RAW_LIMIT : (quotas.get(tokenKey)?.limit ?? DEFAULT_LIMIT);
  const used = log.length;
  const remaining = Math.max(0, limit - used);
  quotas.set(tokenKey, {
    limit,
    used,
    remaining,
    exhausted: remaining <= 0,
    paused: blockedUntil.get(tokenKey) > now,
    provider: 'pastebin',
    resource,
  });
  return quotas.get(tokenKey);
}

function getQuotaStatus(tokenKey) {
  const now = Date.now();
  const pausedUntil = blockedUntil.get(tokenKey) || 0;
  const limit = quotas.get(tokenKey)?.limit ?? DEFAULT_LIMIT;
  const log = requestLog.get(`${tokenKey}:api`) || [];
  const cutoff = now - WINDOW_MS;
  const used = log.filter((t) => t >= cutoff).length;
  const remaining = Math.max(0, limit - used);

  if (pausedUntil > now) {
    return {
      limit,
      used,
      remaining: 0,
      exhausted: true,
      paused: true,
      pause_seconds_left: Math.ceil((pausedUntil - now) / 1000),
      provider: 'pastebin',
      known: true,
    };
  }

  return {
    limit,
    used,
    remaining,
    exhausted: remaining <= 0,
    paused: false,
    provider: 'pastebin',
    known: true,
  };
}

function isPaused(tokenKey) {
  return (blockedUntil.get(tokenKey) || 0) > Date.now();
}

function noteHeaders() {}

function touchQuotaUpdated(tokenKey) {
  getQuotaStatus(tokenKey);
}

async function refreshQuotaIfNeeded(tokenKey) {
  touchQuotaUpdated(tokenKey);
}

function logApiCall(tokenKey, op) {
  const key = `${tokenKey}:${op}`;
  apiCallCounts.set(key, (apiCallCounts.get(key) || 0) + 1);
}

function setWaitCallback() {
  return () => {};
}

async function runWithSubsystem(_subsystem, fn) {
  return fn();
}

async function withRetry(tokenKey, fn, { failFastRateLimit = false, resource = 'api' } = {}) {
  attemptedCallCount += 1;
  try {
    const result = await fn();
    recordRequest(tokenKey, { resource });
    return result;
  } catch (err) {
    if (isRateLimitError(err)) {
      rateLimitedCallCount += 1;
      blockedUntil.set(tokenKey, Date.now() + 60 * 1000);
      if (failFastRateLimit) {
        err.isRateLimitFailFast = true;
      }
    }
    throw err;
  }
}

function getRecommendedConcurrency(tokenKey, defaultVal = 4) {
  const q = getQuotaStatus(tokenKey);
  if (q.paused || q.exhausted) return 1;
  if (q.remaining < 400) return 2;
  if (q.remaining < 1000) return 3;
  return defaultVal;
}

module.exports = {
  PROVIDER: 'pastebin',
  DEFAULT_LIMIT,
  RAW_LIMIT,
  keyForToken,
  isRateLimitError,
  recordRequest,
  getQuotaStatus,
  isPaused,
  noteHeaders,
  touchQuotaUpdated,
  refreshQuotaIfNeeded,
  logApiCall,
  setWaitCallback,
  runWithSubsystem,
  withRetry,
  getRecommendedConcurrency,
};
