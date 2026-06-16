const fs = require('fs');
const path = require('path');
const plexBridge = require('./plex-bridge');
const appUrl = require('./app-url');

function safeName(name, max = 140) {
  return String(name || 'Untitled')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max) || 'Untitled';
}

function padIndex(n) {
  return String(n).padStart(2, '0');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeStrm(filePath, streamUrl) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${streamUrl}\n`, 'utf8');
}

function writeSidecar(strmPath, item) {
  const sidecarPath = strmPath.replace(/\.strm$/i, '.vault-item.json');
  const payload = {
    title: item.title || null,
    summary: item.summary || null,
    thumbnail_url: item.thumbnail_url || null,
    file_id: item.id || null,
    mime_type: item.mime_type || null,
    position_seconds: item.position_seconds || null,
  };
  fs.writeFileSync(sidecarPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return sidecarPath;
}

function writePlaylistItems(items, outDir, manifest) {
  ensureDir(outDir);
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const title = safeName(item.title || item.id);
    const fileName = `${padIndex(i + 1)} - ${title}.strm`;
    const filePath = path.join(outDir, fileName);
    writeStrm(filePath, item.stream_url);
    writeSidecar(filePath, item);
    manifest.files.push(path.relative(manifest.root, filePath));
    manifest.files.push(path.relative(manifest.root, filePath.replace(/\.strm$/i, '.vault-item.json')));
  }
  return items.length;
}

function pruneRemoved(output, keepRelativePaths) {
  const keep = new Set(keepRelativePaths.map((f) => path.normalize(f)));
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
  for (const sub of ['Playlists', 'Collections', 'Continue Watching']) {
    const subPath = path.join(output, sub);
    if (fs.existsSync(subPath)) walk(subPath);
  }
  return removed;
}

async function syncLibrary(userId, req, outputPath, { prune = true } = {}) {
  if (!outputPath) throw new Error('Plex library path is required');
  const output = path.resolve(outputPath);
  ensureDir(output);

  const manifest = {
    root: output,
    vault_url: appUrl.getAppUrl(req),
    synced_at: new Date().toISOString(),
    files: [],
  };
  const stats = { playlists: 0, collections: 0, files: 0 };

  const hub = plexBridge.getHub(userId, req);

  for (const playlist of hub.playlists || []) {
    const full = plexBridge.getPlaylist(userId, playlist.id, req);
    const dir = path.join(output, 'Playlists', safeName(full.title));
    stats.files += writePlaylistItems(full.items || [], dir, manifest);
    stats.playlists += 1;
  }

  for (const collection of hub.collections || []) {
    const full = plexBridge.getCollection(userId, collection.id, req);
    const colDir = path.join(output, 'Collections', safeName(full.title));
    for (const playlist of full.playlists || []) {
      const pl = plexBridge.getPlaylist(userId, playlist.id, req);
      const dir = path.join(colDir, safeName(pl.title));
      stats.files += writePlaylistItems(pl.items || [], dir, manifest);
      stats.playlists += 1;
    }
    stats.collections += 1;
  }

  if (hub.continue_watching?.length) {
    const continueDir = path.join(output, 'Continue Watching');
    ensureDir(continueDir);
    for (let i = 0; i < hub.continue_watching.length; i += 1) {
      const item = hub.continue_watching[i];
      const label = item.playlist_title
        ? `${item.playlist_title} - ${item.title}`
        : item.title;
      const fileName = `${padIndex(i + 1)} - ${safeName(label)}.strm`;
      const filePath = path.join(continueDir, fileName);
      writeStrm(filePath, item.stream_url);
      writeSidecar(filePath, item);
      manifest.files.push(path.relative(manifest.root, filePath));
      manifest.files.push(path.relative(manifest.root, filePath.replace(/\.strm$/i, '.vault-item.json')));
      stats.files += 1;
    }
  }

  fs.writeFileSync(
    path.join(output, '.vault-plex-sync.json'),
    `${JSON.stringify({ ...manifest, stats }, null, 2)}\n`,
    'utf8',
  );

  if (prune) {
    stats.pruned = pruneRemoved(output, manifest.files);
  }

  return { output, stats, manifest };
}

module.exports = {
  safeName,
  syncLibrary,
};
