/**
 * Optional Redis backing for chunk 404 cache (multi-instance).
 * Enable with REDIS_URL. Requires: npm install ioredis
 */
const PREFIX = 'vault:404:';
const TTL_SEC = 30 * 60;

let client = null;
let initAttempted = false;

function getClient() {
  if (initAttempted) return client;
  initAttempted = true;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    const Redis = require('ioredis');
    client = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: true });
    client.connect().catch(() => { client = null; });
  } catch {
    client = null;
  }
  return client;
}

async function getMissing(key) {
  const redis = getClient();
  if (!redis) return null;
  try {
    const val = await redis.get(PREFIX + key);
    if (!val) return null;
    const parsed = JSON.parse(val);
    if (parsed.until && Date.now() > parsed.until) {
      await redis.del(PREFIX + key);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function setMissing(key, entry) {
  const redis = getClient();
  if (!redis) return;
  try {
    const ttl = entry.confirmed ? 86400 : TTL_SEC;
    await redis.set(PREFIX + key, JSON.stringify(entry), 'EX', ttl);
  } catch { /* ignore */ }
}

async function clearMissing(key) {
  const redis = getClient();
  if (!redis) return;
  try { await redis.del(PREFIX + key); } catch { /* ignore */ }
}

function isEnabled() {
  return !!getClient();
}

module.exports = { getMissing, setMissing, clearMissing, isEnabled };
