const fs = require('fs');
const path = require('path');

function cachePath(config, name) {
  return path.join(config.cache_dir, `${name}.json`);
}

function readCache(config, name, fallback = null) {
  const file = cachePath(config, name);
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeCache(config, name, data) {
  const payload = {
    ...data,
    _cached_at: new Date().toISOString(),
  };
  fs.writeFileSync(cachePath(config, name), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
}

function readStatus(config) {
  return readCache(config, 'status', {
    vault_online: null,
    last_sync_at: null,
    last_sync_error: null,
    last_repair_at: null,
    last_repair_ready: null,
    plex_running: null,
    plex_last_restart_at: null,
    plugin_ok: null,
    events: [],
  });
}

function appendEvent(config, level, message, meta = null) {
  const status = readStatus(config);
  const event = {
    at: new Date().toISOString(),
    level,
    message,
    meta,
  };
  status.events = [event, ...(status.events || [])].slice(0, 200);
  writeCache(config, 'status', status);
  return event;
}

function patchStatus(config, patch) {
  const status = { ...readStatus(config), ...patch };
  writeCache(config, 'status', status);
  return status;
}

module.exports = {
  readCache,
  writeCache,
  readStatus,
  appendEvent,
  patchStatus,
};
