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

function duplicatePreference(rawEpisode, season, episode) {
  if (rawEpisode == null || !Number.isFinite(rawEpisode)) return 1;
  if (rawEpisode < 100) return 0;
  if (season != null && episode != null && rawEpisode === season * 100 + episode) return 1;
  return 1;
}

function buildSortKey(season, episode, rawEpisode, titleBase) {
  const sortSeason = season == null ? 9999 : season;
  const sortEpisode = episode == null ? 9999 : episode;
  const dup = duplicatePreference(rawEpisode, season, episode);
  return [sortSeason, sortEpisode, dup, String(titleBase || '').toLowerCase()];
}

function parseEpisodeMeta(rawTitle, parentPath = '') {
  const title = String(rawTitle || '').trim();
  const path = String(parentPath || '').trim();
  if (!title && !path) {
    return { season: null, episode: null, rawEpisode: null, match: false, label: null, sortKey: [9999, 9999, 1, ''] };
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

function compareSortKeys(ka, kb) {
  for (let i = 0; i < 4; i += 1) {
    if (ka[i] < kb[i]) return -1;
    if (ka[i] > kb[i]) return 1;
  }
  return 0;
}

function compareEpisodeTitles(titleA, titleB, parentPathA = '', parentPathB = '') {
  const ma = parseEpisodeMeta(titleA, parentPathA);
  const mb = parseEpisodeMeta(titleB, parentPathB);
  return compareSortKeys(ma.sortKey, mb.sortKey);
}

function comparePlaylistItems(a, b, regexStr = null) {
  const titleA = a.display_name || a.name || '';
  const titleB = b.display_name || b.name || '';
  if (regexStr) {
    const ra = parseRegexSortMeta(titleA, regexStr) || parseEpisodeMeta(titleA, a.parent_path || '');
    const rb = parseRegexSortMeta(titleB, regexStr) || parseEpisodeMeta(titleB, b.parent_path || '');
    return compareSortKeys(ra.sortKey, rb.sortKey);
  }
  return compareEpisodeTitles(titleA, titleB, a.parent_path || '', b.parent_path || '');
}

function sortItemsByEpisodeMeta(items, { descending = false } = {}) {
  const sorted = [...items].sort((a, b) => comparePlaylistItems(a, b));
  if (descending) sorted.reverse();
  return sorted;
}

function sortItemsByRegex(items, regexStr, { descending = false } = {}) {
  if (!regexStr?.trim()) return sortItemsByEpisodeMeta(items, { descending });
  const sorted = [...items].sort((a, b) => comparePlaylistItems(a, b, regexStr));
  if (descending) sorted.reverse();
  return sorted;
}

module.exports = {
  parseEpisodeMeta,
  parseRegexSortMeta,
  compareEpisodeTitles,
  comparePlaylistItems,
  sortItemsByEpisodeMeta,
  sortItemsByRegex,
  decodePackedEpisode,
};
