/**
 * Playlist queue — next/prev/shuffle/repeat for any media type
 */
const PlaylistQueue = {
  items: [],
  index: -1,
  shuffle: false,
  repeat: 'off',
  autoplay: true,
  shuffledOrder: [],
  playlistId: null,
  playlistTitle: '',
  collectionId: null,
  isPublic: false,
  publicToken: null,
  progressMap: new Map(),
  SEEN_THRESHOLD: 90,

  isSeen(prog) {
    if (!prog) return false;
    return !!(prog.completed || (prog.progress_pct >= this.SEEN_THRESHOLD));
  },

  loadPublicProgress(token) {
    if (!token || typeof PlaybackMemory === 'undefined') return;
    const prefix = PlaybackMemory.publicPrefix + token + ':';
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(prefix)) continue;
      const fileId = k.slice(prefix.length);
      const data = PlaybackMemory.normalizeProgress(PlaybackMemory.read(k));
      if (data.progress_pct > 0 || data.completed) {
        this.progressMap.set(fileId, this.mergeProgressEntry(this.getProgress(fileId), data));
      }
    }
  },

  mergeProgressEntry(a, b) {
    const base = { progress_pct: 0, completed: false, position_seconds: 0, ...a };
    const other = { progress_pct: 0, completed: false, position_seconds: 0, ...b };
    if (this.isSeen(other) && !this.isSeen(base)) {
      return { ...other, progress_pct: Math.max(other.progress_pct, 100) };
    }
    if (this.isSeen(base) && !this.isSeen(other)) return base;
    if ((other.progress_pct || 0) > (base.progress_pct || 0)) {
      return { ...base, ...other, progress_pct: other.progress_pct };
    }
    if ((other.progress_pct || 0) === (base.progress_pct || 0)
      && (other.position_seconds || 0) > (base.position_seconds || 0)) {
      return { ...base, position_seconds: other.position_seconds };
    }
    return base;
  },

  readStoredProgressForItem(fileId) {
    if (typeof PlaybackMemory === 'undefined') {
      return { progress_pct: 0, completed: false, position_seconds: 0 };
    }
    const sources = [];
    if (this.playlistId) {
      sources.push(PlaybackMemory.read(PlaybackMemory.storageKey(fileId, this.playlistId)));
    }
    if (this.isPublic && this.publicToken) {
      sources.push(PlaybackMemory.read(PlaybackMemory.publicKey(this.publicToken, fileId)));
    }
    sources.push(PlaybackMemory.read(PlaybackMemory.storageKey(fileId)));
    let best = { progress_pct: 0, completed: false, position_seconds: 0 };
    for (const raw of sources) {
      const norm = PlaybackMemory.normalizeProgress(raw);
      if (norm.progress_pct > 0 || norm.completed) {
        best = this.mergeProgressEntry(best, norm);
      }
    }
    return best;
  },

  loadStoredProgress() {
    for (const item of this.items) {
      const stored = this.readStoredProgressForItem(item.id);
      if (stored.progress_pct > 0 || stored.completed) {
        this.progressMap.set(item.id, this.mergeProgressEntry(this.getProgress(item.id), stored));
      }
    }
  },

  reset() {
    this.items = [];
    this.index = -1;
    this.shuffle = false;
    this.repeat = 'off';
    this.autoplay = true;
    this.shuffledOrder = [];
    this.playlistId = null;
    this.playlistTitle = '';
    this.collectionId = null;
    this.isPublic = false;
    this.publicToken = null;
    this.progressMap = new Map();
  },

  setFromPlaylist(playlist, startFileId, { isPublic = false, publicToken = null } = {}) {
    this.reset();
    this.playlistId = playlist.id;
    this.playlistTitle = playlist.title || 'Playlist';
    this.isPublic = isPublic;
    this.publicToken = publicToken;
    this.items = (playlist.items || []).filter((f) => !f.is_folder);
    for (const item of this.items) {
      if (item.progress_pct != null || item.completed) {
        this.progressMap.set(item.id, {
          progress_pct: item.progress_pct || 0,
          completed: !!item.completed,
          position_seconds: item.position_seconds || 0,
        });
      }
    }
    this.index = startFileId
      ? this.items.findIndex((f) => f.id === startFileId)
      : 0;
    if (this.index < 0) this.index = 0;
    this.shuffledOrder = this.items.map((_, i) => i);
    this.loadStoredProgress();
  },

  applyProgress(progressList) {
    if (!Array.isArray(progressList)) return;
    for (const p of progressList) {
      this.progressMap.set(p.file_id, this.mergeProgressEntry(this.getProgress(p.file_id), {
        progress_pct: p.progress_pct || 0,
        completed: !!p.completed,
        position_seconds: p.position_seconds || 0,
      }));
    }
  },

  getProgress(fileId) {
    const cached = this.progressMap.get(fileId);
    if (cached && (cached.progress_pct > 0 || cached.completed)) return cached;
    if (typeof PlaybackMemory !== 'undefined') {
      const stored = this.readStoredProgressForItem(fileId);
      if (stored.progress_pct > 0 || stored.completed) {
        const merged = this.mergeProgressEntry(cached || {}, stored);
        this.progressMap.set(fileId, merged);
        return merged;
      }
    }
    return cached || { progress_pct: 0, completed: false, position_seconds: 0 };
  },

  itemLabel(file) {
    if (!file) return '';
    const custom = file.display_name?.trim();
    return custom || file.name || '';
  },

  itemSearchText(file) {
    if (!file) return '';
    return `${this.itemLabel(file)} ${file.name || ''}`.toLowerCase();
  },

  formatHlsDuration(seconds) {
    if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return '';
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  },

  itemDurationLabel(file) {
    const dur = Number(file?.hls_duration_sec) || 0;
    if (dur > 0) return this.formatHlsDuration(dur);
    return '';
  },

  totalHlsDuration(items = this.items) {
    return (items || []).reduce((sum, file) => sum + (Number(file.hls_duration_sec) || 0), 0);
  },

  itemMetaParts(file, index) {
    const parts = [`${index + 1}`];
    const duration = this.itemDurationLabel(file);
    if (duration) parts.push(duration);
    else if (Number(file?.has_hls) > 0 || Number(file?.hls_segment_count) > 0) parts.push('HLS');
    if (file?.size) parts.push(formatSize(file.size));
    return parts;
  },

  setProgress(fileId, data) {
    const merged = { ...this.getProgress(fileId), ...data };
    if (merged.completed || merged.progress_pct >= this.SEEN_THRESHOLD) {
      merged.completed = true;
      merged.progress_pct = Math.max(merged.progress_pct, 100);
    }
    this.progressMap.set(fileId, merged);
  },

  progressRingSvg(prog) {
    const seen = this.isSeen(prog);
    const pct = seen ? 100 : Math.min(100, Math.max(0, prog.progress_pct || 0));
    const r = 16;
    const c = 2 * Math.PI * r;
    const dash = (pct / 100) * c;
    return `<svg class="playlist-queue-ring" viewBox="0 0 36 36" aria-hidden="true">
      <circle class="playlist-queue-ring-bg" cx="18" cy="18" r="${r}" fill="none" stroke-width="2.5"/>
      <circle class="playlist-queue-ring-fill${seen ? ' is-complete' : ''}" cx="18" cy="18" r="${r}" fill="none" stroke-width="2.5"
        stroke-dasharray="${dash.toFixed(2)} ${c.toFixed(2)}" stroke-linecap="round" transform="rotate(-90 18 18)"/>
    </svg>`;
  },

  decorateQueueRow(row, file, idx, { currentId = null } = {}) {
    const prog = this.getProgress(file.id);
    row.dataset.fileId = file.id;
    row.classList.toggle('is-active', currentId === file.id);
    row.classList.toggle('is-seen', this.isSeen(prog));
    row.classList.toggle('is-completed', this.isSeen(prog));
    row.classList.toggle('is-in-progress', !this.isSeen(prog) && prog.progress_pct >= 3);
    return prog;
  },

  appendQueueProgress(body, prog) {
    if (this.isSeen(prog)) {
      const badge = document.createElement('span');
      badge.className = 'playlist-queue-seen-badge';
      badge.title = 'Watched';
      badge.setAttribute('aria-label', 'Watched');
      badge.textContent = '✓';
      body.appendChild(badge);
      return;
    }
    if (prog.progress_pct >= 3) {
      const bar = document.createElement('div');
      bar.className = 'playlist-queue-progress';
      bar.style.setProperty('--progress', `${Math.min(100, prog.progress_pct)}%`);
      body.appendChild(bar);
    }
  },

  current() {
    if (!this.items.length || this.index < 0) return null;
    return this.items[this.index];
  },

  hasQueue() {
    return this.items.length > 1;
  },

  next() {
    if (!this.items.length) return null;
    if (this.shuffle) {
      const pos = this.shuffledOrder.indexOf(this.index);
      const nextPos = (pos + 1) % this.shuffledOrder.length;
      this.index = this.shuffledOrder[nextPos];
    } else if (this.index < this.items.length - 1) {
      this.index += 1;
    } else if (this.repeat === 'all') {
      this.index = 0;
    } else {
      return null;
    }
    return this.current();
  },

  previous() {
    if (!this.items.length) return null;
    if (this.shuffle) {
      const pos = this.shuffledOrder.indexOf(this.index);
      const prevPos = (pos - 1 + this.shuffledOrder.length) % this.shuffledOrder.length;
      this.index = this.shuffledOrder[prevPos];
    } else if (this.index > 0) {
      this.index -= 1;
    } else if (this.repeat === 'all') {
      this.index = this.items.length - 1;
    } else {
      return null;
    }
    return this.current();
  },

  goTo(fileId) {
    const idx = this.items.findIndex((f) => f.id === fileId);
    if (idx < 0) return null;
    this.index = idx;
    return this.current();
  },

  toggleShuffle() {
    this.shuffle = !this.shuffle;
    if (this.shuffle) {
      this.shuffledOrder = this.items.map((_, i) => i);
      for (let i = this.shuffledOrder.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [this.shuffledOrder[i], this.shuffledOrder[j]] = [this.shuffledOrder[j], this.shuffledOrder[i]];
      }
    }
    return this.shuffle;
  },

  cycleRepeat() {
    const modes = ['off', 'all', 'one'];
    const idx = modes.indexOf(this.repeat);
    this.repeat = modes[(idx + 1) % modes.length];
    return this.repeat;
  },

  toggleAutoplay() {
    this.autoplay = !this.autoplay;
    return this.autoplay;
  },

  async persistProgress(fileId, { position_seconds, progress_pct, completed }) {
    const seen = completed || progress_pct >= this.SEEN_THRESHOLD;
    const payload = {
      position_seconds: seen ? 0 : position_seconds,
      progress_pct: seen ? 100 : progress_pct,
      completed: seen,
    };
    this.setProgress(fileId, payload);

    if (this.isPublic && this.publicToken && typeof PlaybackMemory !== 'undefined') {
      PlaybackMemory.write(PlaybackMemory.publicKey(this.publicToken, fileId), payload);
      return;
    }
    if (!this.playlistId) return;
    try {
      await API.playlists.saveProgress(this.playlistId, {
        file_id: fileId,
        position_seconds: payload.position_seconds,
        progress_pct: payload.progress_pct,
        completed: payload.completed ? 1 : 0,
      });
    } catch { /* ignore */ }
  },
};

