const plexClient = require('./plex-client');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Re-run agent refresh + media analyze on items Plex still has without container/streams.
 * Empty Media records cause MDE "container: undefined" and transcode 400 / Shaka s1001.
 */
async function repairSectionMetadata(plexUrl, token, sectionKey, {
  delayMs = 8000,
  itemDelayMs = 2000,
  maxItems = 50,
} = {}) {
  if (!sectionKey) throw new Error('Plex library section key is required');

  if (delayMs > 0) await sleep(delayMs);

  const items = await plexClient.listSectionMetadata(plexUrl, token, sectionKey);
  const needsRepair = items.filter(plexClient.metadataNeedsAnalysis).slice(0, maxItems);
  const results = [];

  for (const item of needsRepair) {
    try {
      await plexClient.refreshMetadataItem(plexUrl, token, item.ratingKey, { force: true });
      await sleep(itemDelayMs);
      await plexClient.analyzeMetadataItem(plexUrl, token, item.ratingKey);
      results.push({ ratingKey: item.ratingKey, title: item.title, ok: true });
    } catch (err) {
      results.push({
        ratingKey: item.ratingKey,
        title: item.title,
        ok: false,
        error: err.message,
      });
    }
    await sleep(500);
  }

  return {
    total: items.length,
    needs_repair: needsRepair.length,
    repaired: results.filter((entry) => entry.ok).length,
    results,
  };
}

module.exports = {
  repairSectionMetadata,
};
