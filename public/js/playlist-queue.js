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
  },

  applyProgress(progressList) {
    if (!Array.isArray(progressList)) return;
    for (const p of progressList) {
      this.progressMap.set(p.file_id, {
        progress_pct: p.progress_pct || 0,
        completed: !!p.completed,
        position_seconds: p.position_seconds || 0,
      });
    }
  },

  getProgress(fileId) {
    return this.progressMap.get(fileId) || { progress_pct: 0, completed: false, position_seconds: 0 };
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

  setProgress(fileId, data) {
    this.progressMap.set(fileId, { ...this.getProgress(fileId), ...data });
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
    if (!this.playlistId || this.isPublic) return;
    this.setProgress(fileId, { position_seconds, progress_pct, completed });
    try {
      await API.playlists.saveProgress(this.playlistId, {
        file_id: fileId,
        position_seconds,
        progress_pct,
        completed: completed ? 1 : 0,
      });
    } catch { /* ignore */ }
  },
};
