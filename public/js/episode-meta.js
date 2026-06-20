const EpisodeMeta = {
  VERSION: '1.0.7',
  DEFAULT_SORT_REGEX: String.raw`EP\.?\s*(\d+)`,
  SORT_MODES: ['episode', 'first_number', 'regex'],

  parseFirstNumber(rawTitle) {
    const title = String(rawTitle || '').trim();
    const base = title.replace(/\.[a-z0-9]{2,5}$/i, '');
    const m = base.match(/\d+/);
    if (!m) {
      return { number: null, match: false, label: null, sortKey: [9999, base.toLowerCase()] };
    }
    const number = parseInt(m[0], 10);
    if (!Number.isFinite(number)) {
      return { number: null, match: false, label: null, sortKey: [9999, base.toLowerCase()] };
    }
    return {
      number,
      match: true,
      label: `#${number}`,
      sortKey: [number, base.toLowerCase()],
    };
  },

  nonMatchSortKey(title) {
    const base = String(title || '').replace(/\.[a-z0-9]{2,5}$/i, '');
    return [9999, base.toLowerCase()];
  },

  resolveSortContext(sortMode, sortRegex) {
    const mode = sortMode || (sortRegex ? 'regex' : 'episode');
    const regex = mode === 'regex' ? (sortRegex || null) : null;
    return { sortMode: mode, regex };
  },

  normalizeSortContext(context) {
    if (typeof context === 'string') {
      return this.resolveSortContext(context ? 'regex' : 'episode', context || null);
    }
    if (context && typeof context === 'object') {
      return this.resolveSortContext(context.sortMode ?? context.sort_mode, context.regex ?? context.sort_regex);
    }
    return this.resolveSortContext(null, null);
  },

  decodePackedEpisode(raw) {
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
  },

  buildSortKey(season, episode, rawEpisode, titleBase) {
    const sortSeason = season == null ? 9999 : season;
    const sortEpisode = episode == null ? 9999 : episode;
    const packed = rawEpisode != null && rawEpisode >= 100 ? 1 : 0;
    const rawTie = rawEpisode == null ? 9999 : rawEpisode;
    return [sortSeason, sortEpisode, packed, rawTie, String(titleBase || '').toLowerCase()];
  },

  extractSeasonHint(...sources) {
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
  },

  parse(rawTitle, parentPath = '') {
    const title = String(rawTitle || '').trim();
    const path = String(parentPath || '').trim();
    if (!title && !path) {
      return { season: null, episode: null, rawEpisode: null, match: false, label: null, sortKey: this.buildSortKey(null, null, null, '') };
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
      const decoded = this.decodePackedEpisode(rawEpisode);
      if (decoded.season != null && decoded.episode != null) {
        season = decoded.season;
        episode = decoded.episode;
      }
    }

    if (season == null) {
      const hinted = this.extractSeasonHint(base, path);
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
      sortKey: this.buildSortKey(season, episode, rawEpisode, base),
    };
  },

  parseWithRegex(rawTitle, regexStr) {
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
    const decoded = this.decodePackedEpisode(rawEpisode);
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
      sortKey: this.buildSortKey(season, episode, rawEpisode, base),
    };
  },

  metaForItem(item, context = null) {
    const title = item.display_name || item.name || '';
    const parentPath = item.parent_path || '';
    const { sortMode, regex } = this.normalizeSortContext(context);
    if (sortMode === 'first_number') return this.parseFirstNumber(title);
    if (sortMode === 'regex' && regex) {
      return this.parseWithRegex(title, regex) || {
        match: false,
        label: null,
        sortKey: this.nonMatchSortKey(title),
      };
    }
    return this.parse(title, parentPath);
  },

  compareSortKeys(ka, kb) {
    const len = Math.max(ka.length, kb.length);
    for (let i = 0; i < len; i += 1) {
      const av = ka[i] ?? '';
      const bv = kb[i] ?? '';
      if (av < bv) return -1;
      if (av > bv) return 1;
    }
    return 0;
  },

  formatLabel(meta) {
    return meta?.label || '';
  },

  countMatches(items, context = null) {
    const ctx = this.normalizeSortContext(context);
    return items.reduce((n, item) => n + (this.metaForItem(item, ctx).match ? 1 : 0), 0);
  },

  sortItems(items, context = null) {
    const ctx = this.normalizeSortContext(context);
    return [...items].sort((a, b) => {
      const ma = this.metaForItem(a, ctx).sortKey;
      const mb = this.metaForItem(b, ctx).sortKey;
      return this.compareSortKeys(ma, mb);
    });
  },

  sortItemsByRegex(items, regexStr) {
    return this.sortItems(items, { sortMode: 'regex', regex: regexStr });
  },
};
