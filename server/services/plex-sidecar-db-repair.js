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
  const width = Number(sidecar.width) || null;
  const height = Number(sidecar.height) || null;
  const bitrate = Number(sidecar.bitrate) || null;
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

function injectSidecarIntoMediaRow(db, mediaItemId, partId, sidecar) {
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
  if (!partHasStreams(db, partId)) {
    db.prepare(`
      INSERT INTO media_streams (
        stream_type_id, media_item_id, codec, "index", media_part_id, channels, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(STREAM_VIDEO, mediaItemId, fields.video_codec, 0, partId, null, ts, ts);
    streamsAdded += 1;

    db.prepare(`
      INSERT INTO media_streams (
        stream_type_id, media_item_id, codec, "index", media_part_id, channels, created_at, updated_at, "default"
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(STREAM_AUDIO, mediaItemId, fields.audio_codec, 1, partId, fields.audio_channels, ts, ts, 1);
    streamsAdded += 1;
  }

  return {
    ok: true,
    container: fields.container,
    duration: fields.duration,
    streams_added: streamsAdded,
  };
}

function normalizePathCompare(p) {
  return path.resolve(String(p || '')).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

function listStrmMediaRows(db, libraryPath, sectionKey = null) {
  const prefix = normalizePathCompare(libraryPath);
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
    WHERE mp.file LIKE '%.strm'
      AND mi.deleted_at IS NULL
      AND mp.deleted_at IS NULL
  `;
  const params = [];
  if (sectionKey != null && sectionKey !== '') {
    sql += ' AND mi.library_section_id = ?';
    params.push(Number(sectionKey));
  }
  const rows = db.prepare(sql).all(...params);
  return rows.filter((row) => normalizePathCompare(row.part_file).includes(prefix));
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
      const sidecar = loadSidecar(row.part_file);
      if (!sidecar || sidecar.error) {
        results.push({
          part_file: row.part_file,
          ok: false,
          reason: sidecar?.error ? `sidecar_error: ${sidecar.error}` : 'missing_sidecar',
        });
        continue;
      }

      if (row.container && row.duration && partHasStreams(db, row.part_id)) {
        results.push({ part_file: row.part_file, ok: true, skipped: true });
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

      const inject = injectSidecarIntoMediaRow(db, row.media_item_id, row.part_id, sidecar);
      results.push({ part_file: row.part_file, ...inject });
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

module.exports = {
  STREAM_VIDEO,
  STREAM_AUDIO,
  defaultPlexLibraryDbPath,
  sidecarPathForStrm,
  loadSidecar,
  sidecarToMediaFields,
  injectSidecarIntoMediaRow,
  listStrmMediaRows,
  repairVaultLibraryFromSidecars,
};