PlaylistQueue.VERSION = '1.0.3';

/** Backfill helpers if an older cached playlist-queue.js loaded first. */
PlaylistQueue.ensureUiHelpers = function ensureUiHelpers() {
  if (this.decorateQueueRow) return;
  this.SEEN_THRESHOLD = this.SEEN_THRESHOLD || 90;
  this.isSeen = this.isSeen || function isSeen(prog) {
    if (!prog) return false;
    return !!(prog.completed || prog.progress_pct >= this.SEEN_THRESHOLD);
  };
  this.decorateQueueRow = function decorateQueueRow(row, file, idx, { currentId = null } = {}) {
    const prog = this.getProgress(file.id);
    row.dataset.fileId = file.id;
    row.classList.toggle('is-active', currentId === file.id);
    row.classList.toggle('is-seen', this.isSeen(prog));
    row.classList.toggle('is-completed', this.isSeen(prog));
    row.classList.toggle('is-in-progress', !this.isSeen(prog) && prog.progress_pct >= 3);
    return prog;
  };
  this.progressRingSvg = this.progressRingSvg || function progressRingSvg(prog) {
    const seen = this.isSeen(prog);
    const pct = seen ? 100 : Math.min(100, Math.max(0, prog?.progress_pct || 0));
    const r = 16;
    const c = 2 * Math.PI * r;
    const dash = (pct / 100) * c;
    return `<svg class="playlist-queue-ring" viewBox="0 0 36 36" aria-hidden="true">
      <circle class="playlist-queue-ring-bg" cx="18" cy="18" r="${r}" fill="none" stroke-width="2.5"/>
      <circle class="playlist-queue-ring-fill${seen ? ' is-complete' : ''}" cx="18" cy="18" r="${r}" fill="none" stroke-width="2.5"
        stroke-dasharray="${dash.toFixed(2)} ${c.toFixed(2)}" stroke-linecap="round" transform="rotate(-90 18 18)"/>
    </svg>`;
  };
  this.appendQueueProgress = this.appendQueueProgress || function appendQueueProgress(body, prog) {
    if (this.isSeen(prog)) {
      const badge = document.createElement('span');
      badge.className = 'playlist-queue-seen-badge';
      badge.title = 'Watched';
      badge.setAttribute('aria-label', 'Watched');
      badge.textContent = '✓';
      body.appendChild(badge);
      return;
    }
    if (prog.progress_pct >= 3) {
      const bar = document.createElement('div');
      bar.className = 'playlist-queue-progress';
      bar.style.setProperty('--progress', `${Math.min(100, prog.progress_pct)}%`);
      body.appendChild(bar);
    }
  };
};

PlaylistQueue.ensureUiHelpers();
