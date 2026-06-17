const store = require('./store');

async function fetchJson(url, apiKey, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

function vaultConfigured(config) {
  return Boolean(String(config.vault_url || '').trim() && String(config.vault_api_key || '').trim());
}

async function pingVault(config) {
  if (!vaultConfigured(config)) {
    return { ok: false, online: false, reason: 'not_configured' };
  }
  const base = String(config.vault_url).replace(/\/+$/, '');
  try {
    await fetchJson(`${base}/api/plex/hub`, config.vault_api_key, 12000);
    store.patchStatus(config, { vault_online: true, vault_checked_at: new Date().toISOString() });
    return { ok: true, online: true };
  } catch (err) {
    store.patchStatus(config, { vault_online: false, vault_checked_at: new Date().toISOString() });
    return { ok: false, online: false, error: err.message };
  }
}

async function pullEndpoint(config, name, apiPath) {
  const cached = store.readCache(config, name);
  if (!vaultConfigured(config)) {
    if (cached) return { ok: true, source: 'cache', data: cached, stale: true };
    return { ok: false, error: 'Vault not configured and no cache' };
  }

  const base = String(config.vault_url).replace(/\/+$/, '');
  try {
    const data = await fetchJson(`${base}/api/plex${apiPath}`, config.vault_api_key);
    store.writeCache(config, name, data);
    store.patchStatus(config, { vault_online: true });
    return { ok: true, source: 'vault', data };
  } catch (err) {
    if (cached) {
      store.appendEvent(config, 'warn', `Vault offline — serving cached ${name}`, { error: err.message });
      return { ok: true, source: 'cache', data: cached, stale: true, error: err.message };
    }
    store.patchStatus(config, { vault_online: false });
    return { ok: false, error: err.message };
  }
}

async function fetchManifest(config) {
  if (!vaultConfigured(config)) {
    const cached = store.readCache(config, 'manifest');
    if (cached?.manifest) return { ok: true, source: 'cache', manifest: cached.manifest, stats: cached.stats, stale: true };
    return { ok: false, error: 'Vault not configured' };
  }

  const base = String(config.vault_url).replace(/\/+$/, '');
  try {
    const payload = await fetchJson(`${base}/api/plex/manifest`, config.vault_api_key, 120000);
    store.writeCache(config, 'manifest', payload);
    store.patchStatus(config, { vault_online: true });
    return {
      ok: true,
      source: 'vault',
      manifest: payload.manifest,
      stats: payload.stats,
    };
  } catch (err) {
    const cached = store.readCache(config, 'manifest');
    if (cached?.manifest) {
      store.appendEvent(config, 'warn', 'Manifest sync used cache — vault unreachable', { error: err.message });
      return {
        ok: true,
        source: 'cache',
        manifest: cached.manifest,
        stats: cached.stats,
        stale: true,
        error: err.message,
      };
    }
    return { ok: false, error: err.message };
  }
}

module.exports = {
  vaultConfigured,
  pingVault,
  pullEndpoint,
  fetchManifest,
};
