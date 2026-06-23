const ShareViewer = {
  plyr: null,
  audioViz: null,
  pollTimer: null,
  statsTimer: null,
  mediaReady: false,
  lastServerStatus: null,
  currentFile: null,
  currentMediaType: null,
  currentToken: null,
  videoRetry: 0,
  hls: null,
  metrics: {
    lastBytes: 0,
    lastTime: 0,
    speed: 0,
    peakSpeed: 0,
  },

  chunkBlocks: null,
  lastChunkStateKey: null,
  clientStream: false,
  playlistMode: false,
  _hlsMode: 'direct',
  _hlsSegmentsDone: 0,
  _hlsSegmentsTotal: 0,

  apiBase(token) {
    return this.playlistMode
      ? `/api/public/playlist/${token}`
      : `/api/public/share/${token}`;
  },

  usesClientStream(info) {
    return !!info?.client_stream;
  },

  mediaType(name, mime) {
    const ext = name.split('.').pop().toLowerCase();
    if (mime?.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return 'image';
    if (mime?.startsWith('video/') || ['mp4', 'webm', 'mkv', 'mov', 'm4v', 'avi'].includes(ext)) return 'video';
    if (mime?.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'].includes(ext)) return 'audio';
    return null;
  },

  fileParam(fileId) {
    return fileId ? `?file=${encodeURIComponent(fileId)}` : '';
  },

  viewerId() {
    if (typeof SharePresence !== 'undefined' && SharePresence.viewerId) {
      return SharePresence.viewerId;
    }
    if (typeof SharePresence !== 'undefined' && SharePresence.getViewerId) {
      return SharePresence.getViewerId();
    }
    return null;
  },

  streamControlUrl(token, fileId, action) {
    return `${this.apiBase(token)}/stream/${action}${this.fileParam(fileId)}`;
  },

  notifyStreamStart(token, fileId) {
    const viewerId = this.viewerId();
    if (!viewerId || !fileId) return;
    fetch(this.streamControlUrl(token, fileId, 'start'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ viewer_id: viewerId }),
    }).catch(() => {});
  },

  notifyStreamStop(token, fileId, useBeacon = false) {
    const viewerId = this.viewerId();
    if (!viewerId || !fileId || !token) return;
    const url = this.streamControlUrl(token, fileId, 'stop');
    const body = JSON.stringify({ viewer_id: viewerId });
    if (useBeacon && navigator.sendBeacon) {
      navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
      return;
    }
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => {});
  },

  stopMediaElements() {
    const viewer = document.getElementById('share-viewer');
    if (!viewer) return;
    viewer.querySelectorAll('video, audio').forEach((el) => {
      PlaybackMemory?.detach?.(el);
      el.pause();
      el.removeAttribute('src');
      el.load();
    });
  },

  streamUrl(token, fileId) {
    return `${this.apiBase(token)}/stream${this.fileParam(fileId)}`;
  },

  statusUrl(token, fileId) {
    return `${this.apiBase(token)}/status${this.fileParam(fileId)}`;
  },

  thumbnailUrl(token, fileId) {
    return `${this.apiBase(token)}/thumbnail${this.fileParam(fileId)}`;
  },

  downloadUrl(token, fileId) {
    return `${this.apiBase(token)}/download${this.fileParam(fileId)}`;
  },

  applyVideoPoster(video, info, token) {
    if (!video || !info?.has_thumbnail) return;
    const poster = this.thumbnailUrl(token, info.id);
    video.poster = poster;
    this.preloadPoster(poster);
  },

  preloadPoster(url) {
    if (!url || document.querySelector(`link[data-share-poster="${url}"]`)) return;
    const link = document.createElement('link');
    link.rel = 'preload';
    link.as = 'image';
    link.href = url;
    link.setAttribute('data-share-poster', url);
    if ('fetchPriority' in link) link.fetchPriority = 'high';
    document.head.appendChild(link);
  },

  hlsPlaylistUrl(token, fileId) {
    return `${this.apiBase(token)}/hls${this.fileParam(fileId)}`;
  },

  shouldUseHls(info, status = null) {
    const ext = info.name.split('.').pop().toLowerCase();
    const isMp4 = info.mime_type === 'video/mp4' || ext === 'mp4';
    if (!isMp4 || !info.chunk_count || info.chunk_count < 2) return false;
    if (status) {
      if (status.use_hls === false) return false;
      if (status.mode === 'faststart' || status.mode === 'cached') return false;
      if (status.use_hls) return true;
    }
    return true;
  },

  playDirectStream(info, token, video, videoWrap, loading) {
    if (this._hlsMode === 'hls') {
      this._hlsMode = 'direct';
      this._hlsSegmentsDone = 0;
      this._hlsSegmentsTotal = 0;
      this.syncChunksStatLabel();
      if (info?.chunk_count) this.mountChunkBlocks(info, null);
    }
    this.applyVideoPoster(video, info, token);
    const streamUrl = this.streamUrl(token, info.id);
    MediaPlayer.attachStreamPlayback(video, {
      onReady: () => {
        videoWrap.classList.remove('hidden');
        this.onMediaReady(video, videoWrap, loading);
      },
      onPlaying: () => this.setStat('share-stat-stage', 'Playing'),
      onError: () => this.handleVideoError(token, info, video, loading),
    });
    video.src = streamUrl;
    video.load();
    void this.initVideoPlyr(video);
    setTimeout(() => {
      videoWrap.classList.remove('hidden');
      this.onMediaReady(video, videoWrap, loading);
    }, 2000);
  },

  async playVideo(info, token, video, videoWrap, loading) {
    let status = null;
    try {
      const res = await fetch(this.statusUrl(token, info.id));
      if (res.ok) {
        status = await res.json();
        this.lastServerStatus = status;
        this.updateFromStatus(status);
      }
    } catch { /* fall through */ }

    const typeParam = new URL(location.href).searchParams.get('type');
    if (typeParam === 'github' && info.hls_playlist_url) {
      void this.playWithHls(info, token, video, videoWrap, loading);
      return;
    }

    if (this.shouldUseHls(info, status)) {
      void this.playWithHls(info, token, video, videoWrap, loading);
      return;
    }

    this.playDirectStream(info, token, video, videoWrap, loading);
  },

  destroyHls() {
    if (this.hlsFallbackTimer) {
      clearTimeout(this.hlsFallbackTimer);
      this.hlsFallbackTimer = null;
    }
    if (this.hls) {
      const media = this.hls.media;
      try { this.hls.detachMedia(); } catch { /* ignore */ }
      this.hls.destroy();
      this.hls = null;
      if (media) {
        media.pause();
        media.removeAttribute('src');
        try { media.load(); } catch { /* ignore */ }
      }
    }
  },

  async playWithHlsUrl(info, token, video, videoWrap, loading) {
    this.destroyHls();
    const playlistUrl = info.hls_playlist_url || this._hlsPlaylistUrl;
    if (!playlistUrl) {
      this.playDirectStream(info, token, video, videoWrap, loading);
      return;
    }

    try {
      await ShareLazyLibs.loadHls();
    } catch {
      this.playDirectStream(info, token, video, videoWrap, loading);
      return;
    }
    if (typeof Hls === 'undefined' || !Hls.isSupported()) {
      this.playDirectStream(info, token, video, videoWrap, loading);
      return;
    }

    let networkRetries = 0;
    this.hlsFallbackTimer = setTimeout(() => {
      if (!this.mediaReady) {
        this.destroyHls();
        this.setStat('share-stat-stage', 'Direct fallback');
        this.playDirectStream(info, token, video, videoWrap, loading);
      }
    }, 18000);

    this.hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      backBufferLength: 90,
      manifestLoadingMaxRetry: 6,
      manifestLoadingRetryDelay: 1000,
      fragLoadingMaxRetry: 4,
      fragLoadingRetryDelay: 1000,
    });

    this.hls.loadSource(playlistUrl);
    this.hls.attachMedia(video);
    this.applyVideoPoster(video, info, token);
    this.bindHlsSegmentTracking(info);

    const revealPlayback = () => {
      clearTimeout(this.hlsFallbackTimer);
      videoWrap.classList.remove('hidden');
      this.onMediaReady(video, videoWrap, loading);
    };

    video.oncanplay = () => revealPlayback();

    this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
      this.syncDurationStat(video);
      video.play().catch(() => {});
    });
    this.hls.on(Hls.Events.FRAG_LOADED, () => {
      videoWrap.classList.remove('hidden');
    });
    this.hls.on(Hls.Events.FRAG_BUFFERED, () => {
      if (video.buffered.length > 0) revealPlayback();
    });
    this.hls.on(Hls.Events.ERROR, (event, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        networkRetries += 1;
        if (networkRetries <= 3) {
          this.hls.startLoad();
          return;
        }
      }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR && this.hls.recoverMediaError()) {
        return;
      }
      clearTimeout(this.hlsFallbackTimer);
      this.destroyHls();
      this.playDirectStream(info, token, video, videoWrap, loading);
    });
    this.setStat('share-stat-stage', 'HLS');
  },

  bindHlsToggle(info, token, video, videoWrap, loading) {
    const btnHls = document.getElementById('btn-hls-mode');
    const btnGit = document.getElementById('btn-github-mode');
    const btnRaw = document.getElementById('btn-raw-mode');
    if (!btnHls || !btnRaw) return;
    const current = new URL(location.href);
    const reload = (type) => {
      localStorage.setItem('shareHlsMode', type);
      current.searchParams.set('type', type);
      if (location.href !== current.href) location.href = current.href;
    };
    btnHls.onclick = () => reload('hls');
    if (btnGit) btnGit.onclick = () => reload('github');
    btnRaw.onclick = () => reload('direct');
  },

  async playWithHls(info, token, video, videoWrap, loading) {
    this.destroyHls();
    this.hlsFallbackTimer = setTimeout(() => {
      if (!this.mediaReady) {
        this.destroyHls();
        this.playDirectStream(info, token, video, videoWrap, loading);
      }
    }, 20000);

    try {
      await ShareLazyLibs.loadHls();
    } catch {
      clearTimeout(this.hlsFallbackTimer);
      this.playDirectStream(info, token, video, videoWrap, loading);
      return;
    }

    if (typeof Hls === 'undefined' || !Hls.isSupported()) {
      clearTimeout(this.hlsFallbackTimer);
      this.playDirectStream(info, token, video, videoWrap, loading);
      return;
    }

    this.hls = new Hls({
      enableWorker: true,
      lowLatencyMode: false,
      backBufferLength: 90,
      manifestLoadingMaxRetry: 12,
      manifestLoadingRetryDelay: 1000,
    });

    const playlistUrl = info.hls_playlist_url || this._hlsPlaylistUrl || this.hlsPlaylistUrl(token, info.id);

    this.hls.loadSource(playlistUrl);
    this.hls.attachMedia(video);
    this.applyVideoPoster(video, info, token);
    this.bindHlsSegmentTracking(info);

    video.oncanplay = () => {
      clearTimeout(this.hlsFallbackTimer);
      this.onMediaReady(video, videoWrap, loading);
    };
    video.onplaying = () => this.setStat('share-stat-stage', 'Playing');

    this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {});
    });

    this.hls.on(Hls.Events.FRAG_BUFFERED, () => {
      if (video.buffered.length > 0) {
        clearTimeout(this.hlsFallbackTimer);
        this.onMediaReady(video, videoWrap, loading);
      }
    });

    this.hls.on(Hls.Events.ERROR, (event, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        this.hls.startLoad();
        return;
      }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        this.hls.recoverMediaError();
        return;
      }
      clearTimeout(this.hlsFallbackTimer);
      this.destroyHls();
      this.playDirectStream(info, token, video, videoWrap, loading);
    });
  },

  destroy(options = {}) {
    const token = this.currentToken;
    const fileId = this.currentFile?.id;
    this.stopStatusPoll();
    this.stopPlaybackStats();
    this.stopMediaElements();
    this.destroyHls();
    if (token && fileId
      && typeof ShareClientStream !== 'undefined'
      && ShareClientStream.token === token
      && ShareClientStream.fileId === fileId) {
      ShareClientStream.abort();
    }
    MediaPlayer.stopAudioViz(this.audioViz);
    this.audioViz = null;
    if (this.plyr) {
      this.plyr.destroy();
      this.plyr = null;
    }
    if (token && fileId && !this.clientStream) {
      this.notifyStreamStop(token, fileId, options.useBeacon);
    }
    this.mediaReady = false;
    this.currentFile = null;
    this.currentMediaType = null;
    this.currentToken = null;
    this.lastServerStatus = null;
    this.lastChunkStateKey = null;
    this.videoRetry = 0;
    if (this.chunkBlocks) {
      ChunkBlocks.destroy(this.chunkBlocks);
      this.chunkBlocks = null;
    }
    const dockStats = document.getElementById('share-dock-stats');
    if (dockStats) dockStats.innerHTML = '';
    if (typeof ShareStageLayout !== 'undefined') ShareStageLayout.onClose();
    this.resetCinemaStage();
    document.body.classList.remove('share-cinema-active', 'share-player-fullscreen', 'share-text-active');
  },

  setCinemaMode(active) {
    document.body.classList.toggle('share-cinema-active', !!active);
    if (!active) {
      if (typeof ShareStageLayout !== 'undefined') ShareStageLayout.onClose();
      this.resetCinemaStage();
    } else if (typeof ShareStageLayout !== 'undefined') {
      ShareStageLayout.onOpen();
    }
  },

  isMobileShareLayout() {
    return typeof matchMedia !== 'undefined' && matchMedia('(max-width: 768px)').matches;
  },

  ensurePageScrollTop() {
    if (!this.isMobileShareLayout()) return;
    const pin = () => {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    };
    pin();
    requestAnimationFrame(pin);
    requestAnimationFrame(() => requestAnimationFrame(pin));
  },

  setPlayerFullscreen(active) {
    if (this.isMobileShareLayout()) return;
    document.body.classList.toggle('share-player-fullscreen', !!active);
  },

  bindFullscreenSync() {
    if (this._fullscreenSyncBound) return;
    this._fullscreenSyncBound = true;
    const sync = () => {
      if (this.isMobileShareLayout()) {
        document.body.classList.remove('share-player-fullscreen');
        return;
      }
      const active = !!document.fullscreenElement
        || !!document.webkitFullscreenElement;
      this.setPlayerFullscreen(active);
    };
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
    document.addEventListener('visibilitychange', sync);
    window.addEventListener('pagehide', () => this.setPlayerFullscreen(false));
  },

  async initVideoPlyr(video) {
    if (this.plyr || !video) return this.plyr;
    try {
      await ShareLazyLibs.loadPlyr();
    } catch {
      return null;
    }
    this.plyr = MediaPlayer.createPlyr(video, false, {
      onEnterFullscreen: () => this.setPlayerFullscreen(true),
      onExitFullscreen: () => this.setPlayerFullscreen(false),
    });
    return this.plyr;
  },

  resetCinemaStage() {
    const stage = document.getElementById('share-cinema-stage');
    if (stage) {
      stage.classList.remove('share-stage-fitted', 'share-stage-capped');
      stage.style.removeProperty('--share-stage-height');
    }
    this._fitVideoEl = null;
    if (this._cinemaStageResize) {
      window.removeEventListener('resize', this._cinemaStageResize);
      this._cinemaStageResize = null;
    }
    this._stageResizeObs?.disconnect();
    this._stageResizeObs = null;
  },

  fitCinemaStage(video, { force = false } = {}) {
    if (!video || !document.body.classList.contains('share-cinema-active')) return;
    if (!force && typeof ShareStageLayout !== 'undefined' && ShareStageLayout.isUserSized()) {
      if (ShareStageLayout.isResizing?.()) return;
      ShareStageLayout.applySaved();
      return;
    }
    this._fitVideoEl = video;

    const apply = () => {
      const stage = document.getElementById('share-cinema-stage');
      const shell = document.querySelector('.share-shell');
      if (!stage || !shell) return;

      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return;

      const ar = vw / vh;
      const layout = document.getElementById('share-cinema-stage')?.parentElement;
      const shellW = layout?.clientWidth || shell.clientWidth;
      const topDock = document.getElementById('share-top-dock')?.offsetHeight || 0;
      let bottomReserve = 140;
      if (window.matchMedia('(max-width: 768px)').matches) {
        const rail = document.getElementById('share-right-rail');
        const shoutbox = document.getElementById('share-shoutbox');
        const frameGap = 8;
        if (rail?.classList.contains('share-right-rail-open') && rail.offsetHeight > 0) {
          bottomReserve += rail.offsetHeight + frameGap;
        } else if (shoutbox?.classList.contains('shoutbox-open') && !shoutbox.classList.contains('hidden')) {
          bottomReserve += shoutbox.offsetHeight + frameGap;
        } else if (document.body.classList.contains('share-shoutbox-open')) {
          bottomReserve += Math.min(window.innerHeight * 0.42, 380) + frameGap;
        }
      }
      const maxH = Math.max(280, window.innerHeight - topDock - bottomReserve);
      const idealH = shellW / ar;
      const capped = idealH > maxH;
      const h = capped ? maxH : idealH;

      stage.style.setProperty('--share-stage-height', `${Math.round(h)}px`);
      stage.classList.toggle('share-stage-capped', capped);
      stage.classList.add('share-stage-fitted');
      if (typeof ShareStageLayout !== 'undefined') {
        ShareStageLayout.syncOverlays();
        ShareStageLayout.updateStageControls?.();
      }
    };

    const runFit = () => apply();

    if (video.readyState >= 1 && video.videoWidth) runFit();
    else video.addEventListener('loadedmetadata', runFit, { once: true });

    if (!this._cinemaStageResize) {
      this._cinemaStageResize = () => {
        if (this._fitVideoEl) this.fitCinemaStage(this._fitVideoEl);
      };
      window.addEventListener('resize', this._cinemaStageResize);
      const shellEl = document.querySelector('.share-shell');
      if (shellEl && typeof ResizeObserver !== 'undefined') {
        this._stageResizeObs = new ResizeObserver(() => {
          if (ShareStageLayout?.isResizing?.()) return;
          if (this._fitVideoEl?.videoWidth) apply();
        });
        this._stageResizeObs.observe(shellEl);
      }
    } else if (video.videoWidth) {
      apply();
    }
  },

  refitCinemaStage({ force = false } = {}) {
    const shouldForce = force || !ShareStageLayout?.isUserSized?.();
    const video = this._fitVideoEl
      || document.querySelector('#share-viewer .share-video-el')
      || document.querySelector('#share-viewer video');
    if (video) {
      this.fitCinemaStage(video, { force: shouldForce });
      return;
    }
    if (shouldForce) this.clearCinemaStageSizing();
  },

  clearCinemaStageSizing() {
    const stage = document.getElementById('share-cinema-stage');
    if (!stage) return;
    stage.classList.remove('share-stage-user-sized', 'share-stage-capped');
    stage.style.width = '';
    stage.style.height = '';
    stage.style.minHeight = '';
    stage.style.maxHeight = '';
    stage.style.marginLeft = '';
    stage.style.marginRight = '';
    stage.style.flex = '';
    stage.style.alignSelf = '';
    ShareStageLayout?.syncLayoutMode?.();
    ShareStageLayout?.syncOverlays?.();
    ShareStageLayout?.updateStageControls?.();
  },

  mountStats(info) {
    const dock = document.getElementById('share-dock-stats');
    if (!dock) return null;
    dock.innerHTML = this.buildStatsHtml();
    const stats = dock.querySelector('#share-stats');
    if (stats && info) {
      const sizeEl = document.getElementById('share-stat-size');
      if (sizeEl && typeof formatSize === 'function') sizeEl.textContent = formatSize(info.size);
    }
    return stats;
  },

  mountChunkBlocks(file, totalOverride) {
    const stats = document.getElementById('share-stats');
    if (!stats || !file?.chunk_count) return;
    let blocksEl = document.getElementById('share-chunk-blocks');
    if (!blocksEl) {
      blocksEl = document.createElement('div');
      blocksEl.id = 'share-chunk-blocks';
      blocksEl.className = 'chunk-blocks-wrap';
      stats.appendChild(blocksEl);
    }
    if (this.chunkBlocks) ChunkBlocks.destroy(this.chunkBlocks);
    const total = totalOverride || file.chunk_count;
    const label = totalOverride ? 'Segments' : 'Stream blocks';
    this.chunkBlocks = ChunkBlocks.mount(blocksEl, {
      total,
      label,
    });
  },

  updateChunkBlocks(status) {
    if (!this.chunkBlocks || !this.currentFile) return;
    if (this.usesHlsSegments()) {
      const total = this.hlsSegmentTotal();
      const completed = Math.max(
        this._hlsSegmentsDone || 0,
        status?.hls_segments || status?.segments || 0,
      );
      const state = { completed, total, stage: 'hls' };
      const key = ChunkBlocks.stateKey(state);
      if (this.lastChunkStateKey === key) return;
      this.lastChunkStateKey = key;
      ChunkBlocks.update(this.chunkBlocks, state);
      return;
    }
    const state = ChunkBlocks.fromStreamStatus(status, this.currentFile);
    const key = ChunkBlocks.stateKey(state);
    if (this.lastChunkStateKey === key) return;
    this.lastChunkStateKey = key;
    ChunkBlocks.update(this.chunkBlocks, state);
  },

  buildStatsHtml() {
    return `
      <div id="share-stats" class="viewer-stats hidden">
        <div class="viewer-stat-grid">
          <div class="viewer-stat">
            <span class="viewer-stat-label">Chunks</span>
            <span id="share-stat-chunks" class="viewer-stat-value">—</span>
          </div>
          <div class="viewer-stat">
            <span class="viewer-stat-label">Progress</span>
            <span id="share-stat-progress" class="viewer-stat-value">—</span>
          </div>
          <div class="viewer-stat">
            <span class="viewer-stat-label">Stage</span>
            <span id="share-stat-stage" class="viewer-stat-value">—</span>
          </div>
          <div class="viewer-stat">
            <span class="viewer-stat-label">Speed</span>
            <span id="share-stat-speed" class="viewer-stat-value">—</span>
          </div>
          <div class="viewer-stat">
            <span class="viewer-stat-label">Duration</span>
            <span id="share-stat-duration" class="viewer-stat-value">—</span>
          </div>
          <div class="viewer-stat">
            <span class="viewer-stat-label">Buffered</span>
            <span id="share-stat-buffered" class="viewer-stat-value">—</span>
          </div>
          <div class="viewer-stat">
            <span class="viewer-stat-label">File size</span>
            <span id="share-stat-size" class="viewer-stat-value">—</span>
          </div>
        </div>
        <div class="viewer-stat-bar" aria-hidden="true">
          <div id="share-stat-bar-fill" class="viewer-stat-bar-fill"></div>
        </div>
        <div id="share-chunk-blocks" class="chunk-blocks-wrap"></div>
      </div>
    `;
  },

  async playClientImage(info, token, viewer) {
    const loading = document.createElement('div');
    loading.className = 'viewer-loading';
    loading.innerHTML = vaultLoaderHtml('Decrypting in browser...');
    viewer.appendChild(loading);
    try {
      await ShareClientStream.load(token, info.id);
      const blob = await ShareClientStream.fetchImageBlob();
      const img = document.createElement('img');
      img.className = 'share-media';
      img.src = URL.createObjectURL(blob);
      img.onload = () => URL.revokeObjectURL(img.src);
      viewer.innerHTML = '';
      viewer.appendChild(img);
    } catch (err) {
      viewer.innerHTML = '';
      this.showError(err.message || 'Failed to load image');
    }
  },

  startClientProgressUI(file) {
    const statusEl = document.getElementById('share-media-status');
    this.stopStatusPoll();
    const tick = () => {
      const s = ShareClientStream.getStatus();
      this.lastServerStatus = s;
      this.updateFromStatus(s);
      if (statusEl) {
        if (s.cache_hit) {
          statusEl.textContent = 'Loaded from browser cache';
        } else if (s.ready) {
          statusEl.textContent = 'Ready';
        } else {
          statusEl.textContent = `Decrypting chunk ${s.segments} of ${s.total_segments}...`;
        }
      }
      if (!s.ready) this.pollTimer = setTimeout(tick, 400);
    };
    tick();
  },

  async playClientVideo(info, token, video, videoWrap, loading) {
    try {
      await ShareClientStream.load(token, info.id, (status) => {
        this.lastServerStatus = status;
        this.updateFromStatus(status);
      });
      this.startClientProgressUI(info);
      await ShareClientStream.playMedia(video, videoWrap);
      this.syncDurationStat(video);
      this.onMediaReady(video, videoWrap, loading);
    } catch (err) {
      loading.classList.add('hidden');
      globalThis.ShareStreamLog?.error('playback:video-failed', { message: err.message });
      let msg = err.message || 'Failed to load video';
      if (/allocation|memory|Missing chunk|size mismatch/i.test(msg)) {
        msg = 'Video too large for this device\'s memory — try a shorter clip or use Download on Wi‑Fi';
      }
      this.showError(msg);
    }
  },

  async playClientAudio(info, token, audio, wrap, loading) {
    try {
      await ShareClientStream.load(token, info.id, (status) => {
        this.lastServerStatus = status;
        this.updateFromStatus(status);
      });
      this.startClientProgressUI(info);
      await ShareClientStream.playMedia(audio, wrap);
      this.syncDurationStat(audio);
      this.onMediaReady(audio, wrap, loading);
    } catch (err) {
      loading.classList.add('hidden');
      globalThis.ShareStreamLog?.error('playback:audio-failed', { message: err.message });
      let msg = err.message || 'Failed to load audio';
      if (/allocation|memory|Missing chunk|size mismatch/i.test(msg)) {
        msg = 'File too large for this device\'s memory — try Download on Wi‑Fi instead';
      }
      this.showError(msg);
    }
  },

  mount(info, token) {
    this.destroy();
    this.bindFullscreenSync();
    this.currentFile = info;
    this.currentToken = token;
    this.currentMediaType = this.mediaType(info.name, info.mime_type);
    this.clientStream = this.usesClientStream(info);

    if (!this.clientStream) {
      this.notifyStreamStart(token, info.id);
    }

    const viewer = document.getElementById('share-viewer');
    const streamUrl = this.streamUrl(token, info.id);
    viewer.innerHTML = '';

    if (this.currentMediaType === 'image') {
      this.setCinemaMode(false);
      if (this.clientStream) {
        this.playClientImage(info, token, viewer);
        return;
      }
      const img = document.createElement('img');
      img.className = 'share-media';
      img.src = streamUrl;
      viewer.appendChild(img);
      return;
    }

    if (this.currentMediaType === 'video') {
      this.setCinemaMode(true);
      this.ensurePageScrollTop();
      const hasHls = info.hls_available && !!info.hls_playlist_url;
      let typeParam = new URL(location.href).searchParams.get('type');
      if (!typeParam && hasHls) {
        const stored = localStorage.getItem('shareHlsMode');
        if (stored === 'github' || stored === 'direct') {
          const url = new URL(location.href);
          url.searchParams.set('type', stored);
          location.href = url.href;
          return;
        }
      }
      const useHls = hasHls && typeParam !== 'direct' && typeParam !== 'github';
      const useGithub = hasHls && typeParam === 'github';
      const useUploadedHls = hasHls && (useHls || useGithub);
      const showHlsBlocks = useUploadedHls;
      const hlsToggleHtml = hasHls ? `
        <div class="share-hls-toggle">
          <span class="hls-badge">m3u8</span>
          <button id="btn-hls-mode" class="btn-hls-mode ${useHls ? 'active' : ''}" data-mode="hls">HLS</button>
          <button id="btn-github-mode" class="btn-hls-mode ${useGithub ? 'active' : ''}" data-mode="github">HLS (GitHub)</button>
          <button id="btn-raw-mode" class="btn-hls-mode ${typeParam === 'direct' ? 'active' : ''}" data-mode="raw">Direct</button>
        </div>
      ` : '';

      viewer.innerHTML = `
        <div class="share-theater share-theater-full">
          <div class="share-theater-player">
            <div class="viewer-media-area share-media-area share-media-area-full">
              <div id="share-media-loading" class="viewer-loading">
                ${vaultLoaderHtml('Loading...', 'share-media-status')}
              </div>
              ${MediaPlayer.buildVideoPlayerHtml().replace('share-video-player', 'share-video-player hidden')}
            </div>
          </div>
        </div>
      `;

      const dock = document.getElementById('share-cinema-dock');
      let hlsSlot = document.getElementById('share-dock-hls');
      if (!hlsSlot && dock) {
        hlsSlot = document.createElement('div');
        hlsSlot.id = 'share-dock-hls';
        hlsSlot.className = 'share-dock-hls';
        const actions = dock.querySelector('.share-dock-actions');
        if (actions) dock.insertBefore(hlsSlot, actions);
      }
      if (hlsSlot) {
        hlsSlot.innerHTML = hlsToggleHtml;
        hlsSlot.classList.toggle('hidden', !hasHls);
      }

      const videoWrap = viewer.querySelector('.share-video-player');
      const video = viewer.querySelector('.share-video-el');
      const loading = document.getElementById('share-media-loading');
      this.applyVideoPoster(video, info, token);
      const stats = this.mountStats(info);

      this.resetMetrics(info);
      stats?.classList.remove('hidden');
      this.mountChunkBlocks(info, showHlsBlocks ? info.hls_segment_count : null);

      this._hlsPlaylistUrl = hasHls ? info.hls_playlist_url : null;
      this._hlsMode = hasHls && (useHls || useGithub) ? 'hls' : 'direct';
      this._hlsSegmentsDone = 0;
      this._hlsSegmentsTotal = showHlsBlocks ? (info.hls_segment_count || 0) : 0;
      this.syncChunksStatLabel();

      if (useUploadedHls) {
        void this.playWithHlsUrl(info, token, video, videoWrap, loading);
      } else {
        this.startStatusPoll(token, info);
        this.playDirectStream(info, token, video, videoWrap, loading);
      }

      if (this.clientStream && this._hlsMode !== 'hls') {
        ShareClientStream.load(token, info.id).catch((err) => {
          globalThis.ShareStreamLog?.warn('session:warm-failed', {
            message: globalThis.ShareStreamLog?.formatError?.(err) || err.message,
          });
        });
      }

      this.bindHlsToggle(info, token, video, videoWrap, loading);
      return;
    }

    if (this.currentMediaType === 'audio') {
      this.setCinemaMode(false);
      viewer.innerHTML = `
        <div class="viewer-media-area share-media-area">
          <div id="share-media-loading" class="viewer-loading">
            ${vaultLoaderHtml('Loading...', 'share-media-status')}
          </div>
          ${MediaPlayer.buildAudioPlayerHtml().replace('share-audio-player', 'share-audio-player hidden')}
        </div>
      `;

      const wrap = viewer.querySelector('.share-audio-player');
      const audio = viewer.querySelector('.share-audio-el');
      const canvas = viewer.querySelector('.share-audio-viz');
      const thumb = viewer.querySelector('.share-audio-thumb');
      const fallback = viewer.querySelector('.share-audio-thumb-fallback');
      const loading = document.getElementById('share-media-loading');
      const stats = this.mountStats(info);

      this.resetMetrics(info);
      stats?.classList.remove('hidden');
      this.mountChunkBlocks(info);

      MediaPlayer.setupAudioArt({
        thumbEl: thumb,
        fallbackEl: fallback,
        hasThumbnail: info.has_thumbnail,
        thumbUrl: info.has_thumbnail ? this.thumbnailUrl(token, info.id) : null,
      });

      this.startStatusPoll(token, info);
      MediaPlayer.attachStreamPlayback(audio, {
        onReady: () => this.onMediaReady(audio, wrap, loading),
        onError: () => {
          loading.classList.add('hidden');
          this.showError('Failed to load audio');
        },
      });
      audio.src = streamUrl;
      audio.load();
      return;
    }

    const previewType = getPreviewType(info.name, info.mime_type);
    if (previewType === 'pdf') {
      const box = document.createElement('div');
      box.id = 'share-pdf-mount';
      box.className = 'share-pdf-viewer';
      viewer.appendChild(box);
      void ShareLazyLibs.loadPdfViewer().then(() => {
        PdfViewer.mount(box, this.downloadUrl(token, info.id));
      }).catch(() => this.showError('Failed to load PDF viewer'));
      return;
    }
    if (previewType === 'text') {
      this.setCinemaMode(false);
      document.body.classList.add('share-text-active');
      document.getElementById('share-stage-controls')?.classList.add('hidden');
      const loading = document.createElement('div');
      loading.className = 'viewer-loading share-text-loading';
      loading.textContent = 'Loading preview…';
      viewer.appendChild(loading);
      fetch(this.downloadUrl(token, info.id))
        .then(async (r) => {
          if (!r.ok) {
            const err = await r.json().catch(() => ({}));
            throw new Error(err.error || `Preview failed (${r.status})`);
          }
          return r.text();
        })
        .then((text) => {
          loading.remove();
          const pre = document.createElement('pre');
          pre.className = 'viewer-text share-text-preview vault-scroll';
          pre.textContent = text.slice(0, 512000);
          viewer.appendChild(pre);
        })
        .catch(() => {
          viewer.innerHTML = '<p class="share-no-preview">Could not load preview — use Download.</p>';
        });
      return;
    }

    viewer.innerHTML = '<p class="share-no-preview">No preview — use Download.</p>';
  },

  showError(message) {
    const el = document.getElementById('share-error');
    if (el) {
      el.textContent = message;
      el.classList.remove('hidden');
    }
  },

  onMediaReady(el, wrap, loading) {
    if (this.mediaReady) return;
    this.mediaReady = true;
    this.ensurePageScrollTop();
    loading.classList.add('hidden');
    wrap.classList.remove('hidden');

    ShareShoutbox?.bindVideoPositionTracking?.();

    if (!this.plyr) {
      const isAudio = this.currentMediaType === 'audio';
      const canvas = wrap.querySelector('.share-audio-viz');
      if (isAudio) {
        void ShareLazyLibs.loadPlyr().then(() => {
          if (this.plyr) return;
          this.plyr = MediaPlayer.createPlyr(el, true, {
            onProgress: () => this.updatePlaybackStats(el),
            onTimeupdate: () => this.updatePlaybackStats(el),
            onPlay: () => MediaPlayer.resumeAudioViz(this.audioViz, el, canvas),
            onPause: () => MediaPlayer.drawAudioViz(this.audioViz, el, canvas),
            onEnded: () => {
              MediaPlayer.drawAudioViz(this.audioViz, el, canvas);
              if (this.playlistMode && typeof SharePlaylist !== 'undefined') {
                SharePlaylist.onMediaEnded();
              }
            },
          });
        }).catch(() => {});
      } else {
        void this.initVideoPlyr(el);
      }
    }

    if (this.currentMediaType === 'video' && this.plyr) {
      this.plyr.on('progress', () => this.updatePlaybackStats(el));
      this.plyr.on('timeupdate', () => this.updatePlaybackStats(el));
    }

    if (this.currentMediaType === 'audio') {
      if (!this.audioViz) this.audioViz = MediaPlayer.createAudioVizState();
      const canvas = wrap.querySelector('.share-audio-viz');
      MediaPlayer.initAudioViz(this.audioViz, el, canvas);
    }

    this.startPlaybackStats(el);

    this.syncDurationStat(el);
    const syncDuration = () => this.syncDurationStat(el);
    el.addEventListener('loadedmetadata', syncDuration);
    el.addEventListener('durationchange', syncDuration);

    if (this.currentFile?.id && (this.currentMediaType === 'video' || this.currentMediaType === 'audio')) {
      PlaybackMemory.detach(el);
      PlaybackMemory.track(el, this.currentFile, {
        status: this.lastServerStatus,
        onProgressUpdate: (fileId) => {
          if (this.playlistMode && typeof SharePlaylist !== 'undefined') {
            SharePlaylist.onProgressUpdate(fileId);
          }
        },
      });
    }

    if (this.currentMediaType === 'video') {
      this.fitCinemaStage(el);
      el.addEventListener('loadedmetadata', () => this.fitCinemaStage(el));
    }

    ShareStageLayout?.updateStageControls?.();
  },

  resetMetrics(file) {
    this.metrics = { lastBytes: 0, lastTime: 0, speed: 0, peakSpeed: 0 };
    this.lastChunkStateKey = null;
    this.setStat('share-stat-progress', '0%');
    this.setStat('share-stat-stage', 'Starting');
    this.setStat('share-stat-speed', '—');
    this.setStat('share-stat-buffered', '0%');
    this.setBar(0);
    if (file) {
      this.setStat('share-stat-size', formatSize(file.size));
      const total = this.usesHlsSegments()
        ? this.hlsSegmentTotal(file)
        : (file.chunk_count || 0);
      this.setChunksStat(0, total);
    }
    this.syncDurationStat();
  },

  usesHlsSegments() {
    return this._hlsMode === 'hls';
  },

  hlsSegmentTotal(file = this.currentFile) {
    return this._hlsSegmentsTotal
      || this.chunkBlocks?.layout?.total
      || file?.hls_segment_count
      || 0;
  },

  syncChunksStatLabel() {
    const labelEl = document.getElementById('share-stat-chunks')
      ?.closest('.viewer-stat')
      ?.querySelector('.viewer-stat-label');
    if (labelEl) labelEl.textContent = this.usesHlsSegments() ? 'Segments' : 'Chunks';
  },

  setChunksStat(completed, total) {
    this.syncChunksStatLabel();
    if (total > 0) {
      this.setStat('share-stat-chunks', `${Math.max(0, completed)} / ${total}`);
    } else {
      this.setStat('share-stat-chunks', '—');
    }
  },

  bindHlsSegmentTracking(info) {
    if (!this.hls || typeof Hls === 'undefined') return;
    const totalSegments = this.hlsSegmentTotal(info);
    this._hlsSegmentsTotal = totalSegments;
    this._hlsSegmentsDone = 0;
    this.syncChunksStatLabel();
    this.hls.on(Hls.Events.FRAG_LOADED, (event, data) => {
      this._hlsSegmentsDone = Math.max(this._hlsSegmentsDone, (data.frag?.sn || 0) + 1);
      if (this.chunkBlocks) {
        ChunkBlocks.update(this.chunkBlocks, {
          completed: this._hlsSegmentsDone,
          total: totalSegments,
          stage: 'hls',
        });
      }
      this.setChunksStat(this._hlsSegmentsDone, totalSegments);
    });
  },

  effectiveDuration(el = null) {
    if (typeof PlaybackMemory !== 'undefined') {
      return PlaybackMemory.effectiveDuration(this.currentFile, el, this.lastServerStatus);
    }
    const hls = Number(this.currentFile?.hls_duration_sec);
    if (hls > 0) return hls;
    if (this.lastServerStatus?.duration_sec > 0) return this.lastServerStatus.duration_sec;
    if (el?.duration && Number.isFinite(el.duration) && el.duration > 0) return el.duration;
    return 0;
  },

  syncDurationStat(el = null) {
    const dur = this.effectiveDuration(el);
    this.setStat('share-stat-duration', dur > 0 ? this.formatDuration(dur) : '—');
  },

  mergeFileMeta(info) {
    if (!info?.id || !this.currentFile || info.id !== this.currentFile.id) return;
    Object.assign(this.currentFile, info);
    const media = document.querySelector('#share-viewer .share-video-el, #share-viewer .share-audio-el');
    this.syncDurationStat(media);
  },

  formatDuration(seconds) {
    if (!seconds || !Number.isFinite(seconds)) return '—';
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  },

  setStat(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  },

  setBar(percent) {
    const bar = document.getElementById('share-stat-bar-fill');
    if (bar) bar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  },

  formatSpeed(bytesPerSec) {
    if (!bytesPerSec || bytesPerSec < 1) return '—';
    return `${formatSize(bytesPerSec)}/s`;
  },

  handleVideoError(token, file, video, loading) {
    if (this.videoRetry < 2) {
      this.videoRetry += 1;
      const delay = this.videoRetry === 1 ? 1000 : 2500;
      setTimeout(async () => {
        try {
          const res = await fetch(this.statusUrl(token, file.id));
          if (res.ok) {
            const s = await res.json();
            if (s.ready || s.buffered || (s.segments >= s.total_segments && s.total_segments > 0)) {
              const base = this.streamUrl(token, file.id);
              video.src = `${base}&retry=${Date.now()}`;
              video.load();
              return;
            }
          }
        } catch { /* retry below */ }
        if (this.videoRetry >= 2) this.failVideo(loading);
      }, delay);
      return;
    }
    this.failVideo(loading);
  },

  failVideo(loading) {
    loading.classList.add('hidden');
    this.showError('Failed to load video');
  },

  stageLabel(stage) {
    const labels = {
      streaming: 'Buffering',
      fetching: 'Fetching chunks',
      decrypting: 'Decrypting in browser',
      preparing: 'Preparing video',
      remuxing: 'Optimizing for playback',
      caching: 'Saving to disk cache',
      ready: 'Ready',
      offline: 'Offline — using cached copy',
      cached: 'Loaded from browser cache',
      hls: 'HLS streaming',
      error: 'Error',
    };
    return labels[stage] || stage || 'Loading';
  },

  estimateBytes(status, file) {
    if (status.buffered) return file.size;
    if (status.bytes_ready > 0) return status.bytes_ready;
    if (status.total_segments > 0) {
      return Math.round((status.segments / status.total_segments) * file.size);
    }
    if (status.progress > 0) {
      return Math.round((status.progress / 100) * file.size);
    }
    return 0;
  },

  updateSpeed(bytes) {
    const now = Date.now();
    if (this.metrics.lastTime) {
      const dt = (now - this.metrics.lastTime) / 1000;
      const db = bytes - this.metrics.lastBytes;
      if (dt > 0.2 && db >= 0) {
        const instant = db / dt;
        this.metrics.speed = this.metrics.speed
          ? this.metrics.speed * 0.6 + instant * 0.4
          : instant;
        this.metrics.peakSpeed = Math.max(this.metrics.peakSpeed, instant);
      }
    }
    this.metrics.lastBytes = bytes;
    this.metrics.lastTime = now;
  },

  updateFromStatus(status) {
    const file = this.currentFile;
    if (!file) return;

    this.syncDurationStat();

    const video = document.querySelector('#share-viewer .share-video-el');
    const isBuffering = video?.buffered?.length > 0;
    const total = this.usesHlsSegments()
      ? (status.total_segments || this.hlsSegmentTotal(file))
      : (status.total_segments || file.chunk_count || 0);
    const current = this.usesHlsSegments()
      ? Math.max(this._hlsSegmentsDone || 0, status.hls_segments || status.segments || 0)
      : (status.mode === 'hls'
        ? (status.hls_segments || status.segments || 0)
        : (status.segments || 0));

    if (this.mediaReady || isBuffering) {
      if (total > 0 && current >= 0) {
        this.setChunksStat(current, total);
      }
      if (status.bytes_ready > 0 && file.size > 0) {
        const pct = Math.round((status.bytes_ready / file.size) * 100);
        this.setStat('share-stat-buffered', `${pct}%`);
        this.setBar(pct);
      }
      this.updateChunkBlocks(status);
      return;
    }

    if (total > 0) {
      this.setChunksStat(current, total);
    } else if (!this.usesHlsSegments() && file.chunk_count) {
      this.setStat('share-stat-chunks', `— / ${file.chunk_count}`);
    }

    const progress = status.ready && status.buffered
      ? 100
      : (status.progress || (total > 0 ? Math.round((current / total) * 100) : 0));

    this.setStat('share-stat-progress', `${progress}%`);
    this.setStat('share-stat-stage', this.stageLabel(status.stage));
    this.setBar(progress);

    const bytes = this.estimateBytes(status, file);
    this.updateSpeed(bytes);
    this.setStat('share-stat-speed', this.formatSpeed(this.metrics.speed));

    if (status.ready && status.buffered) {
      this.setStat('share-stat-buffered', '100%');
      if (this.usesHlsSegments()) {
        this.setChunksStat(total, total);
      } else {
        this.setChunksStat(total, total > 0 ? total : (file.chunk_count || 0));
      }
    } else if (bytes > 0 && file.size > 0) {
      this.setStat('share-stat-buffered', `${Math.round((bytes / file.size) * 100)}%`);
    }

    this.updateChunkBlocks(status);
  },

  updatePlaybackStats(el) {
    const file = this.currentFile;
    if (!file) return;

    let bufferedPct = 0;
    let bufferedBytes = 0;

    if (this.lastServerStatus?.bytes_ready > 0 && file.size > 0) {
      bufferedBytes = this.lastServerStatus.bytes_ready;
      bufferedPct = Math.round((bufferedBytes / file.size) * 100);
    } else if (el.buffered.length > 0 && file.size > 0) {
      const knownDuration = this.effectiveDuration(el);
      if (knownDuration > 0) {
        const bufferedEnd = el.buffered.end(el.buffered.length - 1);
        bufferedPct = Math.min(100, Math.round((bufferedEnd / knownDuration) * 100));
        bufferedBytes = Math.round((bufferedPct / 100) * file.size);
      }
    } else {
      return;
    }

    this.syncDurationStat(el);

    this.setStat('share-stat-buffered', `${bufferedPct}%`);
    this.setStat('share-stat-stage', el.paused ? 'Paused' : 'Playing');
    this.setStat('share-stat-progress', `${bufferedPct}%`);
    this.setBar(bufferedPct);

    this.updateSpeed(bufferedBytes);
    this.setStat('share-stat-speed', this.formatSpeed(this.metrics.speed));

    if (this.usesHlsSegments()) {
      const total = this.hlsSegmentTotal(file);
      if (total > 0) this.setChunksStat(this._hlsSegmentsDone || 0, total);
    } else {
      const total = this.lastServerStatus?.total_segments || file.chunk_count;
      const segments = this.lastServerStatus?.segments;
      if (total && segments) {
        this.setChunksStat(segments, total);
      } else if (file.chunk_count && bufferedPct > 0) {
        const chunksLoaded = Math.min(file.chunk_count, Math.ceil((bufferedPct / 100) * file.chunk_count));
        this.setChunksStat(chunksLoaded, file.chunk_count);
      }
    }

    if (this.lastServerStatus) this.updateChunkBlocks(this.lastServerStatus);
  },

  startStatusPoll(token, file) {
    this.stopStatusPoll();
    const statusEl = document.getElementById('share-media-status');

    const tick = async () => {
      let nextDelay = 750;
      try {
        const res = await fetch(this.statusUrl(token, file.id));
        if (!res.ok) throw new Error('status failed');
        const s = await res.json();
        this.lastServerStatus = s;

        const video = document.querySelector('#share-viewer .share-video-el');
        const playing = this.mediaReady || (video?.buffered?.length > 0);

        if (!playing) {
          this.updateFromStatus(s);
        } else {
          nextDelay = 2000;
        }

        if (s.stage === 'error') {
          if (statusEl) statusEl.textContent = 'File cannot be played';
          return;
        }

        if (playing) {
          const pct = s.bytes_ready && file.size
            ? Math.round((s.bytes_ready / file.size) * 100)
            : s.progress;
          if (statusEl) {
            if (s.segments < s.total_segments) {
              statusEl.textContent = `Playing — chunk ${s.segments}/${s.total_segments} · ${pct}% buffered`;
            } else {
              statusEl.textContent = `Playing — ${pct}% buffered`;
            }
          }
          this.pollTimer = setTimeout(tick, nextDelay);
          return;
        }

        if (s.ready && s.buffered && s.mode !== 'incremental' && s.mode !== 'hls' && !playing) {
          if (statusEl) statusEl.textContent = 'Ready';
          this.pollTimer = setTimeout(tick, nextDelay);
          return;
        }

        if (s.mode === 'hls') {
          const segs = s.hls_segments || 0;
          const total = s.total_segments || file.chunk_count || 0;
          if (statusEl) {
            if (segs > 0) {
              statusEl.textContent = `Loading segment ${segs}/${total}...`;
            } else if (s.moov_ready) {
              statusEl.textContent = 'Preparing first segment...';
            } else {
              statusEl.textContent = 'Fetching video metadata...';
            }
          }
          if (segs >= total && total > 0) return;
          this.pollTimer = setTimeout(tick, nextDelay);
          return;
        }

        if (!statusEl) {
          this.pollTimer = setTimeout(tick, nextDelay);
          return;
        }

        if (s.stage === 'streaming' && s.bytes_ready > 0) {
          const pct = Math.round((s.bytes_ready / file.size) * 100);
          statusEl.textContent = `Buffering ${pct}% — chunk ${s.segments} of ${s.total_segments}`;
        } else if (s.mode === 'sequential' && s.stage === 'decrypting' && s.total_segments > 0) {
          statusEl.textContent = `Decrypting chunk ${s.segments} of ${s.total_segments}...`;
        } else if (s.stage === 'caching') {
          statusEl.textContent = 'Saving to cache — almost ready...';
        } else if (s.mode === 'incremental' && s.total_segments > 0) {
          statusEl.textContent = `Streaming chunk ${s.segments} of ${s.total_segments}...`;
        } else if (s.stage === 'streaming' && s.total_segments > 0) {
          statusEl.textContent = `Buffering chunk ${s.segments} of ${s.total_segments}...`;
        } else if (s.stage === 'decrypting') {
          statusEl.textContent = 'Decrypting...';
        } else if (s.total_segments > 0) {
          statusEl.textContent = `Fetching chunk ${s.segments} of ${s.total_segments}...`;
        } else {
          statusEl.textContent = 'Buffering...';
        }
      } catch {
        if (statusEl) statusEl.textContent = 'Loading...';
      }

      this.pollTimer = setTimeout(tick, nextDelay);
    };

    tick();
  },

  startPlaybackStats(el) {
    this.stopPlaybackStats();
    this.statsTimer = setInterval(() => this.updatePlaybackStats(el), 1200);
  },

  stopPlaybackStats() {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  },

  stopStatusPoll() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  },
};
