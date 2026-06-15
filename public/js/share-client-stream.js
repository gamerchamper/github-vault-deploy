const ShareClientStream = {
  CHUNK_ON_DISK: Symbol('chunk-on-disk'),

  token: null,
  fileId: null,
  manifest: null,
  fileKey: null,
  chunks: null,
  completed: 0,
  pool: null,
  abortController: null,
  blobUrl: null,
  cachedEntry: null,
  cacheHit: false,
  offline: false,
  serverOffline: false,
  stream: null,
  playlistMode: false,

  apiBase(token) {
    return this.playlistMode
      ? `/api/public/playlist/${token}`
      : `/api/public/share/${token}`;
  },

  mediaKind() {
    const mime = this.blobType();
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('video/') || mime.startsWith('audio/')) return 'media';
    return 'other';
  },

  chunkStarts() {
    if (this._chunkStarts) return this._chunkStarts;
    const starts = [];
    let off = 0;
    for (const c of this.manifest?.chunks || []) {
      starts.push(off);
      off += c.plain_size || 0;
    }
    this._chunkStarts = starts;
    return starts;
  },

  chunkIndexForByte(byte) {
    const starts = this.chunkStarts();
    if (!starts.length) return 0;
    const total = this.manifest?.size || 0;
    const b = Math.max(0, Math.min(byte, Math.max(0, total - 1)));
    for (let i = starts.length - 1; i >= 0; i--) {
      if (b >= starts[i]) return i;
    }
    return 0;
  },

  chunkIndexForTime(timeSec, durationSec) {
    if (!durationSec || !Number.isFinite(durationSec) || durationSec <= 0) return 0;
    const byte = (timeSec / durationSec) * (this.manifest?.size || 0);
    return this.chunkIndexForByte(byte);
  },

  lookAheadChunks() {
    return this.isLowMemoryDevice() ? 3 : 6;
  },

  initialPrefetchChunks() {
    return this.isLowMemoryDevice() ? 2 : 4;
  },

  mseMimeCandidates() {
    const ext = (this.manifest?.name || '').split('.').pop().toLowerCase();
    const mime = this.blobType();
    const list = [];
    if (mime.startsWith('video/') || ['mp4', 'm4v', 'mov', 'webm', 'mkv'].includes(ext)) {
      list.push('video/mp4; codecs="avc1.42E01E, mp4a.40.2"', 'video/mp4', 'video/webm; codecs="vp9, opus"', 'video/webm');
    }
    if (mime.startsWith('audio/') || ['mp3', 'm4a', 'wav', 'ogg', 'flac'].includes(ext)) {
      list.push('audio/mp4; codecs="mp4a.40.2"', 'audio/mpeg', 'audio/mp4', 'audio/webm; codecs="opus"');
    }
    if (mime && mime !== 'application/octet-stream') list.push(mime);
    return [...new Set(list)];
  },

  canUseMse() {
    if (!window.MediaSource) return false;
    return !!this.mseMimeType();
  },

  mseMimeType() {
    if (this._mseMime) return this._mseMime;
    for (const mime of this.mseMimeCandidates()) {
      if (MediaSource.isTypeSupported(mime)) {
        this._mseMime = mime;
        return mime;
      }
    }
    return null;
  },

  bytesContainMoov(bytes) {
    if (!bytes || bytes.length < 8) return false;
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const scan = Math.min(view.length, 512 * 1024);
    for (let i = 0; i < scan - 3; i++) {
      if (view[i] === 0x6d && view[i + 1] === 0x6f && view[i + 2] === 0x6f && view[i + 3] === 0x76) {
        return true;
      }
    }
    return false;
  },

  stopStreamPump() {
    if (this.stream?.pumpTimer) {
      clearInterval(this.stream.pumpTimer);
      this.stream.pumpTimer = null;
    }
    if (this.stream?.onTimeupdate) {
      this.stream.mediaEl?.removeEventListener('timeupdate', this.stream.onTimeupdate);
      this.stream.mediaEl?.removeEventListener('seeking', this.stream.onSeeking);
    }
  },

  log(level, event, data) {
    if (typeof ShareStreamLog !== 'undefined') ShareStreamLog[level](event, data);
  },

  resetStream(options = {}) {
    const force = options.force === true;
    if (this._streamProtected && !force) {
      this.log('warn', 'stream:reset-blocked', {
        appendIndex: this.stream?.appendIndex,
        mseUrl: this.stream?.mseUrl?.slice(0, 64) || null,
      });
      return;
    }
    this.log('info', 'stream:reset', {
      force,
      hadStream: !!this.stream,
      mseUrl: this.stream?.mseUrl?.slice(0, 64) || null,
    });
    this.stopStreamPump();
    if (this.stream?.mseUrl) {
      URL.revokeObjectURL(this.stream.mseUrl);
    }
    if (this.stream?.mediaSource && this.stream.mediaSource.readyState === 'open') {
      try { this.stream.mediaSource.endOfStream(); } catch { /* ignore */ }
    }
    this.stream = null;
    this._chunkStarts = null;
  },

  getStreamStatus() {
    const total = this.manifest?.chunks?.length || 0;
    const appendIndex = this.stream?.appendIndex || 0;
    const appendedBytes = this.stream?.appendedBytes || 0;
    const done = appendIndex >= total && total > 0;
    return {
      stage: done ? 'ready' : 'streaming',
      segments: appendIndex,
      total_segments: total,
      bytes_ready: appendedBytes,
      progress: total > 0 ? Math.round((appendIndex / total) * 100) : 0,
      mode: 'client',
      ready: done,
      buffered: this.stream?.startedPlay || done,
      client_stream: true,
      cache_hit: this.cacheHit,
      offline: this.offline,
      activeIndex: this.stream?.activeFetch ?? appendIndex,
    };
  },

  updateFetchHorizon(mediaEl) {
    if (!this.stream) return;
    const total = this.manifest.chunks.length;
    let horizon = this.stream.appendIndex + this.initialPrefetchChunks();

    const dur = mediaEl.duration;
    const t = mediaEl.currentTime || 0;
    if (dur && Number.isFinite(dur) && dur > 0) {
      const playChunk = this.chunkIndexForTime(t, dur);
      horizon = Math.max(horizon, playChunk + this.lookAheadChunks());
    }

    if (this.stream.needTailMoov && this.stream.appendIndex >= total - 2) {
      horizon = total - 1;
    }

    this.stream.fetchHorizon = Math.min(total - 1, Math.max(horizon, this.stream.appendIndex));
  },

  scheduleChunkFetch(index) {
    if (!this.stream || index < 0 || index >= this.manifest.chunks.length) return;
    if (this.isChunkReady(index) || this.stream.inFlight.has(index)) return;
    this.stream.inFlight.add(index);
    this.stream.activeFetch = index;
    this.fetchOne(index)
      .then(() => {
        this.stream.inFlight.delete(index);
      })
      .catch((err) => {
        this.stream.inFlight.delete(index);
        if (!this.stream.error) this.stream.error = err;
        this.log('error', 'stream:fetch-failed', { index, message: err.message });
      });
  },

  waitSourceBuffer(sb) {
    return new Promise((resolve, reject) => {
      if (!sb.updating) {
        resolve();
        return;
      }
      const onEnd = () => {
        sb.removeEventListener('updateend', onEnd);
        sb.removeEventListener('error', onErr);
        resolve();
      };
      const onErr = () => {
        sb.removeEventListener('updateend', onEnd);
        sb.removeEventListener('error', onErr);
        reject(new Error('Media buffer error'));
      };
      sb.addEventListener('updateend', onEnd);
      sb.addEventListener('error', onErr);
    });
  },

  async appendToSource(bytes) {
    const sb = this.stream.sourceBuffer;
    await this.waitSourceBuffer(sb);
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    return new Promise((resolve, reject) => {
      const onEnd = () => {
        sb.removeEventListener('updateend', onEnd);
        sb.removeEventListener('error', onErr);
        resolve();
      };
      const onErr = () => {
        sb.removeEventListener('updateend', onEnd);
        sb.removeEventListener('error', onErr);
        reject(new Error('Failed to append media chunk'));
      };
      sb.addEventListener('updateend', onEnd);
      sb.addEventListener('error', onErr);
      try {
        sb.appendBuffer(data);
      } catch (err) {
        sb.removeEventListener('updateend', onEnd);
        sb.removeEventListener('error', onErr);
        reject(err);
      }
    });
  },

  async pumpStream() {
    if (!this.stream || this.stream.stopped) return;
    if (this.stream.error) return;

    const total = this.manifest.chunks.length;
    const { fetchHorizon } = this.stream;

    for (let i = this.stream.appendIndex; i <= fetchHorizon; i++) {
      this.scheduleChunkFetch(i);
    }

    if (this.stream.needTailMoov && this.stream.appendIndex === 0 && !this.stream.tailScheduled) {
      this.stream.tailScheduled = true;
      this.scheduleChunkFetch(total - 1);
    }

    while (this.stream.appendIndex < total && this.isChunkReady(this.stream.appendIndex)) {
      const idx = this.stream.appendIndex;
      const bytes = await this.getChunkBytes(idx);
      if (!bytes) break;

      if (idx === 0 && !this.bytesContainMoov(bytes)) {
        this.stream.needTailMoov = true;
      }

      await this.appendToSource(bytes);
      this.stream.appendedBytes += bytes.byteLength || bytes.length;

      if (this.isLowMemoryDevice()) {
        await this.persistChunkToCache(idx);
      }

      this.stream.appendIndex = idx + 1;
      this.syncCompleted();
      this.onProgress(this.getStreamStatus());

      if (!this.stream.startedPlay && this.stream.mediaEl.readyState >= 2) {
        this.stream.startedPlay = true;
        this.stream.mediaEl.play().catch(() => {});
      }
    }

    if (this.stream.appendIndex >= total && this.stream.mediaSource.readyState === 'open') {
      try {
        this.stream.mediaSource.endOfStream();
      } catch { /* already ended */ }
      this.onProgress(this.getStreamStatus());
    }
  },

  async playMediaProgressive(mediaEl, wrap = null) {
    if (this.cacheHit && this.cachedEntry?.blob) {
      return this.playMediaBlob(mediaEl, wrap);
    }

    const mime = this.mseMimeType();
    if (!mime) throw new Error('Progressive playback not supported in this browser');

    this.log('info', 'playback:mse-start', { mime, chunks: this.manifest.chunks.length });
    this.resetStream({ force: true });
    this.prepareMediaElement(mediaEl, wrap);

    const mediaSource = new MediaSource();
    const mseUrl = URL.createObjectURL(mediaSource);
    mediaEl.src = mseUrl;

    this.stream = {
      mediaSource,
      mseUrl,
      sourceBuffer: null,
      mediaEl,
      appendIndex: 0,
      appendedBytes: 0,
      fetchHorizon: 0,
      inFlight: new Set(),
      activeFetch: 0,
      needTailMoov: false,
      tailScheduled: false,
      startedPlay: false,
      stopped: false,
      error: null,
    };

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Media source failed to open')), 15000);
      mediaSource.addEventListener('sourceopen', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      mediaSource.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('Media source error'));
      }, { once: true });
    });

    this.stream.sourceBuffer = mediaSource.addSourceBuffer(mime);
    this.stream.sourceBuffer.mode = 'segments';

    this.updateFetchHorizon(mediaEl);
    this.stream.onTimeupdate = () => this.updateFetchHorizon(mediaEl);
    this.stream.onSeeking = () => {
      const dur = mediaEl.duration;
      if (dur && Number.isFinite(dur)) {
        const seekChunk = this.chunkIndexForTime(mediaEl.currentTime, dur);
        this.stream.fetchHorizon = Math.min(
          this.manifest.chunks.length - 1,
          Math.max(this.stream.fetchHorizon, seekChunk + this.lookAheadChunks())
        );
      }
    };
    mediaEl.addEventListener('timeupdate', this.stream.onTimeupdate);
    mediaEl.addEventListener('seeking', this.stream.onSeeking);

    this.stream.pumpTimer = setInterval(() => {
      this.pumpStream().catch((err) => {
        if (!this.stream.error) this.stream.error = err;
      });
    }, 200);

    await this.pumpStream();

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (mediaEl.readyState >= 2) resolve();
        else reject(new Error('Media failed to start — try again or use Download'));
      }, 120000);

      const tryReady = () => {
        if (this.stream?.error) {
          clearTimeout(timer);
          reject(this.stream.error);
          return;
        }
        if (mediaEl.error) {
          clearTimeout(timer);
          reject(new Error('Media decode failed'));
          return;
        }
        if (mediaEl.readyState >= 2) {
          clearTimeout(timer);
          cleanup();
          resolve();
        }
      };

      const cleanup = () => {
        mediaEl.removeEventListener('canplay', tryReady);
        mediaEl.removeEventListener('loadedmetadata', tryReady);
      };

      mediaEl.addEventListener('canplay', tryReady);
      mediaEl.addEventListener('loadedmetadata', tryReady);
      tryReady();
    });

    if (!this.stream.startedPlay) {
      await mediaEl.play().catch(() => {});
      this.stream.startedPlay = true;
    }
  },

  async playMediaBlob(mediaEl, wrap = null) {
    if (!this.cacheHit) {
      await this.fetchAllParallel();
    }
    this.prepareMediaElement(mediaEl, wrap);
    await this.setBlobUrl(mediaEl);
    mediaEl.load();
    await this.waitForMediaReady(mediaEl);
    await mediaEl.play().catch(() => {});
  },

  manifestUrl(token, fileId) {
    const qs = fileId ? `?file=${encodeURIComponent(fileId)}` : '';
    return `${this.apiBase(token)}/manifest${qs}`;
  },

  chunkUrl(index) {
    const qs = new URLSearchParams();
    if (this.fileId) qs.set('file', this.fileId);
    return `${this.apiBase(this.token)}/chunk/${index}?${qs.toString()}`;
  },

  blobType() {
    const mime = this.manifest?.mime_type || '';
    if (mime && mime !== 'application/octet-stream') return mime;
    const ext = (this.manifest?.name || '').split('.').pop().toLowerCase();
    const map = {
      mp4: 'video/mp4',
      m4v: 'video/mp4',
      mov: 'video/quicktime',
      webm: 'video/webm',
      mkv: 'video/x-matroska',
      mp3: 'audio/mpeg',
      m4a: 'audio/mp4',
      wav: 'audio/wav',
      ogg: 'audio/ogg',
      flac: 'audio/flac',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      webp: 'image/webp',
    };
    return map[ext] || 'application/octet-stream';
  },

  cacheKey() {
    return ShareMediaCache.cacheKey(this.token, this.fileId);
  },

  cacheFingerprint() {
    return ShareMediaCache.fingerprint(this.manifest);
  },

  hasCachedBlob() {
    return !!this.cachedEntry?.blob;
  },

  isLowMemoryDevice() {
    if (this._lowMemory != null) return this._lowMemory;
    const ua = navigator.userAgent || '';
    const ios = /iPhone|iPad|iPod/i.test(ua);
    const android = /Android/i.test(ua);
    const smallRam = typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 4;
    this._lowMemory = ios || android || smallRam;
    return this._lowMemory;
  },

  isChunkReady(index) {
    const entry = this.chunks?.[index];
    return entry === this.CHUNK_ON_DISK || (entry != null && entry !== undefined);
  },

  async getChunkBytes(index) {
    const entry = this.chunks[index];
    if (entry && entry !== this.CHUNK_ON_DISK) return entry;
    const cached = await ShareMediaCache.getChunk(this.cacheKey(), index);
    if (!cached) {
      this.log('warn', 'chunk:cache-miss', { index, onDisk: entry === this.CHUNK_ON_DISK });
    }
    return cached;
  },

  fetchConcurrency() {
    if (this.isLowMemoryDevice()) return { max: 2, initial: 1 };
    return { max: 16, initial: 8 };
  },

  async fetchManifestFromNetwork() {
    const res = await fetch(this.manifestUrl(this.token, this.fileId), {
      signal: this.fetchSignal(),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Failed to load share manifest');
    }
    return res.json();
  },

  async restoreCachedChunks() {
    const total = this.manifest?.chunks?.length || 0;
    const lowMem = this.isLowMemoryDevice();
    for (let i = 0; i < total; i++) {
      const dec = await ShareMediaCache.getChunk(this.cacheKey(), i);
      if (dec) {
        this.chunks[i] = lowMem ? this.CHUNK_ON_DISK : dec;
        continue;
      }
      if (!lowMem) {
        const enc = await ShareMediaCache.getEncChunk(this.cacheKey(), i);
        if (enc && this.fileKey) {
          try {
            const meta = this.manifest.chunks[i];
            this.chunks[i] = await ShareCrypto.decryptChunk(enc, this.fileKey, meta.iv, meta.tag);
          } catch { /* skip bad cache */ }
        }
      }
    }
    this.syncCompleted();
  },

  reuseSession(token, fileId, onProgress) {
    if (onProgress) this.onProgress = onProgress;
    this.ensureFetchController();
    this.ensurePool();
    this.onProgress(this.getStatus());
    return this.manifest;
  },

  async load(token, fileId, onProgress) {
    while (this._loadInflight) {
      await this._loadInflight;
      if (this.token === token && this.fileId === fileId && this.manifest) {
        this.log('info', 'load:reuse-after-wait', { fileId });
        return this.reuseSession(token, fileId, onProgress);
      }
    }

    const reuse = this.token === token
      && this.fileId === fileId
      && this.manifest
      && this.chunks
      && this.fileKey;
    if (reuse) {
      this.log('info', 'load:reuse', {
        fileId,
        completed: this.completed,
        stream: !!this.stream,
      });
      return this.reuseSession(token, fileId, onProgress);
    }

    this._loadInflight = this._loadFresh(token, fileId, onProgress);
    try {
      return await this._loadInflight;
    } finally {
      this._loadInflight = null;
    }
  },

  async _loadFresh(token, fileId, onProgress) {
    this.log('info', 'load:start', { fileId, token: token?.slice(0, 8) });
    this.abort();
    this.token = token;
    this.fileId = fileId;
    this.onProgress = onProgress || (() => {});
    this.abortController = new AbortController();
    this.chunks = [];
    this.completed = 0;
    this.cachedEntry = null;
    this.cacheHit = false;
    this.offline = false;
    this.serverOffline = false;
    this.resetStream({ force: true });
    this._mseMime = null;
    this._chunkStarts = null;

    const mediaKey = this.cacheKey();
    const offlineEntry = await ShareMediaCache.getManifest(mediaKey);

    let manifest = null;
    try {
      manifest = await this.fetchManifestFromNetwork();
      await ShareMediaCache.putManifest(mediaKey, {
        manifest,
        token,
        fileId,
      });
    } catch {
      if (offlineEntry?.manifest) {
        manifest = offlineEntry.manifest;
        this.offline = true;
        this.serverOffline = true;
      }
    }

    if (!manifest) {
      throw new Error('Share unavailable offline — open this link once while the server is online');
    }

    this.manifest = manifest;
    if (!this.manifest.client_stream) {
      throw new Error('Client-side streaming is not enabled for this share');
    }
    if (!this.manifest.share_key || !this.manifest.chunks?.length) {
      throw new Error('Share manifest missing encryption data');
    }

    const fingerprint = this.cacheFingerprint();
    this.cachedEntry = await ShareMediaCache.getMedia(mediaKey, fingerprint);
    if (this.cachedEntry?.blob) {
      this.cacheHit = true;
      this.completed = this.manifest.chunks.length;
      this.onProgress(this.getStatus());
      return this.manifest;
    }

    await this.restoreCachedChunks();

    this.fileKey = await ShareCrypto.unwrapFileKey(this.manifest.share_key, token);

    if (this.completed < this.manifest.chunks.length) {
      await this.restoreCachedChunks();
    }

    if (this.completed >= this.manifest.chunks.length) {
      this.cacheHit = false;
      this.onProgress(this.getStatus());
    }

    const chunkCount = this.manifest.chunks.length;
    this.ensurePool(chunkCount);
    this.onProgress(this.getStatus());
    this.log('info', 'load:ready', {
      chunks: chunkCount,
      completed: this.completed,
      cacheHit: this.cacheHit,
    });
    return this.manifest;
  },

  ensureFetchController() {
    if (!this.abortController || this.abortController.signal.aborted) {
      this.abortController = new AbortController();
      this.log('warn', 'fetch:controller-recreated', {});
    }
  },

  fetchSignal() {
    this.ensureFetchController();
    return this.abortController.signal;
  },

  ensurePool(chunkCount = this.manifest?.chunks?.length || 0) {
    if (this.pool || !chunkCount) return;
    const conc = this.mediaKind() === 'media' && this.canUseMse()
      ? { max: this.isLowMemoryDevice() ? 2 : 4, initial: 1 }
      : this.fetchConcurrency();
    this.pool = AdaptiveConcurrency.createPool(chunkCount, conc);
    this.pool.start();
    this.log('info', 'pool:created', { max: conc.max, initial: conc.initial });
  },

  getStatus() {
    if (this.stream && !this.stream.stopped) {
      return this.getStreamStatus();
    }
    const total = this.manifest?.chunks?.length || 0;
    const bytesReady = this.cacheHit
      ? (this.manifest?.size || 0)
      : this.contiguousBytesReady();
    const done = this.cacheHit || (this.completed >= total && total > 0);
    let stage = 'fetching';
    if (this.cacheHit) stage = 'cached';
    else if (this.offline) stage = 'offline';
    else if (done) stage = 'ready';
    else if (this.completed > 0) stage = 'decrypting';

    return {
      stage,
      segments: this.cacheHit ? total : this.completed,
      total_segments: total,
      bytes_ready: bytesReady,
      progress: done && total > 0 ? 100 : (total > 0 ? Math.round((this.completed / total) * 100) : 0),
      mode: 'client',
      ready: done,
      buffered: done,
      client_stream: true,
      cache_hit: this.cacheHit,
      offline: this.offline,
    };
  },

  contiguousBytesReady() {
    if (!this.manifest?.chunks) return 0;
    let ready = 0;
    for (let i = 0; i < this.manifest.chunks.length; i++) {
      if (!this.isChunkReady(i)) break;
      ready += this.manifest.chunks[i].plain_size;
    }
    return ready;
  },

  syncCompleted() {
    const total = this.manifest?.chunks?.length || 0;
    let count = 0;
    for (let i = 0; i < total; i++) {
      if (this.isChunkReady(i)) count += 1;
    }
    this.completed = count;
  },

  async readCachedEncrypted(index) {
    const enc = await ShareMediaCache.getEncChunk(this.cacheKey(), index);
    if (enc) return enc;

    if (typeof caches !== 'undefined') {
      for (const name of ['vault-share-v3', 'vault-share-v2']) {
        try {
          const cache = await caches.open(name);
          const cached = await cache.match(this.chunkUrl(index));
          if (cached?.ok) {
            const buf = await cached.arrayBuffer();
            ShareMediaCache.putEncChunk(this.cacheKey(), index, buf).catch(() => {});
            return buf;
          }
        } catch { /* try next cache */ }
      }
    }
    return null;
  },

  chunkSourceUrls(meta) {
    const urls = [];
    if (meta.raw_url) urls.push(meta.raw_url);
    if (meta.repo && meta.repo_path) {
      const [owner, repo] = meta.repo.split('/');
      const branch = meta.branch || 'main';
      const path = meta.repo_path.split('/').map(encodeURIComponent).join('/');
      urls.push(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`);
    }
    return [...new Set(urls.filter(Boolean))];
  },

  usesDirectFetch() {
    return this.manifest?.direct_fetch !== false;
  },

  async fetchFromGithub(urls) {
    for (const url of urls) {
      try {
        const res = await fetch(url, { signal: this.fetchSignal() });
        if (res.ok) return res.arrayBuffer();
      } catch { /* try next source */ }
    }
    return null;
  },

  async fetchEncryptedChunk(index, meta) {
    const cached = await this.readCachedEncrypted(index);
    if (cached) return cached;

    const urls = this.chunkSourceUrls(meta);
    if (this.usesDirectFetch() && urls.length) {
      const direct = await this.fetchFromGithub(urls);
      if (direct) {
        ShareMediaCache.putEncChunk(this.cacheKey(), index, direct).catch(() => {});
        return direct;
      }
    }

    if (!this.serverOffline) {
      try {
        const res = await fetch(this.chunkUrl(index), {
          signal: this.fetchSignal(),
        });
        if (res.ok) {
          const buf = await res.arrayBuffer();
          ShareMediaCache.putEncChunk(this.cacheKey(), index, buf).catch(() => {});
          return buf;
        }
        if (res.status >= 500 || res.status === 0) {
          this.serverOffline = true;
          this.offline = true;
        }
      } catch {
        this.serverOffline = true;
        this.offline = true;
      }
    } else {
      this.offline = true;
    }

    const retryCached = await this.readCachedEncrypted(index);
    if (retryCached) return retryCached;

    if (!this.usesDirectFetch() && urls.length) {
      const direct = await this.fetchFromGithub(urls);
      if (direct) {
        ShareMediaCache.putEncChunk(this.cacheKey(), index, direct).catch(() => {});
        return direct;
      }
    }

    throw new Error(
      this.manifest?.all_repos_public === false
        ? `Chunk ${index} unavailable — make storage repos public in Storage Repositories, or keep the server running`
        : `Chunk ${index} not available — keep the page open while the server is running to cache more`
    );
  },

  async fetchOne(index) {
    if (this.isChunkReady(index)) {
      const entry = this.chunks[index];
      if (entry !== this.CHUNK_ON_DISK) return entry;
      const cached = await ShareMediaCache.getChunk(this.cacheKey(), index);
      if (cached) return cached;
    }
    if (!this.manifest?.chunks[index]) throw new Error(`Unknown chunk ${index}`);

    this.ensurePool();
    if (!this.pool) {
      const err = new Error('Stream session not ready — reload the page');
      this.log('error', 'fetchOne:no-pool', { index });
      throw err;
    }

    await this.pool.acquire();
    try {
      if (this.isChunkReady(index)) {
        const entry = this.chunks[index];
        if (entry !== this.CHUNK_ON_DISK) return entry;
        const cached = await ShareMediaCache.getChunk(this.cacheKey(), index);
        if (cached) return cached;
      }

      const cached = await ShareMediaCache.getChunk(this.cacheKey(), index);
      if (cached) {
        this.chunks[index] = this.isLowMemoryDevice() ? this.CHUNK_ON_DISK : cached;
        this.syncCompleted();
        this.onProgress(this.getStatus());
        return cached;
      }

      const meta = this.manifest.chunks[index];
      const enc = await this.fetchEncryptedChunk(index, meta);
      const dec = await ShareCrypto.decryptChunk(enc, this.fileKey, meta.iv, meta.tag);
      const lowMem = this.isLowMemoryDevice();
      if (lowMem) {
        await ShareMediaCache.putChunk(this.cacheKey(), index, dec);
        this.chunks[index] = this.CHUNK_ON_DISK;
      } else {
        this.chunks[index] = dec;
        ShareMediaCache.putChunk(this.cacheKey(), index, dec).catch(() => {});
      }
      this.syncCompleted();
      this.pool.recordBytes(dec.byteLength || dec.length);
      this.onProgress(this.getStatus());
      this.log('debug', 'fetchOne:done', { index, bytes: dec.byteLength || dec.length });
      return dec;
    } finally {
      this.pool.release();
    }
  },

  async buildFullBlobAsync() {
    const total = this.manifest.chunks.length;
    const parts = [];
    let size = 0;

    for (let i = 0; i < total; i++) {
      const chunk = await this.getChunkBytes(i);
      if (!chunk) throw new Error(`Missing chunk ${i}`);
      const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      size += bytes.byteLength;
      parts.push(bytes);
      if (this.isLowMemoryDevice()) {
        this.chunks[i] = this.CHUNK_ON_DISK;
      }
    }

    const expected = this.manifest?.size;
    if (expected > 0 && size !== expected) {
      const diff = Math.abs(size - expected);
      if (diff > 512) {
        throw new Error(`Decrypted file size mismatch (${size} vs ${expected} bytes)`);
      }
    }

    const header = parts[0];
    this.validateDecryptedFile(header instanceof Uint8Array ? header : new Uint8Array(header));
    return new Blob(parts, { type: this.blobType() });
  },

  buildFullBlob() {
    const total = this.manifest.chunks.length;
    const parts = [];
    let size = 0;
    for (let i = 0; i < total; i++) {
      const chunk = this.chunks[i];
      if (!chunk || chunk === this.CHUNK_ON_DISK) {
        throw new Error(`Missing chunk ${i} — use buildFullBlobAsync on this device`);
      }
      size += chunk.byteLength || chunk.length;
      parts.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    }

    const expected = this.manifest?.size;
    if (expected > 0 && size !== expected) {
      const diff = Math.abs(size - expected);
      if (diff > 512) {
        throw new Error(`Decrypted file size mismatch (${size} vs ${expected} bytes)`);
      }
    }

    this.validateDecryptedFile(parts[0]);
    return new Blob(parts, { type: this.blobType() });
  },

  validateDecryptedFile(bytes) {
    if (!bytes?.length) throw new Error('Decrypted file is empty');

    const ext = (this.manifest?.name || '').split('.').pop().toLowerCase();
    const mime = this.manifest?.mime_type || '';

    if (mime.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
      const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
      const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
      const isGif = bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46;
      const isWebp = bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
      if (!isJpeg && !isPng && !isGif && !isWebp) {
        throw new Error('Decrypted data does not look like a valid image');
      }
      return;
    }

    if (mime.startsWith('video/') || mime.startsWith('audio/') || ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'mp3', 'm4a', 'wav', 'ogg', 'flac'].includes(ext)) {
      const box = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
      const isMp4 = box === 'ftyp';
      const isWebm = bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
      const isId3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
      const isMp3Frame = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
      const isWav = bytes[0] === 0x52 && bytes[1] === 0x69 && bytes[2] === 0x46 && bytes[3] === 0x46;
      const isOgg = bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53;
      const isFlac = bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43;

      if (['mp4', 'm4v', 'mov', 'm4a'].includes(ext) && !isMp4) {
        throw new Error('Decrypted file does not look like a valid MP4');
      }
      if (ext === 'webm' && !isWebm) {
        throw new Error('Decrypted file does not look like a valid WebM');
      }
      if (ext === 'mp3' && !isId3 && !isMp3Frame) {
        throw new Error('Decrypted file does not look like a valid MP3');
      }
      if (ext === 'wav' && !isWav) {
        throw new Error('Decrypted file does not look like a valid WAV');
      }
      if (ext === 'ogg' && !isOgg) {
        throw new Error('Decrypted file does not look like a valid OGG');
      }
      if (ext === 'flac' && !isFlac) {
        throw new Error('Decrypted file does not look like a valid FLAC');
      }
    }
  },

  prepareMediaElement(mediaEl, wrap) {
    if (wrap) wrap.classList.remove('hidden');
    mediaEl.preload = 'auto';
    mediaEl.playsInline = true;
  },

  resolvedBlob() {
    if (this.cachedEntry?.blob) return this.cachedEntry.blob;
    return this.buildFullBlob();
  },

  async resolvedBlobAsync() {
    if (this.cachedEntry?.blob) return this.cachedEntry.blob;
    return this.buildFullBlobAsync();
  },

  async setBlobUrl(el) {
    this.revokeBlobUrl();
    const blob = this.isLowMemoryDevice()
      ? await this.resolvedBlobAsync()
      : this.resolvedBlob();
    this.blobUrl = URL.createObjectURL(blob);
    el.src = this.blobUrl;
    return this.blobUrl;
  },

  saveToCache(blob) {
    if (!blob || this.cacheHit) return;
    const maxCache = this.isLowMemoryDevice() ? (96 * 1024 * 1024) : (8 * 1024 * 1024 * 1024);
    if (blob.size > maxCache) return;
    ShareMediaCache.putMedia(this.cacheKey(), this.cacheFingerprint(), blob, {
      mimeType: this.blobType(),
      name: this.manifest?.name || '',
      token: this.token,
      fileId: this.fileId,
    }).catch(() => {});
  },

  revokeBlobUrl() {
    if (this.blobUrl) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
    }
  },

  waitForMediaReady(mediaEl, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const hasDuration = () => Number.isFinite(mediaEl.duration) && mediaEl.duration > 0;

      const tryResolve = () => {
        if (mediaEl.error) {
          onErr();
          return;
        }
        if (mediaEl.readyState >= 1 && hasDuration()) {
          done();
        }
      };

      if (mediaEl.readyState >= 1 && hasDuration()) {
        resolve();
        return;
      }

      const timer = setTimeout(() => {
        cleanup();
        if (mediaEl.error) {
          onErr();
          return;
        }
        if (hasDuration()) {
          resolve();
          return;
        }
        reject(new Error('Media failed to load — file may be unsupported in this browser'));
      }, timeoutMs);

      const done = () => {
        clearTimeout(timer);
        cleanup();
        resolve();
      };

      const onErr = () => {
        clearTimeout(timer);
        cleanup();
        const code = mediaEl.error?.code;
        const msg = code === 4 ? 'Format not supported by this browser'
          : code === 3 ? 'Media decode failed'
            : 'Media failed to load';
        reject(new Error(msg));
      };

      const cleanup = () => {
        mediaEl.removeEventListener('loadedmetadata', tryResolve);
        mediaEl.removeEventListener('durationchange', tryResolve);
        mediaEl.removeEventListener('canplay', tryResolve);
        mediaEl.removeEventListener('error', onErr);
      };

      mediaEl.addEventListener('loadedmetadata', tryResolve);
      mediaEl.addEventListener('durationchange', tryResolve);
      mediaEl.addEventListener('canplay', tryResolve);
      mediaEl.addEventListener('error', onErr);
    });
  },

  async fetchAllForDownload(onProgress) {
    if (onProgress) this.onProgress = onProgress;
    if (this.cacheHit && this.cachedEntry?.blob) {
      return this.cachedEntry.blob;
    }

    const indices = this.manifest.chunks.map((_, i) => i);
    for (const index of indices) {
      if (!this.isChunkReady(index)) {
        await this.fetchOne(index);
      }
      if (this.isLowMemoryDevice() && this.chunks[index] !== this.CHUNK_ON_DISK) {
        const bytes = this.chunks[index];
        if (bytes) {
          await ShareMediaCache.putChunk(this.cacheKey(), index, bytes);
          this.chunks[index] = this.CHUNK_ON_DISK;
        }
      }
      this.onProgress(this.getDownloadStatus());
    }

    const missing = indices.filter((i) => !this.isChunkReady(i));
    if (missing.length) {
      throw new Error(
        `${missing.length} chunk(s) unavailable offline (e.g. ${missing[0]}) — open this link online first to cache more`
      );
    }

    return null;
  },

  getDownloadStatus() {
    const total = this.manifest?.chunks?.length || 0;
    const done = this.completed >= total && total > 0;
    return {
      stage: done ? 'ready' : (this.offline ? 'offline' : 'fetching'),
      segments: this.completed,
      total_segments: total,
      bytes_ready: this.contiguousBytesReady(),
      progress: total > 0 ? Math.round((this.completed / total) * 100) : 0,
      mode: 'client',
      ready: done,
      buffered: done,
      client_stream: true,
      cache_hit: this.cacheHit,
      offline: this.offline,
    };
  },

  async fetchAllParallel(onProgress) {
    if (onProgress) this.onProgress = onProgress;
    if (this.cacheHit) {
      return this.isLowMemoryDevice() ? this.resolvedBlobAsync() : this.resolvedBlob();
    }

    const indices = this.manifest.chunks.map((_, i) => i);
    const missing = [];

    if (this.isLowMemoryDevice()) {
      for (const index of indices) {
        await this.fetchOne(index);
      }
    } else {
      const results = await Promise.allSettled(indices.map((index) => this.fetchOne(index)));
      for (const index of indices) {
        if (!this.isChunkReady(index)) missing.push(index);
      }
      if (missing.length > 0) {
        const firstFail = results.find((r) => r.status === 'rejected');
        throw firstFail?.reason || new Error(
          `${missing.length} chunk(s) not cached yet (e.g. ${missing[0]}) — keep the page open while the server is running`
        );
      }
    }

    if (missing.length > 0) {
      throw new Error(
        `${missing.length} chunk(s) failed (e.g. ${missing[0]}) — check connection and try again`
      );
    }

    const blob = await this.buildFullBlobAsync();
    this.saveToCache(blob);
    if (this.isLowMemoryDevice()) {
      this.chunks = indices.map(() => this.CHUNK_ON_DISK);
    }
    return blob;
  },

  async playMedia(mediaEl, wrap = null) {
    if (this.mediaKind() === 'image') {
      await this.fetchAllParallel();
      this.prepareMediaElement(mediaEl, wrap);
      await this.setBlobUrl(mediaEl);
      mediaEl.load?.();
      return;
    }

    if (this.mediaKind() === 'media' && this.canUseMse()) {
      try {
        return await this.playMediaProgressive(mediaEl, wrap);
      } catch {
        this.resetStream({ force: true });
        return this.playMediaBlob(mediaEl, wrap);
      }
    }

    return this.playMediaBlob(mediaEl, wrap);
  },

  async playWithMse(mediaEl, wrap = null) {
    return this.playMediaProgressive(mediaEl, wrap);
  },

  async playWithBlob(mediaEl, wrap = null) {
    return this.playMediaBlob(mediaEl, wrap);
  },

  async fetchAll(onProgress) {
    return this.fetchAllForDownload(onProgress).then(async () => {
      if (this.cachedEntry?.blob) return this.cachedEntry.blob;
      const blob = await this.buildFullBlobAsync();
      this.saveToCache(blob);
      return blob;
    });
  },

  async fetchImageBlob() {
    return this.fetchAllParallel();
  },

  async persistChunkToCache(index) {
    const entry = this.chunks?.[index];
    if (!entry || entry === this.CHUNK_ON_DISK) return;
    await ShareMediaCache.putChunk(this.cacheKey(), index, entry);
    this.chunks[index] = this.CHUNK_ON_DISK;
  },

  beginDownloadSession(onProgress) {
    this._downloadDepth = (this._downloadDepth || 0) + 1;
    if (this._downloadDepth > 1) return;

    this._playbackOnProgress = this.onProgress;
    if (onProgress) this.onProgress = onProgress;
    if (this.stream?.mseUrl) this._streamProtected = true;

    const media = document.querySelector('.share-video-el, .share-audio-el');
    this._yieldForPlayback = !!(media && !media.paused && media.readyState >= 2);

    this.log('info', 'download:begin', {
      stream: !!this.stream,
      appendIndex: this.stream?.appendIndex ?? null,
      protected: !!this._streamProtected,
      yieldForPlayback: this._yieldForPlayback,
    });
  },

  endDownloadSession() {
    if (!this._downloadDepth) return;
    this._downloadDepth -= 1;
    if (this._downloadDepth > 0) return;

    this._streamProtected = false;
    this._yieldForPlayback = false;
    if (this._playbackOnProgress) {
      this.onProgress = this._playbackOnProgress;
      this._playbackOnProgress = null;
    }
    this.log('info', 'download:end', ShareStreamLog?.streamSnapshot?.() || {});
  },

  shouldYieldForPlayback() {
    if (!this._yieldForPlayback) return false;
    const media = document.querySelector('.share-video-el, .share-audio-el');
    return !!(media && !media.paused);
  },

  abort() {
    this.log('info', 'session:abort', {});
    this._streamProtected = false;
    this._yieldForPlayback = false;
    this._downloadDepth = 0;
    this._playbackOnProgress = null;
    this.abortController?.abort();
    this.pool?.stop();
    this.resetStream({ force: true });
    this.revokeBlobUrl();
    this.token = null;
    this.fileId = null;
    this.manifest = null;
    this.fileKey = null;
    this.chunks = null;
    this.completed = 0;
    this.pool = null;
    this.abortController = null;
    this.cachedEntry = null;
    this.cacheHit = false;
    this.offline = false;
    this.serverOffline = false;
    this._mseMime = null;
    this._chunkStarts = null;
  },
};
