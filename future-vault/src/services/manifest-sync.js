const fs = require('fs');
const path = require('path');
const store = require('./store');
const vaultUpstream = require('./vault-upstream');
const streamProxy = require('./stream-proxy');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeEntry(output, entry) {
  const filePath = path.join(output, ...entry.path.split('/'));
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, entry.content, 'utf8');
}

function rewriteEntryContent(entry, agentUrl) {
  if (!agentUrl || !entry.path.endsWith('.strm')) return entry;

  const content = String(entry.content || '').trim();
  if (streamProxy.isVaultServerUrl(content)) {
    const rewritten = streamProxy.rewriteToAgent(content, agentUrl);
    return { ...entry, content: `${rewritten}\n` };
  }

  return entry;
}

function rewriteSidecarContent(entry, agentUrl) {
  if (!agentUrl || !entry.path.endsWith('.vault-item.json')) return entry;

  try {
    const obj = JSON.parse(entry.content);
    let changed = false;

    if (obj.stream_url && streamProxy.isVaultServerUrl(obj.stream_url)) {
      obj.stream_url = streamProxy.rewriteToAgent(obj.stream_url, agentUrl);
      changed = true;
    }

    if (obj.thumbnail_url && streamProxy.isVaultThumbnailUrl(obj.thumbnail_url)) {
      obj.thumbnail_url = streamProxy.rewriteThumbnailUrl(obj.thumbnail_url, agentUrl);
      changed = true;
    }

    if (!obj.thumbnail_url && obj.file_id) {
      obj.thumbnail_url = `${agentUrl}/api/thumbnail/${obj.file_id}`;
      changed = true;
    }

    if (obj.art_url && streamProxy.isVaultThumbnailUrl(obj.art_url)) {
      obj.art_url = streamProxy.rewriteThumbnailUrl(obj.art_url, agentUrl);
      changed = true;
    }

    if (!obj.art_url && obj.thumbnail_url) {
      obj.art_url = obj.thumbnail_url;
      changed = true;
    }

    return changed ? { ...entry, content: `${JSON.stringify(obj, null, 2)}\n` } : entry;
  } catch {
    return entry;
  }
}

function pruneRemoved(output, keepRelativePaths) {
  const keep = new Set(keepRelativePaths.map((f) => path.normalize(f.replace(/\//g, path.sep))));
  let removed = 0;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.strm') || entry.name.endsWith('.vault-item.json')) {
        const rel = path.normalize(path.relative(output, full));
        if (!keep.has(rel)) {
          fs.unlinkSync(full);
          removed += 1;
        }
      }
    }
  };
  for (const sub of ['Playlists', 'Collections', 'Continue Watching', '.vault-sidecars']) {
    const subPath = path.join(output, sub);
    if (fs.existsSync(subPath)) walk(subPath);
  }
  return removed;
}

function applyManifestToLibrary(config, manifest, stats = {}, { prune = true } = {}) {
  const outputPath = config.plex_library_path;
  if (!outputPath) throw new Error('plex_library_path is not set');
  const output = path.resolve(outputPath);
  ensureDir(output);

  const agentUrl = config.agent_url || 'http://127.0.0.1:7420';

  for (const entry of manifest.entries || []) {
    let rewritten = rewriteEntryContent(entry, agentUrl);
    rewritten = rewriteSidecarContent(rewritten, agentUrl);
    writeEntry(output, rewritten);
  }

  if (manifest._meta) {
    fs.writeFileSync(
      path.join(output, '.vault-hls-meta.json'),
      `${JSON.stringify(manifest._meta, null, 2)}\n`,
      'utf8',
    );
  }

  const diskManifest = {
    root: output,
    vault_url: manifest.vault_url,
    agent_url: config.agent_url,
    synced_at: manifest.synced_at || new Date().toISOString(),
    files: manifest.keep_paths,
  };

  fs.writeFileSync(
    path.join(output, '.vault-plex-sync.json'),
    `${JSON.stringify({ ...diskManifest, stats }, null, 2)}\n`,
    'utf8',
  );

  fs.writeFileSync(
    path.join(output, '.future-vault-sync.json'),
    `${JSON.stringify({
      agent_url: config.agent_url,
      synced_at: diskManifest.synced_at,
      source: manifest._source || 'future-vault',
    }, null, 2)}\n`,
    'utf8',
  );

  if (prune && manifest.keep_paths?.length) {
    stats.pruned = pruneRemoved(output, manifest.keep_paths);
  }

  return { output, stats, manifest: diskManifest };
}

async function runSync(config, { prune = true, forceRefresh = false } = {}) {
  if (forceRefresh && vaultUpstream.vaultConfigured(config)) {
    await vaultUpstream.pullEndpoint(config, 'hub', '/hub');
    await vaultUpstream.pullEndpoint(config, 'playlists', '/playlists');
    await vaultUpstream.pullEndpoint(config, 'collections', '/collections');
    await vaultUpstream.pullEndpoint(config, 'continue', '/continue');
  }

  const fetched = await vaultUpstream.fetchManifest(config);
  if (!fetched.ok) {
    store.patchStatus(config, { last_sync_error: fetched.error, last_sync_at: new Date().toISOString() });
    store.appendEvent(config, 'error', 'Library sync failed', { error: fetched.error });
    return fetched;
  }

  const manifest = { ...fetched.manifest, _source: fetched.source };
  const result = applyManifestToLibrary(config, manifest, fetched.stats || {}, { prune });
  store.patchStatus(config, {
    last_sync_at: new Date().toISOString(),
    last_sync_error: fetched.stale ? `Used cache: ${fetched.error || 'vault offline'}` : null,
    last_sync_source: fetched.source,
    last_sync_files: result.stats?.files || manifest.entries?.length || 0,
  });
  store.appendEvent(config, 'info', `Synced library (${fetched.source})`, {
    files: result.stats?.files,
    pruned: result.stats?.pruned,
    stale: !!fetched.stale,
  });

  return { ok: true, source: fetched.source, stale: !!fetched.stale, ...result };
}

module.exports = {
  applyManifestToLibrary,
  runSync,
};
