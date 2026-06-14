const EpisodeMeta = {
  parse(rawTitle) {
    const title = String(rawTitle || '').trim();
    if (!title) {
      return { season: null, episode: null, match: false, label: null };
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

    let label = null;
    if (match) {
      if (season != null && episode != null) {
        label = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
      } else if (episode != null) {
        label = `Ep ${episode}`;
      }
    }

    return { season, episode, match, label };
  },

  formatLabel(meta) {
    return meta?.label || '';
  },

  sortItems(items) {
    return [...items].sort((a, b) => {
      const ta = a.display_name || a.name || '';
      const tb = b.display_name || b.name || '';
      const ma = this.parse(ta);
      const mb = this.parse(tb);
      const ka = [ma.season ?? 9999, ma.episode ?? 9999, ta.toLowerCase()];
      const kb = [mb.season ?? 9999, mb.episode ?? 9999, tb.toLowerCase()];
      for (let i = 0; i < 3; i += 1) {
        if (ka[i] < kb[i]) return -1;
        if (ka[i] > kb[i]) return 1;
      }
      return 0;
    });
  },
};
