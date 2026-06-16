const plexClient = require('./plex-client');
const sidecarDbRepair = require('./plex-sidecar-db-repair');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Inject container/duration/streams from .vault-item.json sidecars into Plex library DB.
 * Plex Movie agent models cannot set metadata.media — scanner leaves STRM items empty.
 */
function repairSectionFromSidecars(libraryPath, sectionKey) {
  if (!libraryPath) {
    return { ok: false, error: 'libraryPath is required for sidecar DB repair' };
  }
  return sidecarDbRepair.repairVaultLibraryFromSidecars(libraryPath, { sectionKey });
}

/**
 * Re-run sidecar DB repair, then agent refresh on items still missing media info.
 */
async function repairSectionMetadata(plexUrl, token, sectionKey, {
  libraryPath = null,
  delayMs = 3000,
  itemDelayMs = 1500,
  maxItems = 50,
  skipAnalyze = true,
} = {}) {
  if (!sectionKey) throw new Error('Plex library section key is required');

  let sidecarDb = null;
  if (libraryPath) {
    sidecarDb = repairSectionFromSidecars(libraryPath, sectionKey);
  }

  if (delayMs > 0) await sleep(delayMs);

  const items = await plexClient.listSectionMetadata(plexUrl, token, sectionKey);
  const needsRepair = items.filter(plexClient.metadataNeedsAnalysis).slice(0, maxItems);
  const results = [];

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

  const after = await plexClient.listSectionMetadata(plexUrl, token, sectionKey);
  const stillBroken = after.filter(plexClient.metadataNeedsAnalysis).length;

  return {
    total: items.length,
    needs_repair: needsRepair.length,
    repaired: results.filter((entry) => entry.ok).length,
    still_broken: stillBroken,
    sidecar_db: sidecarDb,
    results,
  };
}

module.exports = {
  repairSectionFromSidecars,
  repairSectionMetadata,
};
