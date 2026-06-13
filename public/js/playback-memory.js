/**
 * Resume playback positions for video/audio (localStorage LRU).
 */
const PlaybackMemory = {
  maxEntries: 200,
  prefix: 'vault-playback:',

  key(fileId) {
    return `${this.prefix}${fileId}`;
  },

  get(fileId) {
    try {
      const raw = localStorage.getItem(this.key(fileId));
      if (!raw) return 0;
      const data = JSON.parse(raw);
      return typeof data.pos === 'number' ? data.pos : 0;
    } catch {
      return 0;
    }
  },

  set(fileId, position, duration) {
    if (!fileId || !Number.isFinite(position) || position < 5) return;
    if (duration && position > duration - 10) {
      this.remove(fileId);
      return;
    }
    try {
      localStorage.setItem(this.key(fileId), JSON.stringify({
        pos: position,
        ts: Date.now(),
        dur: duration || null,
      }));
      this.evictOld();
    } catch { /* quota */ }
  },

  remove(fileId) {
    try { localStorage.removeItem(this.key(fileId)); } catch { /* ignore */ }
  },

  evictOld() {
    const entries = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(this.prefix)) continue;
      try {
        const data = JSON.parse(localStorage.getItem(k));
        entries.push({ k, ts: data.ts || 0 });
      } catch {
        entries.push({ k, ts: 0 });
      }
    }
    if (entries.length <= this.maxEntries) return;
    entries.sort((a, b) => a.ts - b.ts);
    const remove = entries.length - this.maxEntries;
    for (let i = 0; i < remove; i++) localStorage.removeItem(entries[i].k);
  },

  _bindings: new WeakMap(),

  detach(el) {
    if (!el) return;
    const binding = this._bindings.get(el);
    if (!binding) return;
    el.removeEventListener('timeupdate', binding.save);
    el.removeEventListener('pause', binding.save);
    el.removeEventListener('ended', binding.onEnded);
    this._bindings.delete(el);
  },

  apply(el, fileId) {
    if (!el || !fileId) return;
    this.detach(el);
    const pos = this.get(fileId);
    if (pos > 0) {
      const seek = () => {
        if (el.duration && pos < el.duration - 5) {
          el.currentTime = pos;
        }
      };
      if (el.readyState >= 1) seek();
      else el.addEventListener('loadedmetadata', seek, { once: true });
    }
    let lastSave = 0;
    const save = () => {
      const now = Date.now();
      if (now - lastSave < 3000) return;
      lastSave = now;
      this.set(fileId, el.currentTime, el.duration);
    };
    const onEnded = () => this.remove(fileId);
    el.addEventListener('timeupdate', save);
    el.addEventListener('pause', save);
    el.addEventListener('ended', onEnded);
    this._bindings.set(el, { save, onEnded });
  },
};
