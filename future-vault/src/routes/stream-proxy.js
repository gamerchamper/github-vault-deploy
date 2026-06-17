const express = require('express');
const streamProxy = require('../services/stream-proxy');
const store = require('../services/store');

function loadHlsMeta(config) {
  try {
    const fs = require('fs');
    const path = require('path');
    const metaPath = path.join(config.plex_library_path || '', '.vault-hls-meta.json');
    if (fs.existsSync(metaPath)) {
      return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    }
  } catch {
    // ignore
  }
  return {};
}

function getVaultConfig(config) {
  if (!config.vault_url || !config.vault_api_key) return null;
  return { vault_url: String(config.vault_url).replace(/\/+$/, ''), vault_api_key: String(config.vault_api_key) };
}

function createStreamProxyRouter(getConfig) {
  const router = express.Router();

  router.get('/api/m3u8/:fileId', async (req, res) => {
    try {
      const config = getConfig();
      const fileId = req.params.fileId;
      const hlsMeta = loadHlsMeta(config);
      const meta = hlsMeta[fileId] || {};
      const vaultConfig = getVaultConfig(config);

      const result = await streamProxy.serveHlsPlaylist(fileId, vaultConfig, {
        hlsRawUrl: meta.hls_raw_url || null,
      });

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.setHeader('X-HLS-Source', result.from);
      res.end(result.content);
    } catch (err) {
      res.status(502).json({ error: 'HLS playlist unavailable', detail: err.message });
    }
  });

  router.get('/api/stream/:fileId/:fileName', (req, res) => {
    const config = getConfig();
    const vaultConfig = getVaultConfig(config);

    if (!vaultConfig) {
      return res.status(502).json({ error: 'Vault not configured' });
    }

    const { fileId, fileName } = req.params;
    const targetUrl = `${vaultConfig.vault_url}/api/files/stream/${fileId}/${encodeURIComponent(fileName)}`;

    req.headers.authorization = `Bearer ${vaultConfig.vault_api_key}`;
    streamProxy.proxyRequest(req, res, targetUrl);
  });

  router.get('/api/hls-segment/:fileId/:segmentId', (req, res) => {
    const config = getConfig();
    const vaultConfig = getVaultConfig(config);

    if (!vaultConfig) {
      return res.status(502).json({ error: 'Vault not configured' });
    }

    const { fileId, segmentId } = req.params;
    const targetUrl = `${vaultConfig.vault_url}/api/files/hls/${fileId}/segment/${segmentId}.ts`;

    req.headers.authorization = `Bearer ${vaultConfig.vault_api_key}`;
    streamProxy.proxyRequest(req, res, targetUrl);
  });

  router.get('/api/thumbnail/:fileId', async (req, res) => {
    try {
      const config = getConfig();
      const fileId = req.params.fileId;
      const vaultConfig = getVaultConfig(config);
      const cacheDir = config.cache_dir
        ? require('path').join(config.cache_dir, 'thumbnails')
        : null;

      const result = await streamProxy.serveThumbnail(fileId, vaultConfig, cacheDir);
      if (!result) {
        return res.status(404).json({ error: 'Thumbnail not available' });
      }

      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400, immutable');
      res.setHeader('X-Thumb-Source', result.from);
      res.setHeader('Content-Length', result.contentLength);
      res.end(result.content);
    } catch (err) {
      res.status(502).json({ error: 'Thumbnail unavailable', detail: err.message });
    }
  });

  return router;
}

module.exports = { createStreamProxyRouter };
