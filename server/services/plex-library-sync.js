const fs = require('fs');
const path = require('path');
const plexBridge = require('./plex-bridge');
const plexMediaProbe = require('./plex-media-probe');
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

function strmBaseName(index, item) {
  const title = safeName(item.title || item.id);
  const base = `${padIndex(index)} - ${title}`;
  const mime = item.mime_type || '';
  if (mime.startsWith('audio/')) {
    if (/\.(mp3|m4a|flac|ogg|wav|opus|aac)$/i.test(title)) return base;
    if (/\.mp3$/i.test(item.title || '')) return `${base}.mp3`;
    return `${base}.mp3`;
  }
  if (!mime.startsWith('video/')) return base;
  if (/\.(mkv|webm|mp4|m4v|mov|avi)$/i.test(title)) return base;
  if (/\.mkv$/i.test(item.title || '')) return `${base}.mkv`;
  if (/\.webm$/i.test(item.title || '')) return `${base}.webm`;
  return `${base}.mp4`;
}

function sidecarPayload(item, probe = null) {
  const name = item.title || '';
  const isVideo = (item.mime_type || '').startsWith('video/');
  const isAudio = (item.mime_type || '').startsWith('audio/');
  const fallback = {};
  if (isVideo && !probe?.container) {
    if (/\.mkv$/i.test(name)) fallback.container = 'mkv';
    else if (/\.webm$/i.test(name)) fallback.container = 'webm';
    else fallback.container = 'mp4';
  }
  if (isAudio && !probe?.container) {
    if (/\.m4a$/i.test(name)) fallback.container = 'm4a';
    else fallback.container = 'mp3';
  }
  if (isVideo && !probe?.video_codec) {
    fallback.video_codec = 'h264';
    fallback.audio_codec = 'aac';
  }
  if (isAudio && !probe?.audio_codec) {
    fallback.audio_codec = 'mp3';
    fallback.audio_channels = 2;
  }
  const streamUrl = item.strm_url || item.stream_url || null;
  return {
    title: item.title || safeName(item.id) || 'Untitled',
    summary: item.summary || null,
    thumbnail_url: item.thumbnail_url || null,
    file_id: item.id || null,
    mime_type: item.mime_type || null,
    stream_url: streamUrl,
    size_bytes: item.size || probe?.size || null,
    position_seconds: item.position_seconds || null,
    duration_sec: probe?.duration_sec || item.duration_sec || null,
    ...fallback,
    ...plexMediaProbe.sidecarProbeFields(probe, { audioOnly: isAudio }),
  };
}

async function sidecarPayloadForItem(userId, item, req) {
  const probe = await plexMediaProbe.getProbeInfo(userId, {
    id: item.id,
    name: item.title,
    display_name: item.title,
    mime_type: item.mime_type,
    size: item.size,
  }, req, { allowRemoteProbe: true });
  return sidecarPayload(item, probe);
}

async function playlistEntries(userId, items, relDir, req) {
  const entries = [];
  const keepPaths = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    const baseName = strmBaseName(i + 1, item);
    const strmRel = relPath(relDir, `${baseName}.strm`);
    const sidecarRel = relPath(relDir, `${baseName}.vault-item.json`);
    const sidecar = await sidecarPayloadForItem(userId, item, req);
    const sidecarContent = `${JSON.stringify(sidecar, null, 2)}\n`;
    entries.push({ path: strmRel, content: `${item.strm_url || item.hls_url || item.stream_url}\n` });
    entries.push({ path: sidecarRel, content: sidecarContent });
    if (item.id) {
      entries.push({
        path: relPath('.vault-sidecars', `${item.id}.vault-item.json`),
        content: sidecarContent,
      });
      keepPaths.push(relPath('.vault-sidecars', `${item.id}.vault-item.json`));
    }
    keepPaths.push(strmRel, sidecarRel);
  }
  return { entries, count: items.length, keepPaths };
}

function buildHlsMeta(fileIds) {
  const db = require('../db/database');
  const unique = [...new Set(fileIds.filter(Boolean))];
  if (!unique.length) return {};

  const meta = {};
  const rows = db.prepare(`
    SELECT f.id, f.has_hls, f.hls_playlist_repo_id, f.hls_playlist_path,
           f.has_thumbnail,
           r.full_name, r.default_branch
    FROM files f
    LEFT JOIN storage_repos r ON f.hls_playlist_repo_id = r.id
    WHERE f.id IN (${unique.map(() => '?').join(',')})
  `).all(...unique);

  for (const row of rows) {
    const entry = {
      has_hls: !!row.has_hls,
      has_thumbnail: !!row.has_thumbnail,
      hls_raw_url: null,
    };
    if (entry.has_hls && row.full_name && row.default_branch && row.hls_playlist_path) {
      entry.hls_raw_url = `https://raw.githubusercontent.com/${row.full_name}/${row.default_branch}/${row.hls_playlist_path}`;
    }
    meta[row.id] = entry;
  }
  return meta;
}

