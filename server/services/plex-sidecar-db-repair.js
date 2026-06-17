const fs = require('fs');
const path = require('path');

const STREAM_VIDEO = 1;
const STREAM_AUDIO = 2;

function defaultPlexLibraryDbPath() {
  if (process.env.PLEX_LIBRARY_DB) return path.resolve(process.env.PLEX_LIBRARY_DB);
  const base = process.env.LOCALAPPDATA || process.env.HOME;
  if (!base) return null;
  return path.join(
    base,
    'Plex Media Server',
    'Plug-in Support',
    'Databases',
    'com.plexapp.plugins.library.db',
  );
}

function sidecarPathForStrm(strmPath) {
  if (!strmPath || !/\.strm$/i.test(strmPath)) return null;
  return strmPath.replace(/\.strm$/i, '.vault-item.json');
}

function loadSidecar(strmPath) {
  const sidecarPath = sidecarPathForStrm(strmPath);
  if (!sidecarPath || !fs.existsSync(sidecarPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(sidecarPath, 'utf8'));
  } catch (err) {
    return { error: err.message, path: sidecarPath };
  }
}

function readStrmUrl(strmPath) {
  if (!strmPath || !fs.existsSync(strmPath)) return null;
  try {
    const line = fs.readFileSync(strmPath, 'utf8').trim().split(/\r?\n/)[0].trim();
    return /^https?:\/\//i.test(line) ? line : null;
  } catch (err) {
    return null;
  }
}

