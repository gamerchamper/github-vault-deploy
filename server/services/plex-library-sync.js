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

function relPath(...parts) {
  return path.join(...parts).replace(/\\/g, '/');
}

function sidecarPayload(item) {
  return {
    title: item.title || null,
    summary: item.summary || null,
    thumbnail_url: item.thumbnail_url || null,
    file_id: item.id || null,
    mime_type: item.mime_type || null,
    position_seconds: item.position_seconds || null,
  };
}

function playlistEntries(items, relDir) {
  const entries = [];
  const keepPaths = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const title = safeName(item.title || item.id);
    const baseName = `${padIndex(i + 1)} - ${title}`;
    const strmRel = relPath(relDir, `${baseName}.strm`);
    const sidecarRel = relPath(relDir, `${baseName}.vault-item.json`);
    entries.push({ path: strmRel, content: `${item.stream_url}\n` });
    entries.push({ path: sidecarRel, content: `${JSON.stringify(sidecarPayload(item), null, 2)}\n` });
    keepPaths.push(strmRel, sidecarRel);
  }
  return { entries, count: items.length, keepPaths };
}

function buildSyncManifest(userId, req) {
  const manifest = {
    vault_url: appUrl.getAppUrl(req),
    synced_at: new Date().toISOString(),
    entries: [],
    keep_paths: [],
  };
  const stats = { playlists: 0, collections: 0, files: 0 };

  const hub = plexBridge.getHub(userId, req);

  for (const playlist of hub.playlists || []) {
    const full = plexBridge.getPlaylist(userId, playlist.id, req);
    const batch = playlistEntries(full.items || [], relPath('Playlists', safeName(full.title)));
    manifest.entries.push(...batch.entries);
    manifest.keep_paths.push(...batch.keepPaths);
    stats.files += batch.count;
    stats.playlists += 1;
  }

  for (const collection of hub.collections || []) {
    const full = plexBridge.getCollection(userId, collection.id, req);
    for (const playlist of full.playlists || []) {
      const pl = plexBridge.getPlaylist(userId, playlist.id, req);
      const batch = playlistEntries(
        pl.items || [],
        relPath('Collections', safeName(full.title), safeName(pl.title)),
      );
      manifest.entries.push(...batch.entries);
      manifest.keep_paths.push(...batch.keepPaths);
      stats.files += batch.count;
      stats.playlists += 1;
    }
    stats.collections += 1;
  }

  if (hub.continue_watching?.length) {
    for (let i = 0; i < hub.continue_watching.length; i += 1) {
      const item = hub.continue_watching[i];
      const label = item.playlist_title
        ? `${item.playlist_title} - ${item.title}`
        : item.title;
      const baseName = `${padIndex(i + 1)} - ${safeName(label)}`;
      const strmRel = relPath('Continue Watching', `${baseName}.strm`);
      const sidecarRel = relPath('Continue Watching', `${baseName}.vault-item.json`);
      manifest.entries.push({ path: strmRel, content: `${item.stream_url}\n` });
      manifest.entries.push({ path: sidecarRel, content: `${JSON.stringify(sidecarPayload(item), null, 2)}\n` });
      manifest.keep_paths.push(strmRel, sidecarRel);
      stats.files += 1;
    }
  }

  return { manifest, stats };
}

function isWindowsPath(outputPath) {
  return /^[a-zA-Z]:[\\/]/.test(String(outputPath || '').trim());
}

function isUnixAbsolutePath(outputPath) {
  return String(outputPath || '').trim().startsWith('/');
}

/** Path targets the user's PC, not this vault server's filesystem. */
function requiresBrowserSync(outputPath) {
  const p = String(outputPath || '').trim();
  if (!p) return true;
  if (process.platform === 'win32') {
    return isUnixAbsolutePath(p) && !isWindowsPath(p);
  }
  return isWindowsPath(p);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeEntry(output, entry) {
  const filePath = path.join(output, ...entry.path.split('/'));
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, entry.content, 'utf8');
}

function canWriteLibraryPath(outputPath) {
  if (!outputPath || requiresBrowserSync(outputPath)) return false;
  try {
    const output = path.resolve(outputPath);
    ensureDir(output);
    const test = path.join(output, `.vault-write-test-${process.pid}`);
    fs.writeFileSync(test, 'ok', 'utf8');
    fs.unlinkSync(test);
    return true;
  } catch {
    return false;
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
  for (const sub of ['Playlists', 'Collections', 'Continue Watching']) {
    const subPath = path.join(output, sub);
    if (fs.existsSync(subPath)) walk(subPath);
  }
  return removed;
}

async function syncLibrary(userId, req, outputPath, { prune = true } = {}) {
  if (!outputPath) throw new Error('Plex library path is required');
  const { manifest, stats } = buildSyncManifest(userId, req);

  if (requiresBrowserSync(outputPath)) {
    const err = new Error(
      'This library path is on your PC, but vault runs on a remote server. '
      + 'Use "Write to folder on this PC" in Settings — server sync cannot write to C:\\ paths.',
    );
    err.code = 'LOCAL_SYNC_REQUIRED';
    err.manifest = manifest;
    err.stats = stats;
    throw err;
  }

  const output = path.resolve(outputPath);

  if (!canWriteLibraryPath(outputPath)) {
    const err = new Error(
      'Vault server cannot write to this library folder. Use "Write to folder on this PC" in Settings.',
    );
    err.code = 'LOCAL_SYNC_REQUIRED';
    err.manifest = manifest;
    err.stats = stats;
    throw err;
  }

  ensureDir(output);
  for (const entry of manifest.entries) {
    writeEntry(output, entry);
  }

  const diskManifest = {
    root: output,
    vault_url: manifest.vault_url,
    synced_at: manifest.synced_at,
    files: manifest.keep_paths,
  };

  fs.writeFileSync(
    path.join(output, '.vault-plex-sync.json'),
    `${JSON.stringify({ ...diskManifest, stats }, null, 2)}\n`,
    'utf8',
  );

  if (prune) {
    stats.pruned = pruneRemoved(output, manifest.keep_paths);
  }

  return { output, stats, manifest: diskManifest };
}

module.exports = {
  safeName,
  buildSyncManifest,
  requiresBrowserSync,
  canWriteLibraryPath,
  syncLibrary,
};
