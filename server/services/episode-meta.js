function extractSeasonHint(...sources) {
  const patterns = [
    /\bSeason[\s._-]*(\d{1,2})\b/i,
    /\bS(\d{1,2})(?:[\s._-]*E[\s._-]*\d|\b)/i,
    /(?:^|[/\\])Season[\s._-]*(\d{1,2})(?:[/\\]|$)/i,
    /(?:^|[/\\])S(\d{1,2})(?:[/\\]|$)/i,
    /(?:^|[/\\])(\d{1,2})(?:[/\\]|$)/,
  ];

  for (const src of sources) {
    const text = String(src || '').trim();
    if (!text) continue;
    for (const re of patterns) {
      const m = text.match(re);
      if (!m) continue;
      const season = parseInt(m[1], 10);
      if (Number.isFinite(season) && season >= 1 && season <= 99) return season;
    }
  }
  return null;
}

function decodePackedEpisode(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return { season: null, episode: null };
  if (n >= 100 && n <= 9999) {
    const season = Math.floor(n / 100);
    const episode = n % 100;
    if (season >= 1 && season <= 99 && episode >= 1 && episode <= 99) {
      return { season, episode };
    }
  }
  return { season: 1, episode: n };
}

function buildSortKey(season, episode, rawEpisode, titleBase) {
  const sortSeason = season == null ? 9999 : season;
  const sortEpisode = episode == null ? 9999 : episode;
  const packed = rawEpisode != null && rawEpisode >= 100 ? 1 : 0;
  const rawTie = rawEpisode == null ? 9999 : rawEpisode;
  return [sortSeason, sortEpisode, packed, rawTie, String(titleBase || '').toLowerCase()];
}

function parseEpisodeMeta(rawTitle, parentPath = '') {
  const title = String(rawTitle || '').trim();
  const path = String(parentPath || '').trim();
  if (!title && !path) {
    return { season: null, episode: null, rawEpisode: null, match: false, label: null, sortKey: buildSortKey(null, null, null, '') };
  }

  const base = title.replace(/\.[a-z0-9]{2,5}$/i, '');
  let season = null;
  let episode = null;
  let rawEpisode = null;
  let match = false;

  const patterns = [
    /\bS(\d{1,2})[\s._-]*E(\d{1,3})\b/i,
    /\b(\d{1,2})x(\d{1,3})\b/i,
    /\bSeason[\s._-]*(\d{1,2})[\s._-]*Episode[\s._-]*(\d{1,3})\b/i,
    /\bSeason[\s._-]*(\d{1,2})[\s._-]*Ep[\s._-]*(\d{1,3})\b/i,
    /\bS(\d{1,2})[\s._-]*Ep[\s._-]*(\d{1,3})\b/i,
    /\bEP\.?\s*(\d{1,4})\b/i,
    /\bEp(?:isode)?[\s._-]*(\d{1,4})\b/i,
    /\bE(\d{1,4})\b/i,
    /\bPart[\s._-]*(\d{1,3})\b/i,
    /\bPt[\s._-]*(\d{1,3})\b/i,
    /[\[\(](\d{1,3})[\]\)]/,
    /(?:^|[\s._-])(\d{1,3})(?:[\s._-]|$)/,
  ];

  for (const re of patterns) {
    const m = base.match(re);
    if (!m) continue;
    if (re.source.includes('(\\d{1,3})(?:[\\s._-]|$)')) {
      const prefix = base.slice(0, m.index).toLowerCase();
      if (/\bseason[\s._-]*$/i.test(prefix)) continue;
    }
    if (m.length >= 3) {
      season = parseInt(m[1], 10);
      episode = parseInt(m[2], 10);
      rawEpisode = episode;
    } else {
      rawEpisode = parseInt(m[1], 10);
      episode = rawEpisode;
    }
    if (Number.isFinite(episode) && episode >= 0 && episode <= 9999) {
      match = true;
      break;
    }
    season = null;
    episode = null;
    rawEpisode = null;
  }

  if (match && season == null && rawEpisode != null && rawEpisode >= 100) {
    const decoded = decodePackedEpisode(rawEpisode);
    if (decoded.season != null && decoded.episode != null) {
      season = decoded.season;
      episode = decoded.episode;
    }
  }

  if (season == null) {
    const hinted = extractSeasonHint(base, path);
    if (hinted != null) {
      season = hinted;
      if (match || episode != null) match = true;
    }
  }

  if (season == null && episode != null && match) {
    season = 1;
  }

  let label = null;
  if (match) {
    if (season != null && episode != null) {
      label = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
    } else if (episode != null) {
      label = `Ep ${episode}`;
    } else if (season != null) {
      label = `S${String(season).padStart(2, '0')}`;
    }
  }

  return {
    season,
    episode,
    rawEpisode,
    match,
    label,
    sortKey: buildSortKey(season, episode, rawEpisode, base),
  };
}

