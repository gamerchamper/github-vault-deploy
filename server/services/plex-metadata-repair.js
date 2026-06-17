const fs = require('fs');
const plexClient = require('./plex-client');
const sidecarDbRepair = require('./plex-sidecar-db-repair');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Inject container/duration/streams from .vault-item.json sidecars into Plex library DB.
 * Also rewrites media_parts.file from local .strm paths to the remote stream URL so Plex
 * Transcoder fetches HTTP media instead of passing the 26-byte STRM text file to ffmpeg.
 */
function repairSectionFromSidecars(libraryPath, sectionKey) {
  if (!libraryPath) {
    return { ok: false, error: 'libraryPath is required for sidecar DB repair' };
  }
  return sidecarDbRepair.repairVaultLibraryFromSidecars(libraryPath, { sectionKey });
}

/**
 * Apply vault thumbnail_url values through the Plex HTTP API.
 * Direct metadata_items writes fail on Plex's custom SQLite tokenizer.
 */
async function applySidecarThumbnailsViaPlex(plexUrl, token, libraryPath, {
  sectionKey = null,
  dbPath = null,
  itemDelayMs = 150,
} = {}) {
  if (!libraryPath) {
    return { ok: false, error: 'libraryPath is required for thumbnail repair' };
  }
  if (!plexUrl || !token) {
    return { ok: false, error: 'Plex URL and token are required for thumbnail repair' };
  }

  const resolvedDb = dbPath || sidecarDbRepair.defaultPlexLibraryDbPath();
  if (!resolvedDb || !fs.existsSync(resolvedDb)) {
    return { ok: false, error: 'Plex library database not found', db_path: resolvedDb };
  }

  const Database = require('better-sqlite3');
  const db = new Database(resolvedDb, { readonly: true });
  const rows = sidecarDbRepair.listStrmMediaRows(db, libraryPath, sectionKey);
  db.close();

  const results = [];
  for (const row of rows) {
    const sidecar = sidecarDbRepair.loadSidecar(row.strm_path || row.part_file);
    const thumbUrl = sidecar?.thumbnail_url;
    if (!thumbUrl || !row.metadata_item_id) {
      results.push({
        metadata_id: row.metadata_item_id || null,
        part_file: row.strm_path || row.part_file,
        ok: false,
        reason: thumbUrl ? 'missing_metadata_id' : 'missing_thumbnail',
      });
      continue;
    }

    try {
      await plexClient.setMetadataPoster(plexUrl, token, row.metadata_item_id, {
        thumbUrl,
        artUrl: sidecar.art_url || thumbUrl,
      });
      results.push({
        metadata_id: row.metadata_item_id,
        part_file: row.strm_path || row.part_file,
        ok: true,
        thumbnail_url: thumbUrl,
      });
    } catch (err) {
      results.push({
        metadata_id: row.metadata_item_id,
        part_file: row.strm_path || row.part_file,
        ok: false,
        error: err.message,
      });
    }
    if (itemDelayMs > 0) await sleep(itemDelayMs);
  }

  return {
    ok: true,
    total: rows.length,
    applied: results.filter((entry) => entry.ok).length,
    results,
  };
}

/**
 * Apply posters via Plex API, optionally refresh legacy items, then run sidecar DB repair last.
 * Sidecar DB repair must run after any Plex metadata refresh/agent pass — refresh rewrites
 * media_parts.file back to local .strm paths and clears streams, which makes the transcoder
 * pass the STRM text file to ffmpeg instead of the remote HTTP URL.
 */
async function repairSectionMetadata(plexUrl, token, sectionKey, {
  libraryPath = null,
  delayMs = 3000,
  itemDelayMs = 1500,
  maxItems = 50,
  skipAnalyze = true,
} = {}) {
  if (!sectionKey) throw new Error('Plex library section key is required');

  if (delayMs > 0) await sleep(delayMs);

  let thumbnails = null;
  if (libraryPath) {
    try {
      thumbnails = await applySidecarThumbnailsViaPlex(plexUrl, token, libraryPath, { sectionKey });
    } catch (err) {
      thumbnails = { ok: false, error: err.message };
    }
  }

  const items = await plexClient.listSectionMetadata(plexUrl, token, sectionKey);
  const results = [];
  let needsRepair = [];

  // Vault .strm items get technical media from sidecars via DB repair. Metadata refresh only
  // re-triggers the agent/scanner and undoes remote URL + stream injection.
  if (!libraryPath) {
    needsRepair = items.filter(plexClient.metadataNeedsAnalysis).slice(0, maxItems);
    for (const item of needsRepair) {
      try {
        await plexClient.refreshMetadataItem(plexUrl, token, item.ratingKey, { force: true });
        if (!skipAnalyze) {
          await sleep(itemDelayMs);
          await plexClient.analyzeMetadataItem(plexUrl, token, item.ratingKey);
        }
        results.push({ ratingKey: item.ratingKey, title: item.title, ok: true });
      } catch (err) {
        results.push({
          ratingKey: item.ratingKey,
          title: item.title,
          ok: false,
          error: err.message,
        });
      }
      await sleep(300);
    }
  }

  let sidecarDb = null;
  if (libraryPath) {
    sidecarDb = repairSectionFromSidecars(libraryPath, sectionKey);
  }

  const after = await plexClient.listSectionMetadata(plexUrl, token, sectionKey);
  const stillBroken = after.filter(plexClient.metadataNeedsAnalysis).length;

  return {
    total: items.length,
    needs_repair: needsRepair.length,
    repaired: results.filter((entry) => entry.ok).length,
    still_broken: stillBroken,
    sidecar_db: sidecarDb,
    thumbnails,
    results,
  };
}

module.exports = {
  repairSectionFromSidecars,
  applySidecarThumbnailsViaPlex,
  repairSectionMetadata,
};
