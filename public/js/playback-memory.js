/**
 * Resume playback + watch progress (localStorage + playlist sync).
 */
const PlaybackMemory = {
  maxEntries: 300,
  prefix: 'vault-playback:',
  publicPrefix: 'vault-pl-public:',
  SEEN_THRESHOLD: 90,
  SAVE_INTERVAL_MS: 2500,

  storageKey(fileId, playlistId = null) {
    if (playlistId) return `${this.prefix}pl:${playlistId}:${fileId}`;
    return `${this.prefix}${fileId}`;
  },

  publicKey(token, fileId) {
    return `${this.publicPrefix}${token}:${fileId}`;
  },

  effectiveDuration(file, el, status = null) {
    const hls = Number(file?.hls_duration_sec);
    if (hls > 0) return hls;
    if (status?.duration_sec > 0) return status.duration_sec;
    if (el?.duration && Number.isFinite(el.duration) && el.duration > 0) return el.duration;
    return 0;
  },

  computeProgress(currentTime, duration) {
    if (!duration || duration <= 0 || !Number.isFinite(currentTime)) {
      return { position_seconds: 0, progress_pct: 0, completed: false };
    }
    const pct = Math.min(100, (currentTime / duration) * 100);
    return {
      position_seconds: currentTime,
      progress_pct: pct,
      completed: pct >= this.SEEN_THRESHOLD,
    };
  },

  read(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  },

  write(key, data) {
    try {
      localStorage.setItem(key, JSON.stringify({ ...data, ts: Date.now() }));
      this.evictOld();
    } catch { /* quota */ }
  },

  removeKey(key) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  },

  normalizeProgress(raw) {
    if (!raw) return { position_seconds: 0, progress_pct: 0, completed: false };
    const pct = raw.progress_pct ?? raw.pct ?? 0;
    const completed = !!(raw.completed ?? raw.seen ?? (pct >= this.SEEN_THRESHOLD));
    return {
      position_seconds: raw.position_seconds ?? raw.pos ?? 0,
      progress_pct: completed ? Math.max(pct, 100) : pct,
      completed,
    };
  },

  getProgress(fileId, { playlistId = null, publicToken = null } = {}) {
    if (typeof PlaylistQueue !== 'undefined' && playlistId && PlaylistQueue.playlistId === playlistId) {
      const queued = PlaylistQueue.getProgress(fileId);
      if (queued.progress_pct > 0 || queued.completed) return queued;
    }

    if (publicToken) {
      const pub = this.normalizeProgress(this.read(this.publicKey(publicToken, fileId)));
      if (pub.progress_pct > 0 || pub.completed) return pub;
    }

    const key = this.storageKey(fileId, playlistId);
    return this.normalizeProgress(this.read(key));
  },

  getResumePosition(file, el, context = {}) {
    const prog = this.getProgress(file.id, context);
    if (prog.completed) return 0;
    const pos = prog.position_seconds || 0;
    if (pos < 5) return 0;
    const dur = this.effectiveDuration(file, el, context.status);
    if (dur > 0 && pos >= dur - 5) return 0;
    return pos;
  },

  evictOld() {
    const entries = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(this.prefix) && !k?.startsWith(this.publicPrefix)) continue;
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
    for (let i = 0; i < remove; i++) this.removeKey(entries[i].k);
  },

  _bindings: new WeakMap(),

  detach(el) {
    if (!el) return;
    const binding = this._bindings.get(el);
    if (!binding) return;
    binding.flush?.();
    binding.cleanup?.();
    el.removeEventListener('timeupdate', binding.save);
    el.removeEventListener('pause', binding.flush);
    el.removeEventListener('ended', binding.onEnded);
    this._bindings.delete(el);
  },

  track(el, file, context = {}) {
    if (!el || !file?.id) return;
    this.detach(el);

    const ctx = {
      playlistId: context.playlistId ?? (typeof PlaylistQueue !== 'undefined' ? PlaylistQueue.playlistId : null),
      publicToken: context.publicToken ?? (typeof PlaylistQueue !== 'undefined' && PlaylistQueue.isPublic ? PlaylistQueue.publicToken : null),
      status: context.status ?? null,
      onProgressUpdate: context.onProgressUpdate ?? null,
    };

    const resume = () => {
      const pos = this.getResumePosition(file, el, ctx);
      if (pos <= 0) return;
      const seek = () => {
        const dur = this.effectiveDuration(file, el, ctx.status);
        if (!dur || pos < dur - 3) el.currentTime = pos;
      };
      if (el.readyState >= 1) seek();
      else el.addEventListener('loadedmetadata', seek, { once: true });
    };
    resume();

    let lastSave = 0;
    let lastPct = -1;
    let lastCompleted = false;

    const store = (prog, force = false) => {
      const now = Date.now();
      if (!force && prog.completed === lastCompleted && Math.abs(prog.progress_pct - lastPct) < 0.5) {
        if (now - lastSave < this.SAVE_INTERVAL_MS) return;
      }
      lastSave = now;
      lastPct = prog.progress_pct;
      lastCompleted = prog.completed;

      const localKey = this.storageKey(file.id, ctx.playlistId);
      if (prog.completed) {
        this.write(localKey, { pos: 0, pct: 100, completed: true, seen: true });
      } else if (prog.position_seconds >= 5) {
        this.write(localKey, {
          pos: prog.position_seconds,
          pct: prog.progress_pct,
          completed: false,
        });
      }

      if (ctx.publicToken) {
        this.write(this.publicKey(ctx.publicToken, file.id), prog);
      }

      if (ctx.playlistId && typeof PlaylistQueue !== 'undefined') {
        PlaylistQueue.setProgress(file.id, prog);
        PlaylistQueue.persistProgress(file.id, prog);
      }

      ctx.onProgressUpdate?.(file.id, prog);
    };

    const persist = (force = false) => {
      const dur = this.effectiveDuration(file, el, ctx.status);
      const prog = dur > 0
        ? this.computeProgress(el.currentTime, dur)
        : { position_seconds: el.currentTime, progress_pct: 0, completed: false };
      if (!force && dur <= 0 && el.currentTime < 5) return;
      store(prog, force);
    };

    const save = () => persist(false);
    const flush = () => persist(true);
    const onEnded = () => {
      const dur = this.effectiveDuration(file, el, ctx.status) || el.currentTime;
      store({ position_seconds: dur, progress_pct: 100, completed: true }, true);
    };

    const onHide = () => flush();
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', onHide);

    el.addEventListener('timeupdate', save);
    el.addEventListener('pause', flush);
    el.addEventListener('ended', onEnded);

    this._bindings.set(el, {
      save,
      flush,
      onEnded,
      cleanup: () => {
        document.removeEventListener('visibilitychange', onHide);
        window.removeEventListener('pagehide', onHide);
      },
    });
  },

  /** Legacy: resume position only */
  get(fileId) {
    return this.getProgress(fileId).position_seconds || 0;
  },

  set(fileId, position, duration) {
    const prog = this.computeProgress(position, duration);
    this.write(this.storageKey(fileId), {
      pos: prog.completed ? 0 : position,
      pct: prog.progress_pct,
      completed: prog.completed,
    });
  },

  remove(fileId, playlistId = null) {
    this.removeKey(this.storageKey(fileId, playlistId));
  },

  apply(el, fileId, file = null) {
    this.track(el, file || { id: fileId });
  },
};