async function buildSyncManifest(userId, req) {
  const manifest = {
    vault_url: appUrl.getAppUrl(req),
    synced_at: new Date().toISOString(),
    entries: [],
    keep_paths: [],
    _meta: {},
  };
  const stats = { playlists: 0, collections: 0, files: 0 };
  const fileIds = [];

  const hub = plexBridge.getHub(userId, req);

  for (const playlist of hub.playlists || []) {
    const full = plexBridge.getPlaylist(userId, playlist.id, req);
    const batch = await playlistEntries(userId, full.items || [], relPath('Playlists', safeName(full.title)), req);
    manifest.entries.push(...batch.entries);
    manifest.keep_paths.push(...batch.keepPaths);
    for (const item of full.items || []) {
      if (item.id) fileIds.push(item.id);
    }
    stats.files += batch.count;
    stats.playlists += 1;
  }

  for (const collection of hub.collections || []) {
    const full = plexBridge.getCollection(userId, collection.id, req);
    for (const playlist of full.playlists || []) {
      const pl = plexBridge.getPlaylist(userId, playlist.id, req);
      const batch = await playlistEntries(
        userId,
        pl.items || [],
        relPath('Collections', safeName(full.title), safeName(pl.title)),
        req,
      );
      manifest.entries.push(...batch.entries);
      manifest.keep_paths.push(...batch.keepPaths);
      for (const item of pl.items || []) {
        if (item.id) fileIds.push(item.id);
      }
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
      const baseName = strmBaseName(i + 1, { ...item, title: label });
      const strmRel = relPath('Continue Watching', `${baseName}.strm`);
      const sidecarRel = relPath('Continue Watching', `${baseName}.vault-item.json`);
      const sidecar = await sidecarPayloadForItem(userId, item, req);
      const sidecarContent = `${JSON.stringify(sidecar, null, 2)}\n`;
      manifest.entries.push({ path: strmRel, content: `${item.strm_url || item.hls_url || item.stream_url}\n` });
      manifest.entries.push({ path: sidecarRel, content: sidecarContent });
      if (item.id) {
        manifest.entries.push({
          path: relPath('.vault-sidecars', `${item.id}.vault-item.json`),
          content: sidecarContent,
        });
        manifest.keep_paths.push(relPath('.vault-sidecars', `${item.id}.vault-item.json`));
        fileIds.push(item.id);
      }
      manifest.keep_paths.push(strmRel, sidecarRel);
      stats.files += 1;
    }
  }

  manifest._meta = buildHlsMeta(fileIds);

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
  for (const sub of ['Playlists', 'Collections', 'Continue Watching', '.vault-sidecars']) {
    const subPath = path.join(output, sub);
    if (fs.existsSync(subPath)) walk(subPath);
  }
  return removed;
}

async function syncLibrary(userId, req, outputPath, { prune = true } = {}) {
  if (!outputPath) throw new Error('Plex library path is required');
  const { manifest, stats } = await buildSyncManifest(userId, req);

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

  const fileIds = manifest.entries
    .filter((entry) => entry.path.endsWith('.vault-item.json'))
    .map((entry) => {
      try {
        return JSON.parse(entry.content).file_id;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  const prewarm = await require('./plex-stream-prewarm').prewarmFiles(userId, fileIds);

  return { output, stats, manifest: diskManifest, prewarm };
}

async function prewarmManifestFiles(userId, manifest) {
  const fileIds = (manifest?.entries || [])
    .filter((entry) => entry.path?.endsWith('.vault-item.json'))
    .map((entry) => {
      try {
        return JSON.parse(entry.content).file_id;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (!fileIds.length) return { warmed: 0, file_ids: [] };
  await require('./plex-stream-prewarm').prewarmFiles(userId, fileIds);
  return { warmed: fileIds.length, file_ids: fileIds };
}

module.exports = {
  safeName,
  buildSyncManifest,
  requiresBrowserSync,
  canWriteLibraryPath,
  syncLibrary,
  prewarmManifestFiles,
};