function partNeedsRemoteUrl(partFile) {
  if (!partFile) return true;
  if (/^https?:\/\//i.test(partFile)) return false;
  return /\.strm$/i.test(partFile);
}

function sidecarSizeBytes(sidecar) {
  const raw = sidecar?.size_bytes ?? sidecar?.size;
  const size = Number(raw);
  return Number.isFinite(size) && size > 0 ? Math.round(size) : null;
}

function isAudioSidecar(sidecar) {
  const mime = String(sidecar?.mime_type || '').toLowerCase();
  if (mime.startsWith('audio/')) return true;
  const container = String(sidecar?.container || '').toLowerCase();
  return ['mp3', 'm4a', 'flac', 'ogg', 'opus', 'wav', 'aac'].includes(container);
}

function durationMs(sidecar) {
  const raw = sidecar?.duration_sec;
  if (raw == null || raw === '') return null;
  const sec = Number(raw);
  if (!Number.isFinite(sec) || sec <= 0) return null;
  return Math.round(sec * 1000);
}

function sidecarToMediaFields(sidecar) {
  if (!sidecar || sidecar.error) return null;
  const duration = durationMs(sidecar);
  const bitrate = Number(sidecar.bitrate) || null;
  const audioOnly = isAudioSidecar(sidecar);

  if (audioOnly) {
    let container = sidecar.container || 'mp3';
    if (!container && String(sidecar.mime_type || '').includes('mpeg')) container = 'mp3';
    return {
      container,
      duration,
      video_codec: null,
      audio_codec: sidecar.audio_codec || sidecar.audioCodec || 'mp3',
      audio_channels: Number(sidecar.audio_channels) || 2,
      width: null,
      height: null,
      bitrate: bitrate ? Math.round(bitrate / 1000) : null,
      display_aspect_ratio: null,
      video_profile: null,
      audioOnly: true,
    };
  }

  const width = Number(sidecar.width) || null;
  const height = Number(sidecar.height) || null;
  let container = sidecar.container || 'mp4';
  if (!container && String(sidecar.mime_type || '').includes('mp4')) container = 'mp4';

  let aspect = null;
  if (width && height) aspect = Math.round((width / height) * 1000) / 1000;

  return {
    container,
    duration,
    video_codec: sidecar.video_codec || sidecar.videoCodec || 'h264',
    audio_codec: sidecar.audio_codec || sidecar.audioCodec || 'aac',
    audio_channels: Number(sidecar.audio_channels) || 2,
    width,
    height,
    bitrate: bitrate ? Math.round(bitrate / 1000) : null,
    display_aspect_ratio: aspect,
    video_profile: sidecar.video_profile || 'high',
    audioOnly: false,
  };
}

function nowDt() {
  return Math.floor(Date.now() / 1000);
}

function partHasStreams(db, partId) {
  const row = db.prepare(
    'SELECT COUNT(*) AS n FROM media_streams WHERE media_part_id = ? AND stream_type_id IN (?, ?)',
  ).get(partId, STREAM_VIDEO, STREAM_AUDIO);
  return (row?.n || 0) >= 2;
}

function partHasRequiredStreams(db, partId, audioOnly = false) {
  if (audioOnly) {
    const row = db.prepare(
      'SELECT COUNT(*) AS n FROM media_streams WHERE media_part_id = ? AND stream_type_id = ?',
    ).get(partId, STREAM_AUDIO);
    return (row?.n || 0) >= 1;
  }
  return partHasStreams(db, partId);
}

function metadataNeedsThumbnail(db, metadataItemId, thumbnailUrl) {
  if (!thumbnailUrl || !metadataItemId) return false;
  const row = db.prepare(
    'SELECT user_thumb_url FROM metadata_items WHERE id = ?',
  ).get(metadataItemId);
  return !row || row.user_thumb_url !== thumbnailUrl;
}

function injectThumbnailIntoMetadata(db, metadataItemId, sidecar) {
  const thumbnailUrl = sidecar?.thumbnail_url;
  if (!thumbnailUrl || !metadataItemId) {
    return { patched: false, reason: 'no_thumbnail' };
  }
  if (!metadataNeedsThumbnail(db, metadataItemId, thumbnailUrl)) {
    return { patched: false, skipped: true, thumbnail_url: thumbnailUrl };
  }

  const ts = nowDt();
  try {
    const existing = db.prepare(
      'SELECT user_art_url FROM metadata_items WHERE id = ?',
    ).get(metadataItemId);
    const artUrl = existing?.user_art_url || thumbnailUrl;
    db.prepare(`
      UPDATE metadata_items SET
        user_thumb_url = @thumbnailUrl,
        user_art_url = @artUrl,
        updated_at = @ts
      WHERE id = @metadataItemId
    `).run({ thumbnailUrl, artUrl, ts, metadataItemId });
  } catch (err) {
    return { patched: false, reason: err.message };
  }

  return { patched: true, thumbnail_url: thumbnailUrl };
}

function patchPartToRemoteUrl(db, partId, strmPath, sidecar) {
  const remoteUrl = readStrmUrl(strmPath);
  if (!remoteUrl) {
    return { patched: false, reason: 'no_strm_url' };
  }

  const ts = nowDt();
  const size = sidecarSizeBytes(sidecar);
  if (size) {
    db.prepare(`
      UPDATE media_parts SET file = @file, size = @size, updated_at = @ts WHERE id = @partId
    `).run({ file: remoteUrl, size, ts, partId });
  } else {
    db.prepare(`
      UPDATE media_parts SET file = @file, updated_at = @ts WHERE id = @partId
    `).run({ file: remoteUrl, ts, partId });
  }

  return { patched: true, remote_url: remoteUrl, size };
}

function injectSidecarIntoMediaRow(db, mediaItemId, partId, sidecar, strmPath = null) {
  const fields = sidecarToMediaFields(sidecar);
  if (!fields) {
    return { ok: false, reason: 'invalid_sidecar' };
  }

  const ts = nowDt();
  db.prepare(`
    UPDATE media_items SET
      container = @container,
      duration = @duration,
      video_codec = @video_codec,
      audio_codec = @audio_codec,
      audio_channels = @audio_channels,
      width = @width,
      height = @height,
      bitrate = @bitrate,
      display_aspect_ratio = @display_aspect_ratio,
      updated_at = @ts,
      media_analysis_version = MAX(COALESCE(media_analysis_version, 0), 1)
    WHERE id = @mediaItemId
  `).run({ ...fields, ts, mediaItemId });

  if (fields.duration) {
    db.prepare(`
      UPDATE media_parts SET duration = @duration, updated_at = @ts WHERE id = @partId
    `).run({ duration: fields.duration, ts, partId });

    try {
      db.prepare(`
        UPDATE metadata_items SET duration = @duration, updated_at = @ts
        WHERE id = (SELECT metadata_item_id FROM media_items WHERE id = @mediaItemId)
      `).run({ duration: fields.duration, ts, mediaItemId });
    } catch (err) {
      // Some Plex DB builds reject direct metadata_items writes; media_items is enough for playback.
    }
  }

  let streamsAdded = 0;
  if (!partHasRequiredStreams(db, partId, fields.audioOnly)) {
    if (!fields.audioOnly) {
      db.prepare(`
        INSERT INTO media_streams (
          stream_type_id, media_item_id, codec, "index", media_part_id, channels, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(STREAM_VIDEO, mediaItemId, fields.video_codec, 0, partId, null, ts, ts);
      streamsAdded += 1;
    }

    db.prepare(`
      INSERT INTO media_streams (
        stream_type_id, media_item_id, codec, "index", media_part_id, channels, created_at, updated_at, "default"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      STREAM_AUDIO,
      mediaItemId,
      fields.audio_codec,
      fields.audioOnly ? 0 : 1,
      partId,
      fields.audio_channels,
      ts,
      ts,
      1,
    );
    streamsAdded += 1;
  }

  let remote = null;
  if (strmPath && partNeedsRemoteUrl(
    db.prepare('SELECT file FROM media_parts WHERE id = ?').get(partId)?.file,
  )) {
    remote = patchPartToRemoteUrl(db, partId, strmPath, sidecar);
  }

  return {
    ok: true,
    container: fields.container,
    duration: fields.duration,
    streams_added: streamsAdded,
    audio_only: fields.audioOnly,
    remote_url: remote?.remote_url || null,
    part_size: remote?.size || null,
  };
}

function normalizePathCompare(p) {
  return path.resolve(String(p || '')).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function normalizeFileCompare(p) {
  return path.resolve(String(p || '')).replace(/\\/g, '/').toLowerCase();
}

function listStrmFiles(libraryPath) {
  if (!libraryPath || !fs.existsSync(libraryPath)) return [];
  const root = path.resolve(libraryPath);
  const files = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (/\.strm$/i.test(entry.name)) files.push(full);
    }
  }
  return files;
}

function findMediaRowForStrm(db, strmPath, sectionKey = null) {
  const streamUrl = readStrmUrl(strmPath);
  const strmNorm = normalizeFileCompare(strmPath);
  let sql = `
    SELECT
      mi.id AS media_item_id,
      mi.metadata_item_id,
      mi.container,
      mi.duration,
      mp.id AS part_id,
      mp.file AS part_file,
      mi.library_section_id
    FROM media_parts mp
    JOIN media_items mi ON mi.id = mp.media_item_id
    WHERE mi.deleted_at IS NULL
      AND mp.deleted_at IS NULL
  `;
  const params = [];
  if (sectionKey != null && sectionKey !== '') {
    sql += ' AND mi.library_section_id = ?';
    params.push(Number(sectionKey));
  }
  const rows = db.prepare(sql).all(...params);
  for (const row of rows) {
    const fileNorm = normalizeFileCompare(row.part_file);
    if (fileNorm === strmNorm) {
      return { ...row, strm_path: strmPath };
    }
    if (streamUrl && row.part_file === streamUrl) {
      return { ...row, strm_path: strmPath, remote: true };
    }
  }
  return null;
}

function listStrmMediaRows(db, libraryPath, sectionKey = null) {
  return listStrmFiles(libraryPath)
    .map((strmPath) => findMediaRowForStrm(db, strmPath, sectionKey))
    .filter(Boolean);
}

function auditVaultLibraryPlayback(libraryPath, {
  dbPath = null,
  sectionKey = null,
} = {}) {
  const resolvedDb = dbPath || defaultPlexLibraryDbPath();
  if (!resolvedDb || !fs.existsSync(resolvedDb)) {
    return { ok: false, error: 'Plex library database not found', db_path: resolvedDb };
  }
  if (!libraryPath) {
    return { ok: false, error: 'libraryPath is required' };
  }

  const Database = require('better-sqlite3');
  const db = new Database(resolvedDb, { readonly: true });
  const rows = listStrmMediaRows(db, libraryPath, sectionKey);
  let needsRepair = 0;
  let ready = 0;
  let missingSidecar = 0;

  for (const row of rows) {
    const sidecar = loadSidecar(row.strm_path || row.part_file);
    if (!sidecar || sidecar.error) {
      missingSidecar += 1;
      needsRepair += 1;
      continue;
    }
    const fields = sidecarToMediaFields(sidecar);
    const needsRemote = partNeedsRemoteUrl(row.part_file);
    const streamsOk = partHasRequiredStreams(db, row.part_id, fields?.audioOnly);
    const playbackReady = !needsRemote && streamsOk;
    if (playbackReady) {
      ready += 1;
    } else {
      needsRepair += 1;
    }
  }

  db.close();

  return {
    ok: true,
    db_path: resolvedDb,
    total_strm: rows.length,
    ready,
    needs_repair: needsRepair,
    missing_sidecar: missingSidecar,
  };
}

function repairVaultLibraryFromSidecars(libraryPath, {
  dbPath = null,
  sectionKey = null,
  dryRun = false,
} = {}) {
  const resolvedDb = dbPath || defaultPlexLibraryDbPath();
  if (!resolvedDb || !fs.existsSync(resolvedDb)) {
    return { ok: false, error: 'Plex library database not found', db_path: resolvedDb };
  }
  if (!libraryPath) {
    return { ok: false, error: 'libraryPath is required' };
  }

  const Database = require('better-sqlite3');
  const db = new Database(resolvedDb);
  const rows = listStrmMediaRows(db, libraryPath, sectionKey);
  const results = [];
  let repaired = 0;

  const tx = db.transaction(() => {
    for (const row of rows) {
      const sidecar = loadSidecar(row.strm_path || row.part_file);
      if (!sidecar || sidecar.error) {
        results.push({
          part_file: row.strm_path || row.part_file,
          ok: false,
          reason: sidecar?.error ? `sidecar_error: ${sidecar.error}` : 'missing_sidecar',
        });
        continue;
      }

      const fields = sidecarToMediaFields(sidecar);
      const needsRemote = partNeedsRemoteUrl(row.part_file);
      const streamsOk = partHasRequiredStreams(db, row.part_id, fields?.audioOnly);
      const playbackReady = !needsRemote && streamsOk;
      if (playbackReady) {
        results.push({ part_file: row.strm_path || row.part_file, ok: true, skipped: true });
        continue;
      }

      if (dryRun) {
        results.push({
          part_file: row.part_file,
          ok: true,
          dry_run: true,
          fields: sidecarToMediaFields(sidecar),
        });
        continue;
      }

      const inject = injectSidecarIntoMediaRow(
        db,
        row.media_item_id,
        row.part_id,
        sidecar,
        row.strm_path || row.part_file,
      );
      results.push({ part_file: row.strm_path || row.part_file, ...inject });
      if (inject.ok) repaired += 1;
    }
  });

  tx();
  db.close();

  return {
    ok: true,
    db_path: resolvedDb,
    total_strm: rows.length,
    repaired,
    dry_run: dryRun,
    results,
  };
}

function discoverVaultLibraryPaths() {
  const candidates = [];
  if (process.env.PLEX_VAULT_LIBRARY_PATH) {
    candidates.push(path.resolve(process.env.PLEX_VAULT_LIBRARY_PATH));
  }

  const repoRoot = path.resolve(__dirname, '../..');
  candidates.push(path.join(repoRoot, 'Plex Media Server', 'GitHub Vault'));

  const localBase = process.env.LOCALAPPDATA || process.env.HOME;
  if (localBase) {
    candidates.push(path.join(localBase, 'Plex Media Server', 'GitHub Vault'));
  }

  try {
    const userSettings = require('./user-settings');
    for (const row of userSettings.listPlexSyncCandidates()) {
      if (row.plex_library_path) candidates.push(path.resolve(row.plex_library_path));
    }
  } catch {
    // Vault DB may be unavailable when running standalone repair scripts.
  }

  const seen = new Set();
  const paths = [];
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    const key = resolved.toLowerCase();
    if (seen.has(key) || !fs.existsSync(resolved)) continue;
    if (listStrmFiles(resolved).length === 0) continue;
    seen.add(key);
    paths.push(resolved);
  }
  return paths;
}

module.exports = {
  STREAM_VIDEO,
  STREAM_AUDIO,
  defaultPlexLibraryDbPath,
  sidecarPathForStrm,
  loadSidecar,
  readStrmUrl,
  partNeedsRemoteUrl,
  isAudioSidecar,
  sidecarToMediaFields,
  patchPartToRemoteUrl,
  injectThumbnailIntoMetadata,
  injectSidecarIntoMediaRow,
  listStrmMediaRows,
  discoverVaultLibraryPaths,
  auditVaultLibraryPlayback,
  repairVaultLibraryFromSidecars,
};
