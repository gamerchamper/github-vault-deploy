const path = require('path');
const fs = require('fs');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.vault-upload');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const SESSION_DIR = path.join(CONFIG_DIR, 'sessions');

function ensureDirs() {
  for (const d of [CONFIG_DIR, SESSION_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function load() {
  ensureDirs();
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch {}
  return {};
}

function save(config) {
  ensureDirs();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

const MAX_SERVER_HISTORY = 20;

function normalizeServerUrl(url) {
  return String(url || '').replace(/\/+$/, '');
}

function serverEntryId(serverUrl, apiKey, cookie) {
  const url = normalizeServerUrl(serverUrl);
  const key = String(apiKey || '');
  const sid = String(cookie || '');
  return `${url}|${key}|${sid}`;
}

function serverLabel(serverUrl) {
  const url = normalizeServerUrl(serverUrl);
  if (!url) return 'Server';
  try {
    const parsed = new URL(url);
    return parsed.host + (parsed.port && !['80', '443'].includes(parsed.port) ? `:${parsed.port}` : '');
  } catch {
    return url.replace(/^https?:\/\//, '');
  }
}

function addToServerHistory(config, opts = {}) {
  const serverUrl = normalizeServerUrl(config.serverUrl);
  if (!serverUrl) return Array.isArray(config.serverHistory) ? config.serverHistory : [];

  const apiKey = config.apiKey || '';
  const cookie = config.cookie || '';
  const id = opts.id || serverEntryId(serverUrl, apiKey, cookie);
  const label = opts.label || serverLabel(serverUrl);
  const history = Array.isArray(config.serverHistory) ? config.serverHistory.filter((h) => h.id !== id) : [];
  history.unshift({
    id,
    label,
    serverUrl,
    apiKey,
    cookie,
    lastUsed: Date.now(),
  });
  return history.slice(0, MAX_SERVER_HISTORY);
}

function findServerEntry(config, id) {
  return (config.serverHistory || []).find((h) => h.id === id) || null;
}

function touchServerHistory(config, id) {
  if (!id || !Array.isArray(config.serverHistory)) return config.serverHistory || [];
  const idx = config.serverHistory.findIndex((h) => h.id === id);
  if (idx < 0) return config.serverHistory;
  const next = config.serverHistory.slice();
  const [entry] = next.splice(idx, 1);
  entry.lastUsed = Date.now();
  next.unshift(entry);
  return next;
}

function removeFromServerHistory(config, id) {
  return (config.serverHistory || []).filter((h) => h.id !== id);
}

function activeServerId(config) {
  if (!config.serverUrl) return '';
  return serverEntryId(config.serverUrl, config.apiKey, config.cookie);
}

function safeServerHistory(config, includeSecrets = false) {
  return (config.serverHistory || []).map((entry) => {
    const safe = {
      id: entry.id,
      label: entry.label || serverLabel(entry.serverUrl),
      serverUrl: entry.serverUrl,
      lastUsed: entry.lastUsed || 0,
      hasApiKey: !!entry.apiKey,
      hasCookie: !!entry.cookie,
      apiKeyPreview: entry.apiKey ? `${entry.apiKey.slice(0, 12)}...` : '',
      cookiePreview: entry.cookie ? `${entry.cookie.slice(0, 18)}...` : '',
    };
    if (includeSecrets) {
      safe.apiKey = entry.apiKey || '';
      safe.cookie = entry.cookie || '';
    }
    return safe;
  });
}

module.exports = {
  CONFIG_DIR,
  SESSION_DIR,
  load,
  save,
  ensureDirs,
  MAX_SERVER_HISTORY,
  normalizeServerUrl,
  serverEntryId,
  serverLabel,
  addToServerHistory,
  findServerEntry,
  touchServerHistory,
  removeFromServerHistory,
  activeServerId,
  safeServerHistory,
};