function parseRegexSortMeta(rawTitle, regexStr) {
  if (!regexStr?.trim()) return null;
  let re;
  try {
    re = new RegExp(regexStr, 'i');
  } catch {
    return null;
  }
  const base = String(rawTitle || '').replace(/\.[a-z0-9]{2,5}$/i, '');
  const m = base.match(re);
  if (!m || m[1] == null) return null;
  const rawEpisode = parseInt(m[1], 10);
  if (!Number.isFinite(rawEpisode)) return null;
  const decoded = decodePackedEpisode(rawEpisode);
  const season = decoded.season;
  const episode = decoded.episode;
  const label = season != null && episode != null
    ? `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
    : `Ep ${rawEpisode}`;
  return {
    season,
    episode,
    rawEpisode,
    match: true,
    label,
    sortKey: buildSortKey(season, episode, rawEpisode, base),
  };
}

function metaForItem(item, regexStr = null) {
  const title = item.display_name || item.name || '';
  if (regexStr) {
    const fromRegex = parseRegexSortMeta(title, regexStr);
    if (fromRegex) return fromRegex;
  }
  return parseEpisodeMeta(title, item.parent_path || '');
}

function compareSortKeys(ka, kb) {
  const len = Math.max(ka.length, kb.length);
  for (let i = 0; i < len; i += 1) {
    const av = ka[i] ?? '';
    const bv = kb[i] ?? '';
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

function compareEpisodeTitles(titleA, titleB, parentPathA = '', parentPathB = '') {
  const ma = parseEpisodeMeta(titleA, parentPathA);
  const mb = parseEpisodeMeta(titleB, parentPathB);
  return compareSortKeys(ma.sortKey, mb.sortKey);
}

function comparePlaylistItems(a, b, regexStr = null) {
  const ma = metaForItem(a, regexStr);
  const mb = metaForItem(b, regexStr);
  return compareSortKeys(ma.sortKey, mb.sortKey);
}

function countMatches(items, regexStr = null) {
  return items.reduce((n, item) => n + (metaForItem(item, regexStr).match ? 1 : 0), 0);
}

function sortItemsByEpisodeMeta(items, { descending = false, regex = null } = {}) {
  const sorted = [...items].sort((a, b) => comparePlaylistItems(a, b, regex));
  if (descending) sorted.reverse();
  return sorted;
}

function sortItemsByRegex(items, regexStr, options = {}) {
  return sortItemsByEpisodeMeta(items, { ...options, regex: regexStr });
}

module.exports = {
  parseEpisodeMeta,
  parseRegexSortMeta,
  metaForItem,
  compareEpisodeTitles,
  comparePlaylistItems,
  countMatches,
  sortItemsByEpisodeMeta,
  sortItemsByRegex,
  decodePackedEpisode,
  DEFAULT_SORT_REGEX: String.raw`EP\.?\s*(\d+)`,
};
