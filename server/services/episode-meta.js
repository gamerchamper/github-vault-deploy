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

function parseEpisodeMeta(rawTitle, parentPath = '') {
  const title = String(rawTitle || '').trim();
  const path = String(parentPath || '').trim();
  if (!title && !path) {
    return { season: null, episode: null, match: false, label: null, sortKey: [9999, 9999, ''] };
  }

  const base = title.replace(/\.[a-z0-9]{2,5}$/i, '');
  let season = null;
  let episode = null;
  let match = false;

  const patterns = [
    /\bS(\d{1,2})[\s._-]*E(\d{1,3})\b/i,
    /\b(\d{1,2})x(\d{1,3})\b/i,
    /\bSeason[\s._-]*(\d{1,2})[\s._-]*Episode[\s._-]*(\d{1,3})\b/i,
    /\bSeason[\s._-]*(\d{1,2})[\s._-]*Ep[\s._-]*(\d{1,3})\b/i,
    /\bS(\d{1,2})[\s._-]*Ep[\s._-]*(\d{1,3})\b/i,
    /\bEp(?:isode)?[\s._-]*(\d{1,3})\b/i,
    /\bE(\d{1,3})\b/i,
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
    } else {
      episode = parseInt(m[1], 10);
    }
    if (Number.isFinite(episode) && episode >= 0 && episode <= 999) {
      match = true;
      break;
    }
    season = null;
    episode = null;
  }

  if (match && season == null && episode != null && episode >= 100 && episode <= 9999) {
    const s = Math.floor(episode / 100);
    const e = episode % 100;
    if (s >= 1 && s <= 99 && e >= 1 && e <= 99) {
      season = s;
      episode = e;
    }
  }

  if (season == null) {
    const hinted = extractSeasonHint(base, path);
    if (hinted != null) {
      season = hinted;
      if (match || episode != null) match = true;
    }
  }

  const sortSeason = season == null ? 9999 : season;
  const sortEpisode = episode == null ? 9999 : episode;
  let label = null;
  if (match) {
    if (season != null && episode != null) {
      label = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
    } else if (episode != null) {
      label = season != null
        ? `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
        : `Ep ${episode}`;
    } else if (season != null) {
      label = `S${String(season).padStart(2, '0')}`;
    }
  }

  return {
    season,
    episode,
    match,
    label,
    sortKey: [sortSeason, sortEpisode, base.toLowerCase()],
  };
}

function compareEpisodeTitles(titleA, titleB, parentPathA = '', parentPathB = '') {
  const ma = parseEpisodeMeta(titleA, parentPathA);
  const mb = parseEpisodeMeta(titleB, parentPathB);
  for (let i = 0; i < 3; i += 1) {
    if (ma.sortKey[i] < mb.sortKey[i]) return -1;
    if (ma.sortKey[i] > mb.sortKey[i]) return 1;
  }
  return 0;
}

function comparePlaylistItems(a, b) {
  const titleA = a.display_name || a.name || '';
  const titleB = b.display_name || b.name || '';
  return compareEpisodeTitles(titleA, titleB, a.parent_path || '', b.parent_path || '');
}

function sortItemsByEpisodeMeta(items, { descending = false } = {}) {
  const sorted = [...items].sort(comparePlaylistItems);
  if (descending) sorted.reverse();
  return sorted;
}

module.exports = {
  parseEpisodeMeta,
  compareEpisodeTitles,
  comparePlaylistItems,
  sortItemsByEpisodeMeta,
};
