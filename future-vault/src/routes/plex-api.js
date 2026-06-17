const express = require('express');
const vaultUpstream = require('../services/vault-upstream');
const store = require('../services/store');

function authMiddleware(getConfig) {
  return (req, res, next) => {
    const config = getConfig();
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token || token !== config.api_key) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };
}

function createPlexApiRouter(getConfig) {
  const router = express.Router();
  router.use(authMiddleware(getConfig));

  router.get('/hub', async (req, res) => {
    const config = getConfig();
    const result = await vaultUpstream.pullEndpoint(config, 'hub', '/hub');
    if (!result.ok) return res.status(503).json({ error: result.error, offline: true });
    res.json({ ...result.data, _source: result.source, _stale: !!result.stale });
  });

  router.get('/playlists', async (req, res) => {
    const config = getConfig();
    const result = await vaultUpstream.pullEndpoint(config, 'playlists', '/playlists');
    if (!result.ok) return res.status(503).json({ error: result.error, offline: true });
    res.json({ ...result.data, _source: result.source, _stale: !!result.stale });
  });

  router.get('/playlists/:id', async (req, res) => {
    const config = getConfig();
    const cacheName = `playlist_${req.params.id}`;
    const result = await vaultUpstream.pullEndpoint(config, cacheName, `/playlists/${req.params.id}`);
    if (!result.ok) return res.status(503).json({ error: result.error, offline: true });
    res.json({ ...result.data, _source: result.source, _stale: !!result.stale });
  });

  router.get('/collections', async (req, res) => {
    const config = getConfig();
    const result = await vaultUpstream.pullEndpoint(config, 'collections', '/collections');
    if (!result.ok) return res.status(503).json({ error: result.error, offline: true });
    res.json({ ...result.data, _source: result.source, _stale: !!result.stale });
  });

  router.get('/collections/:id', async (req, res) => {
    const config = getConfig();
    const cacheName = `collection_${req.params.id}`;
    const result = await vaultUpstream.pullEndpoint(config, cacheName, `/collections/${req.params.id}`);
    if (!result.ok) return res.status(503).json({ error: result.error, offline: true });
    res.json({ ...result.data, _source: result.source, _stale: !!result.stale });
  });

  router.get('/continue', async (req, res) => {
    const config = getConfig();
    const limit = Math.min(50, parseInt(req.query.limit, 10) || 20);
    const result = await vaultUpstream.pullEndpoint(config, 'continue', `/continue?limit=${limit}`);
    if (!result.ok) return res.status(503).json({ error: result.error, offline: true });
    res.json({ ...result.data, _source: result.source, _stale: !!result.stale });
  });

  router.get('/status', (req, res) => {
    const config = getConfig();
    res.json({
      agent: 'future-vault',
      version: '1.0.0',
      agent_url: config.agent_url,
      vault_url: config.vault_url || null,
      vault_online: store.readStatus(config).vault_online,
      cached_at: store.readCache(config, 'hub')?._cached_at || null,
    });
  });

  return router;
}

module.exports = { createPlexApiRouter, authMiddleware };
