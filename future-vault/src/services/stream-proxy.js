const http = require('http');
const https = require('https');
const store = require('./store');

function fetchUrl(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const transport = url.startsWith('https') ? https : http;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Timeout fetching ${url}`));
    }, timeoutMs);

    transport.get(url, { signal: controller.signal }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        clearTimeout(timer);
        if (res.statusCode >= 200 && res.statusCode < 400) {
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
        } else {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
      });
      res.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    }).on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function proxyRequest(req, res, targetUrl, timeoutMs = 60000) {
  const url = new URL(targetUrl);
  const transport = url.protocol === 'https:' ? https : http;

  const options = {
    hostname: url.hostname,
    port: url.port || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    method: req.method,
    headers: {},
    timeout: timeoutMs,
  };

  for (const key of Object.keys(req.headers)) {
    const lower = key.toLowerCase();
    if (['host', 'connection', 'keep-alive', 'transfer-encoding'].includes(lower)) continue;
    options.headers[key] = req.headers[key];
  }

  if (req.headers.authorization) {
    options.headers.authorization = req.headers.authorization;
  }

  const proxyReq = transport.request(options, (proxyRes) => {
    res.status(proxyRes.statusCode);
    for (const key of Object.keys(proxyRes.headers)) {
      const lower = key.toLowerCase();
      if (lower === 'transfer-encoding') continue;
      res.setHeader(key, proxyRes.headers[key]);
    }
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    if (!res.headersSent) res.status(502).json({ error: 'Upstream unreachable', detail: err.message });
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) res.status(504).json({ error: 'Upstream timeout' });
  });

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
}

function extractFileId(vaultUrl) {
  const match = String(vaultUrl).match(/\/api\/files\/(stream|hls)\/([^/?]+)/);
  return match ? match[2] : null;
}

function extractFileName(vaultUrl) {
  const match = String(vaultUrl).match(/\/api\/files\/stream\/[^/]+\/([^?]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function isVaultServerUrl(url) {
  return /\/api\/files\/(stream|hls)\//.test(url);
}

function isVaultThumbnailUrl(url) {
  return /\/api\/files\/thumbnail\//.test(url);
}

function extractFileIdFromAny(url) {
  const match = String(url).match(/\/(?:stream|hls|thumbnail)\/([^/?]+)/);
  return match ? match[1] : null;
}

function rewriteThumbnailUrl(vaultUrl, agentUrl) {
  if (!agentUrl || !isVaultThumbnailUrl(vaultUrl)) return vaultUrl;
  const fileId = extractFileIdFromAny(vaultUrl);
  if (!fileId) return vaultUrl;
  return `${agentUrl}/api/thumbnail/${fileId}`;
}

function rewriteToAgent(vaultUrl, agentUrl) {
  const fileId = extractFileId(vaultUrl);
  if (!fileId) return vaultUrl;

  if (vaultUrl.includes('/hls/')) {
    return `${agentUrl}/api/m3u8/${fileId}`;
  }

  const fileName = extractFileName(vaultUrl) || 'stream';
  return `${agentUrl}/api/stream/${fileId}/${encodeURIComponent(fileName)}`;
}

async function serveHlsPlaylist(fileId, vaultConfig, { hlsRawUrl } = {}) {
  const result = { from: null, content: null, contentType: 'application/vnd.apple.mpegurl' };

  if (hlsRawUrl) {
    try {
      const res = await fetchUrl(hlsRawUrl, 8000);
      if (res.status >= 200 && res.status < 400) {
        result.from = 'github-raw';
        result.content = res.body;
        return result;
      }
    } catch {
      // GitHub raw failed, fall through to vault
    }
  }

  if (vaultConfig && vaultConfig.vault_url && vaultConfig.vault_api_key) {
    const base = String(vaultConfig.vault_url).replace(/\/+$/, '');
    const vaultUrl = `${base}/api/files/hls/${fileId}/playlist.m3u8`;
    try {
      const res = await fetchWithRetry(vaultUrl, vaultConfig.vault_api_key, 15000);
      result.from = 'vault-proxy';
      result.content = res;
      return result;
    } catch {
      // vault also failed
    }
  }

  throw new Error('No HLS playlist available');
}

async function fetchWithRetry(url, apiKey, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: '*/*',
        Authorization: `Bearer ${apiKey}`,
      },
      redirect: 'follow',
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return Buffer.from(await res.arrayBuffer());
  } finally {
    clearTimeout(timer);
  }
}

async function serveThumbnail(fileId, vaultConfig, cacheDir) {
  if (!cacheDir) {
    cacheDir = require('path').join(require('os').tmpdir(), 'future-vault-thumbnails');
  }

  const fs = require('fs');
  const path = require('path');
  const cacheFile = path.join(cacheDir, `${fileId}.thumb.jpg`);

  fs.mkdirSync(cacheDir, { recursive: true });

  if (fs.existsSync(cacheFile)) {
    const stat = fs.statSync(cacheFile);
    return { from: 'cache', content: fs.readFileSync(cacheFile), contentLength: stat.size };
  }

  if (vaultConfig && vaultConfig.vault_url && vaultConfig.vault_api_key) {
    const base = String(vaultConfig.vault_url).replace(/\/+$/, '');
    const vaultUrl = `${base}/api/files/thumbnail/${fileId}`;
    try {
      const buf = await fetchWithRetry(vaultUrl, vaultConfig.vault_api_key, 30000);
      if (buf && buf.length > 0) {
        try {
          fs.writeFileSync(cacheFile, buf);
          manageThumbnailCache(cacheDir, 200);
        } catch {
          // cache write failure is non-fatal
        }
        return { from: 'vault', content: buf, contentLength: buf.length };
      }
    } catch {
      // vault fetch failed, fall through
    }
  }

  return null;
}

function manageThumbnailCache(cacheDir, maxFiles = 200) {
  try {
    const fs = require('fs');
    const path = require('path');
    const files = fs.readdirSync(cacheDir)
      .filter((f) => f.endsWith('.thumb.jpg'))
      .map((f) => path.join(cacheDir, f))
      .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);

    while (files.length > maxFiles) {
      fs.unlinkSync(files.shift());
    }
  } catch {
    // cleanup failure is non-fatal
  }
}

module.exports = {
  fetchUrl,
  proxyRequest,
  extractFileId,
  extractFileName,
  isVaultServerUrl,
  isVaultThumbnailUrl,
  extractFileIdFromAny,
  rewriteToAgent,
  rewriteThumbnailUrl,
  serveHlsPlaylist,
  serveThumbnail,
  fetchWithRetry,
};
