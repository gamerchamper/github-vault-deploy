const Viewer = {
  currentFile: null,
  currentMediaType: null,
  pollTimer: null,
  statsTimer: null,
  plyr: null,
  mediaReady: false,
  lastServerStatus: null,
  audioViz: null,
  metrics: {
    lastBytes: 0,
    lastTime: 0,
    speed: 0,
    peakSpeed: 0,
  },
  videoRetry: 0,
  hls: null,
  hlsUrl: null,
  hlsGithubUrl: null,
  hlsMode: 'proxy',

  chunkBlocks: null,
  lastChunkStateKey: null,
  activePlaylist: null,
  streamCleanups: new Map(),

  isHistoryFile(file) {
    return file != null && file._historyVersionId != null;
  },

  fileViewUrl(file) {
    if (this.isHistoryFile(file)) {
      return API.files.historyView(file.id, file._historyVersionId);
    }
    return API.files.view(file.id, explorer?.accountView);
  },

  fileStreamUrl(file) {
    if (this.isHistoryFile(file)) {
      return API.files.historyStream(file.id, file._historyVersionId);
    }
    return API.files.stream(file.id, explorer?.accountView);
  },

  resetMediaElement(el) {
    if (!el) return;
    PlaybackMemory.detach(el);
    const cleanup = this.streamCleanups.get(el);
    if (cleanup) {
      cleanup();
      this.streamCleanups.delete(el);
    }
    el.oncanplay = null;
    el.onplaying = null;
    el.onended = null;
    el.onerror = null;
  },

  setStreamCleanup(el, cleanup) {
    if (!el) return;
    const prev = this.streamCleanups.get(el);
    if (prev) prev();
    if (cleanup) this.streamCleanups.set(el, cleanup);
    else this.streamCleanups.delete(el);
  },

  shouldUseHls(file, status = null) {
    const ext = file.name.split('.').pop().toLowerCase();
    const isMp4 = file.mime_type === 'video/mp4' || ext === 'mp4';
    if (!isMp4 || !file.chunk_count || file.chunk_count < 2) return false;
    if (status) {
      if (status.use_hls === false) return false;
      if (status.mode === 'faststart' || status.mode === 'cached') return false;
      if (status.use_hls) return true;
    }
    return true;
  },

  playDirectStream(file, video, videoWrap, loading) {
    this.resetMediaElement(video);
    this.setStreamCleanup(video, MediaPlayer.attachStreamPlayback(video, {
      onReady: () => this.onMediaReady(video, videoWrap),
      onPlaying: () => this.setStat('stat-stage', 'Playing'),
      onError: () => this.handleVideoError(file, video, loading),
    }));
    video.src = this.fileStreamUrl(file);
    video.load();
  },

  async playVideo(file, video, videoWrap, loading) {
    if (this.isHistoryFile(file)) {
      this.playDirectStream(file, video, videoWrap, loading);
      return;
    }
    let status = null;
    try {
      status = await API.files.status(file.id);
      this.lastServerStatus = status;
      this.updateFromStatus(status);
    } catch { /* fall through */ }

    if (file.has_hls) {
      this.playWithUploadedHls(file, video, videoWrap, loading);
      return;
    }

    if (this.shouldUseHls(file, status)) {
      this.playWithHls(file, video, videoWrap, loading);
      return;
    }

    this.playDirectStream(file, video, videoWrap, loading);
  },

  destroyHls() {
    if (this.hlsFallbackTimer) {
      clearTimeout(this.hlsFallbackTimer);
      this.hlsFallbackTimer = null;
    }
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
  },

  playWithHls(file, video, videoWrap, loading) {
    this.destroyHls();
    this.resetMediaElement(video);
    this.hlsFallbackTimer = setTimeout(() => {
      if (!this.mediaReady) {
        this.destroyHls();
        this.playDirectStream(file, video, videoWrap, loading);
      }
    }, 20000);

    if (typeof Hls === 'undefined' || !Hls.isSupported()) {
      clearTimeout(this.hlsFallbackTimer);
      this.playDirectStream(file, video, videoWrap, loading);
      return;
    }

    this.hls = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      backBufferLength: 90,
      manifestLoadingMaxRetry: 12,
      manifestLoadingRetryDelay: 1000,
    });

    const playlistUrl = API.files.hlsPlaylist(file.id, explorer.accountView);
    this.hls.loadSource(playlistUrl);
    this.hls.attachMedia(video);

    video.oncanplay = () => {
      clearTimeout(this.hlsFallbackTimer);
      this.onMediaReady(video, videoWrap);
    };
    video.onplaying = () => this.setStat('stat-stage', 'Playing');

    this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {});
    });

    this.hls.on(Hls.Events.FRAG_BUFFERED, () => {
      if (video.buffered.length > 0) {
        clearTimeout(this.hlsFallbackTimer);
        this.onMediaReady(video, videoWrap);
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
      this.playDirectStream(file, video, videoWrap, loading);
    });
  },

  playWithUploadedHls(file, video, videoWrap, loading) {
    this.destroyHls();
    this.resetMediaElement(video);
    if (typeof Hls === 'undefined' || !Hls.isSupported()) {
      this.playDirectStream(file, video, videoWrap, loading);
      return;
    }
    const playlistUrl = this.hlsMode === 'github' && this.hlsGithubUrl
      ? this.hlsGithubUrl
      : API.files.hlsUploadedPlaylist(file.id, explorer.accountView);
    if (!playlistUrl) {
      this.playDirectStream(file, video, videoWrap, loading);
      return;
    }
    this.hls = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
      xhrSetup(xhr, url) {
        if (url && (url.startsWith('/') || url.startsWith(location.origin))) {
          xhr.withCredentials = true;
        }
      },
      fetchSetup(context, init) {
        if (context.url && (context.url.startsWith('/') || context.url.startsWith(location.origin))) {
          init.credentials = 'include';
        }
        return new Request(context.url, init);
      },
    });
    this.hls.loadSource(playlistUrl);
    this.hls.attachMedia(video);

    let hlsSegmentsDone = 0;
    const ext = file.name.split('.').pop().toLowerCase();
    const totalSegments = file.hls_segment_count || file.chunk_count || 0;
    this.hls.on(Hls.Events.FRAG_LOADED, (event, data) => {
      hlsSegmentsDone = Math.max(hlsSegmentsDone, (data.frag?.sn || 0) + 1);
      if (this.chunkBlocks) {
        ChunkBlocks.update(this.chunkBlocks, { completed: hlsSegmentsDone, total: totalSegments, stage: 'hls' });
      }
      this.setStat('stat-chunks', `${hlsSegmentsDone} / ${totalSegments || '?'}`);
    });

    this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
      video.play().catch(() => {});
    });
    this.hls.on(Hls.Events.FRAG_BUFFERED, () => {
      if (video.buffered.length > 0) {
        videoWrap.classList.remove('hidden');
        this.onMediaReady(video, videoWrap);
      }
    });
    this.hls.on(Hls.Events.ERROR, (event, data) => {
      if (!data.fatal) return;
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) { this.hls.startLoad(); return; }
      if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { this.hls.recoverMediaError(); return; }
      this.destroyHls();
      this.playDirectStream(file, video, videoWrap, loading);
    });
    this.setStat('stat-stage', 'HLS');
  },

  hidePanels() {
    document.getElementById('viewer-image').classList.add('hidden');
    document.getElementById('viewer-video-wrap').classList.add('hidden');
    document.getElementById('viewer-audio-wrap').classList.add('hidden');
    document.getElementById('viewer-frame').classList.add('hidden');
    document.getElementById('viewer-text').classList.add('hidden');
    document.getElementById('viewer-stats').classList.add('hidden');
    document.getElementById('viewer-pdf-mount')?.remove();
    PdfViewer?.destroy?.('viewer-pdf-mount');
    ImageViewer?.destroy?.();
    if (this.chunkBlocks) {
      ChunkBlocks.destroy(this.chunkBlocks);
      this.chunkBlocks = null;
    }
    const blocksEl = document.getElementById('viewer-chunk-blocks');
    if (blocksEl) blocksEl.innerHTML = '';
  },

  mountChunkBlocks(file) {
    const blocksEl = document.getElementById('viewer-chunk-blocks');
    if (!blocksEl || !file?.chunk_count) return;
    if (this.chunkBlocks) ChunkBlocks.destroy(this.chunkBlocks);
    this.chunkBlocks = ChunkBlocks.mount(blocksEl, {
      total: file.chunk_count,
      label: 'Stream blocks',
    });
  },

  updateChunkBlocks(status) {
    if (!this.chunkBlocks || !this.currentFile) return;
    const state = ChunkBlocks.fromStreamStatus(status, this.currentFile);
    const key = ChunkBlocks.stateKey(state);
    if (this.lastChunkStateKey === key) return;
    this.lastChunkStateKey = key;
    ChunkBlocks.update(this.chunkBlocks, state);
  },

  openFromPlaylist(file, playlist) {
    this.activePlaylist = playlist || null;
    if (playlist && typeof PlaylistQueue !== 'undefined') {
      PlaylistQueue.setFromPlaylist(playlist, file.id);
      if (typeof PlaylistPlayer !== 'undefined') PlaylistPlayer.show(playlist);
    }
    const ok = this.open(file);
    if (ok) this.updatePlaylistUrl();
    return ok;
  },

  updatePlaylistUrl() {
    if (!PlaylistQueue?.playlistId) return;
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('playlist', PlaylistQueue.playlistId);
      if (this.currentFile?.id) url.searchParams.set('file', this.currentFile.id);
      history.replaceState({}, '', url);
    } catch { /* ignore */ }
  },

  open(file) {
    const type = getPreviewType(file.name, file.mime_type);
    if (!type) return false;

    this.destroyPlyr();
    this.destroyHls();
    this.stopAudioViz();
    this.mediaReady = false;
    this.videoRetry = 0;
    this.currentFile = file;
    this.currentMediaType = type;
    const modal = document.getElementById('media-viewer');
    const img = document.getElementById('viewer-image');
    const video = document.getElementById('viewer-video');
    const audio = document.getElementById('viewer-audio');
    const videoWrap = document.getElementById('viewer-video-wrap');
    const audioWrap = document.getElementById('viewer-audio-wrap');
    this.resetMediaElement(video);
    this.resetMediaElement(audio);
    const frame = document.getElementById('viewer-frame');
    const textEl = document.getElementById('viewer-text');
    const loading = document.getElementById('viewer-loading');
    const stats = document.getElementById('viewer-stats');

    const title = typeof DisplayNames !== 'undefined'
      ? DisplayNames.get(file.id, file.name)
      : file.name;
    const histSuffix = file._historyLabel ? ` · ${file._historyLabel}` : '';
    document.getElementById('viewer-title').textContent = title + histSuffix;
    modal.classList.remove('hidden');
    if (typeof ViewerPanelLayout !== 'undefined') ViewerPanelLayout.onViewerOpen();
    loading.classList.remove('hidden');
    this.hidePanels();
    img.removeAttribute('src');
    video.removeAttribute('src');
    audio.removeAttribute('src');
    frame.removeAttribute('src');
    frame.removeAttribute('sandbox');
    textEl.textContent = '';

    this.resetMetrics();
    this.lastChunkStateKey = null;
    document.getElementById('stat-size').textContent = formatSize(file.size);
    document.getElementById('stat-chunks').textContent = file.chunk_count
      ? `0 / ${file.chunk_count}`
      : '—';

    const hlsBtn = document.getElementById('viewer-hls-url');
    const hlsGitBtn = document.getElementById('viewer-hls-github');
    hlsBtn.classList.add('hidden');
    hlsGitBtn.classList.add('hidden');
    this.hlsUrl = null;
    this.hlsGithubUrl = null;
    this.hlsMode = localStorage.getItem('viewerHlsMode') === 'github' ? 'github' : 'proxy';
    const hlsToggleEl = document.getElementById('viewer-hls-toggle');
    if (hlsToggleEl) hlsToggleEl.classList.add('hidden');

    if (type === 'image') {
      img.onload = () => {
        const area = document.querySelector('.viewer-media-area');
        ImageViewer.mount(area, img);
        this.showMedia(img);
      };
      img.onerror = () => {
        loading.classList.add('hidden');
        App.toast('Failed to load image', 'error');
        this.close();
      };
      img.src = this.fileViewUrl(file);
    } else if (type === 'video') {
      stats.classList.remove('hidden');
      if (!this.isHistoryFile(file)) {
        this.mountChunkBlocks(file);
        this.startStatusPoll(file);
      } else {
        document.getElementById('stat-chunks').textContent = file.chunk_count ? String(file.chunk_count) : '—';
      }
      video.removeAttribute('poster');
      if (file.has_thumbnail && !ThumbCache.isFailed(file.id, file.thumbVersion)) {
        const posterUrl = ThumbCache.resolveUrl(file.id, file.thumbVersion);
        if (posterUrl) {
          video.poster = posterUrl;
          ThumbCache.prefetch(file.id, file.thumbVersion).then((url) => {
            if (url && video.isConnected) video.poster = url;
          }).catch(() => {
            video.removeAttribute('poster');
          });
        }
      }
      this.playVideo(file, video, videoWrap, loading);
      const isMp4 = file.mime_type === 'video/mp4' || file.name.split('.').pop().toLowerCase() === 'mp4';
      const hlsToggleEl = document.getElementById('viewer-hls-toggle');
      if (file.has_hls) {
        this.hlsUrl = API.files.hlsUploadedPlaylist(file.id, explorer.accountView);
        fetch(API.files.hlsGithubPlaylist(file.id))
          .then(r => r.json())
          .then(d => { this.hlsGithubUrl = d.url; hlsGitBtn.classList.remove('hidden'); })
          .catch(() => {});
        if (hlsToggleEl) {
          hlsToggleEl.innerHTML = `
            <button class="btn-hls-mode ${this.hlsMode === 'proxy' ? 'active' : ''}" data-hls-mode="proxy">HLS</button>
            <button class="btn-hls-mode ${this.hlsMode === 'github' ? 'active' : ''}" data-hls-mode="github">HLS (GitHub)</button>
          `;
          hlsToggleEl.classList.remove('hidden');
        }
      } else if (isMp4 && file.chunk_count >= 2) {
        this.hlsUrl = API.files.hlsPlaylist(file.id, explorer.accountView);
      }
      if (this.hlsUrl) hlsBtn.classList.remove('hidden');
    } else if (type === 'audio') {
      if (!this.isHistoryFile(file) && !PlaylistQueue?.playlistId && typeof AudioQueue !== 'undefined') {
        AudioQueue.setFromFolder(explorer.files, file);
      }
      stats.classList.remove('hidden');
      if (!this.isHistoryFile(file)) {
        this.mountChunkBlocks(file);
        this.setupAudioArt(file);
        this.startStatusPoll(file);
      }
      this.setStreamCleanup(audio, MediaPlayer.attachStreamPlayback(audio, {
        onReady: () => this.onMediaReady(audio, audioWrap),
        onError: () => {
          loading.classList.add('hidden');
          App.toast('Failed to load audio', 'error');
          this.close();
        },
      }));
      audio.src = this.fileStreamUrl(file);
      audio.load();
    } else if (type === 'pdf') {
      loading.classList.add('hidden');
      const mount = document.createElement('div');
      mount.id = 'viewer-pdf-mount';
      mount.className = 'pdf-viewer-wrap';
      document.querySelector('.viewer-media-area')?.appendChild(mount);
      PdfViewer.mount(mount, this.fileViewUrl(file));
      return true;
    } else if (type === 'html') {
      frame.onload = () => this.showMedia(frame);
      frame.onerror = () => {
        loading.classList.add('hidden');
        App.toast('Failed to load document', 'error');
        this.close();
      };
      frame.removeAttribute('sandbox');
      frame.src = this.fileViewUrl(file);
    } else if (type === 'text') {
      this.loadTextPreview(file, textEl, loading);
    }

    return true;
  },

  async loadTextPreview(file, textEl, loading) {
    const maxPreview = 2 * 1024 * 1024;
    try {
      const res = await fetch(this.fileViewUrl(file), { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Failed to load file');
      const blob = await res.blob();
      const slice = blob.size > maxPreview ? blob.slice(0, maxPreview) : blob;
      let text = await slice.text();
      if (blob.size > maxPreview) {
        text += `\n\n— Preview truncated (${formatSize(maxPreview)} of ${formatSize(file.size)}) —`;
      }
      textEl.textContent = text;
      this.showMedia(textEl);
    } catch (err) {
      loading.classList.add('hidden');
      App.toast(err.message || 'Failed to load preview', 'error');
      this.close();
    }
  },

  setupAudioArt(file) {
    const v = file.thumbVersion ? `?v=${file.thumbVersion}` : '';
    MediaPlayer.setupAudioArt({
      thumbEl: document.getElementById('viewer-audio-thumb'),
      fallbackEl: document.getElementById('viewer-audio-thumb-fallback'),
      hasThumbnail: file.has_thumbnail,
      thumbUrl: file.has_thumbnail ? `/api/files/thumbnail/${file.id}${v}` : null,
    });
  },

  onMediaReady(el, wrap) {
    if (this.mediaReady) return;
    this.mediaReady = true;
    this.showMedia(wrap);
    if (!this.plyr) {
      const isAudio = this.currentMediaType === 'audio';
      const canvas = document.getElementById('viewer-audio-viz');
      this.plyr = MediaPlayer.createPlyr(el, isAudio, {
        onProgress: () => this.updatePlaybackStats(el),
        onTimeupdate: () => this.updatePlaybackStats(el),
        onPlay: isAudio ? () => MediaPlayer.resumeAudioViz(this.audioViz, el, canvas) : null,
        onPause: isAudio ? () => MediaPlayer.drawAudioViz(this.audioViz, el, canvas) : null,
        onEnded: isAudio ? () => MediaPlayer.drawAudioViz(this.audioViz, el, canvas) : null,
      });
    }
    if (this.currentFile?.id && (this.currentMediaType === 'video' || this.currentMediaType === 'audio')) {
      PlaybackMemory.detach(el);
      PlaybackMemory.track(el, this.currentFile, {
        status: this.lastServerStatus,
        onProgressUpdate: (fileId) => PlaylistPlayer?.onProgressUpdate?.(fileId),
      });
    }
    if (this.currentMediaType === 'audio') {
      if (!this.audioViz) this.audioViz = MediaPlayer.createAudioVizState();
      MediaPlayer.initAudioViz(this.audioViz, el, document.getElementById('viewer-audio-viz'));
      el.onended = () => this.handleQueueEnded(el);
    }
    if (this.currentMediaType === 'video') {
      el.onended = () => this.handleQueueEnded(el);
    }
    this.startPlaybackStats(el);
    if (this.currentMediaType === 'video') {
      if (typeof ViewerPanelLayout !== 'undefined' && ViewerPanelLayout.shouldSkipAutoFit()) {
        ViewerPanelLayout.applySaved();
      } else {
        this.fitModalToVideo(el);
      }
    }
    if (PlaylistQueue?.playlistId && this.currentFile?.id) {
      PlaylistPlayer?.render?.();
    }
  },

  handleQueueEnded(el) {
    if (PlaylistQueue?.playlistId) {
      if (PlaylistQueue.repeat === 'one') {
        el.currentTime = 0;
        el.play().catch(() => {});
        return;
      }
      PlaylistPlayer?.onMediaEnded?.();
      return;
    }
    if (typeof AudioQueue === 'undefined') return;
    if (AudioQueue.repeat === 'one') {
      el.currentTime = 0;
      el.play().catch(() => {});
      return;
    }
    const next = AudioQueue.next();
    if (next) this.open(next);
  },

  fitModalToVideo(video) {
    if (typeof ViewerPanelLayout !== 'undefined' && ViewerPanelLayout.shouldSkipAutoFit()) {
      ViewerPanelLayout.applySaved();
      return;
    }
    if (!video.videoWidth || !video.videoHeight) { setTimeout(() => this.fitModalToVideo(video), 200); return; }
    const panel = document.querySelector('.viewer-panel');
    if (!panel) return;
    const maxPanelW = window.innerWidth * 0.95;
    const maxPanelH = window.innerHeight * 0.9;
    const headerH = document.querySelector('.viewer-header')?.offsetHeight || 44;
    const statsEl = document.getElementById('viewer-stats');
    const statsH = statsEl && !statsEl.classList.contains('hidden') ? statsEl.offsetHeight : 0;
    const availH = maxPanelH - headerH - statsH;
    const aspect = video.videoWidth / video.videoHeight;
    let h = Math.max(availH, 300);
    let w = h * aspect;
    if (w > maxPanelW) { w = maxPanelW; h = w / aspect; }
    const totalH = Math.round(h + headerH + statsH);
    panel.style.width = Math.round(w) + 'px';
    panel.style.maxWidth = 'none';
    panel.style.height = Math.min(totalH, Math.round(maxPanelH)) + 'px';
    panel.style.maxHeight = 'none';
    if (typeof ViewerPanelLayout !== 'undefined') ViewerPanelLayout.syncOverlays();
  },

  stopAudioViz() {
    MediaPlayer.stopAudioViz(this.audioViz);
  },

  resetMetrics() {
    this.metrics = { lastBytes: 0, lastTime: 0, speed: 0, peakSpeed: 0 };
    this.setStat('stat-progress', '0%');
    this.setStat('stat-stage', 'Starting');
    this.setStat('stat-speed', '—');
    this.setStat('stat-duration', '—');
    this.setStat('stat-buffered', '0%');
    this.setBar(0);
    if (this.chunkBlocks && this.currentFile) {
      ChunkBlocks.update(this.chunkBlocks, { completed: 0, total: this.currentFile.chunk_count, stage: 'starting' });
    }
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
    const bar = document.getElementById('stat-bar-fill');
    if (bar) bar.style.width = `${Math.min(100, Math.max(0, percent))}%`;
  },

  formatSpeed(bytesPerSec) {
    if (!bytesPerSec || bytesPerSec < 1) return '—';
    return `${formatSize(bytesPerSec)}/s`;
  },

  handleVideoError(file, video, loading) {
    if (this.videoRetry < 2) {
      this.videoRetry += 1;
      const delay = this.videoRetry === 1 ? 1000 : 2500;
      setTimeout(async () => {
        try {
          const s = await API.files.status(file.id);
          if (s.ready || s.buffered || (s.segments >= s.total_segments && s.total_segments > 0)) {
            const base = this.fileStreamUrl(file);
            const sep = base.includes('?') ? '&' : '?';
            video.src = `${base}${sep}retry=${Date.now()}`;
            video.load();
            return;
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
    App.toast('Failed to load video', 'error');
    this.close();
  },

  stageLabel(stage, mode) {
    const labels = {
      streaming: 'Buffering',
      fetching: 'Fetching chunks',
      decrypting: 'Decrypting',
      preparing: 'Preparing video',
      remuxing: 'Optimizing for playback',
      caching: 'Saving to disk cache',
      ready: 'Ready',
      cached: 'Cached',
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

    if (status.duration_sec) {
      this.setStat('stat-duration', this.formatDuration(status.duration_sec));
    }

    const video = document.getElementById('viewer-video');
    const isBuffering = video.buffered && video.buffered.length > 0;
    const total = status.total_segments || file.chunk_count || 0;
    const current = status.mode === 'hls'
      ? (status.hls_segments || status.segments || 0)
      : (status.segments || 0);

    if (this.mediaReady || isBuffering) {
      if (total > 0 && current > 0) {
        this.setStat('stat-chunks', `${current} / ${total}`);
      }
      if (status.bytes_ready > 0 && file.size > 0) {
        const pct = Math.round((status.bytes_ready / file.size) * 100);
        this.setStat('stat-buffered', `${pct}%`);
        this.setBar(pct);
      }
      this.updateChunkBlocks(status);
      return;
    }

    if (total > 0) {
      this.setStat('stat-chunks', `${current} / ${total}`);
    } else if (file.chunk_count) {
      this.setStat('stat-chunks', `— / ${file.chunk_count}`);
    }

    const progress = status.ready && status.buffered
      ? 100
      : (status.progress || (total > 0 ? Math.round((current / total) * 100) : 0));

    this.setStat('stat-progress', `${progress}%`);
    this.setStat('stat-stage', this.stageLabel(status.stage, status.mode));
    this.setBar(progress);

    const bytes = this.estimateBytes(status, file);
    this.updateSpeed(bytes);
    this.setStat('stat-speed', this.formatSpeed(this.metrics.speed));

    if (status.ready && status.buffered) {
      this.setStat('stat-buffered', '100%');
      this.setStat('stat-chunks', total > 0 ? `${total} / ${total}` : (file.chunk_count ? `${file.chunk_count} / ${file.chunk_count}` : '—'));
    } else if (bytes > 0 && file.size > 0) {
      this.setStat('stat-buffered', `${Math.round((bytes / file.size) * 100)}%`);
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
      const knownDuration = this.lastServerStatus?.duration_sec || el.duration;
      if (knownDuration && isFinite(knownDuration) && knownDuration > 0) {
        const bufferedEnd = el.buffered.end(el.buffered.length - 1);
        bufferedPct = Math.min(100, Math.round((bufferedEnd / knownDuration) * 100));
        bufferedBytes = Math.round((bufferedPct / 100) * file.size);
      }
    } else {
      return;
    }

    this.setStat('stat-buffered', `${bufferedPct}%`);
    this.setStat('stat-stage', el.paused ? 'Paused' : 'Playing');
    this.setStat('stat-progress', `${bufferedPct}%`);
    this.setBar(bufferedPct);

    this.updateSpeed(bufferedBytes);
    this.setStat('stat-speed', this.formatSpeed(this.metrics.speed));

    const total = this.lastServerStatus?.total_segments || file.chunk_count;
    const segments = this.lastServerStatus?.segments;
    if (total && segments) {
      this.setStat('stat-chunks', `${segments} / ${total}`);
    } else if (file.chunk_count && bufferedPct > 0) {
      const chunksLoaded = Math.min(file.chunk_count, Math.ceil((bufferedPct / 100) * file.chunk_count));
      this.setStat('stat-chunks', `${chunksLoaded} / ${file.chunk_count}`);
    }

    if (this.lastServerStatus) this.updateChunkBlocks(this.lastServerStatus);
  },

  scheduleStatusPoll(file) {
    this.stopStatusPoll();
    const statusEl = document.getElementById('viewer-status');

    const tick = async () => {
      let nextDelay = 750;
      try {
        const s = await API.files.status(file.id);
        this.lastServerStatus = s;

        const video = document.getElementById('viewer-video');
        const playing = this.mediaReady || (video.buffered && video.buffered.length > 0);

        if (!playing) {
          this.updateFromStatus(s);
        } else {
          nextDelay = 2000;
        }

        if (s.stage === 'error') {
          statusEl.textContent = 'File cannot be played';
          App.toast('File incomplete or corrupt — try re-uploading', 'error');
          return;
        }

        if (playing) {
          const pct = s.bytes_ready && file.size
            ? Math.round((s.bytes_ready / file.size) * 100)
            : s.progress;
          if (s.segments < s.total_segments) {
            statusEl.textContent = `Playing — chunk ${s.segments}/${s.total_segments} · ${pct}% buffered`;
          } else {
            statusEl.textContent = `Playing — ${pct}% buffered`;
          }
          this.pollTimer = setTimeout(tick, nextDelay);
          return;
        }

        if (s.ready && s.buffered && s.mode !== 'incremental' && s.mode !== 'hls' && !playing) {
          statusEl.textContent = 'Ready';
          this.pollTimer = setTimeout(tick, nextDelay);
          return;
        }

        if (s.mode === 'hls') {
          const segs = s.hls_segments || 0;
          const total = s.total_segments || file.chunk_count || 0;
          if (segs > 0) {
            statusEl.textContent = `Loading segment ${segs}/${total}...`;
          } else if (s.moov_ready) {
            statusEl.textContent = 'Preparing first segment...';
          } else {
            statusEl.textContent = 'Fetching video metadata...';
          }
          if (segs >= total && total > 0) return;
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
        statusEl.textContent = 'Loading...';
      }

      this.pollTimer = setTimeout(tick, nextDelay);
    };

    tick();
  },

  startStatusPoll(file) {
    this.scheduleStatusPoll(file);
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

  showMedia(wrapOrEl) {
    document.getElementById('viewer-loading').classList.add('hidden');
    if (
      wrapOrEl.classList.contains('viewer-player-wrap')
      || wrapOrEl.classList.contains('viewer-media')
      || wrapOrEl.classList.contains('viewer-frame')
      || wrapOrEl.classList.contains('viewer-text')
    ) {
      wrapOrEl.classList.remove('hidden');
    }
  },

  stopStatusPoll() {
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  },

  destroyPlyr() {
    if (this.plyr) {
      this.plyr.destroy();
      this.plyr = null;
    }
    this.audioViz = null;
  },

  close() {
    this.stopStatusPoll();
    this.stopPlaybackStats();
    this.stopAudioViz();
    this.destroyPlyr();
    this.destroyHls();
    this.currentMediaType = null;
    if (this.chunkBlocks) {
      ChunkBlocks.destroy(this.chunkBlocks);
      this.chunkBlocks = null;
    }

    const video = document.getElementById('viewer-video');
    const audio = document.getElementById('viewer-audio');
    const img = document.getElementById('viewer-image');
    const frame = document.getElementById('viewer-frame');

    this.resetMediaElement(video);
    this.resetMediaElement(audio);
    img.onerror = null;
    if (frame) frame.onerror = null;

    video.pause();
    audio.pause();
    video.removeAttribute('src');
    audio.removeAttribute('src');
    img.removeAttribute('src');
    if (frame) frame.removeAttribute('src');

    document.getElementById('viewer-hls-url').classList.add('hidden');
    document.getElementById('viewer-hls-github').classList.add('hidden');
    this.hlsUrl = null;
    this.hlsGithubUrl = null;
    this.hidePanels();
    document.getElementById('media-viewer').classList.add('hidden');
    document.getElementById('media-viewer')?.classList.remove('viewer-has-playlist');
    if (typeof ViewerPanelLayout !== 'undefined') ViewerPanelLayout.onViewerClose();
    PlaylistPlayer?.hide?.();
    this.activePlaylist = null;
    this.currentFile = null;
    this.lastChunkStateKey = null;
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete('playlist');
      url.searchParams.delete('file');
      history.replaceState({}, '', url);
    } catch { /* ignore */ }
  },

  bindEvents() {
    if (typeof ViewerPanelLayout !== 'undefined') ViewerPanelLayout.init();
    document.getElementById('viewer-close').addEventListener('click', () => this.close());
    document.querySelector('.viewer-backdrop').addEventListener('click', () => this.close());
    document.getElementById('viewer-download').addEventListener('click', () => {
      if (!this.currentFile) return;
      DownloadManager.downloadFile(this.currentFile, { view: explorer.accountView });
    });
    document.getElementById('viewer-hls-url').addEventListener('click', () => {
      if (!this.hlsUrl) return;
      const a = document.createElement('a');
      a.href = this.hlsUrl;
      const baseName = (this.currentFile?.name || 'media').replace(/\.[^.]+$/, '');
      a.download = baseName + '.m3u8';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });
    document.getElementById('viewer-hls-github').addEventListener('click', () => {
      if (this.hlsGithubUrl) window.open(this.hlsGithubUrl, '_blank');
    });
    document.getElementById('viewer-hls-toggle').addEventListener('click', (e) => {
      const btn = e.target.closest('.btn-hls-mode');
      if (!btn || !this.currentFile) return;
      const mode = btn.dataset.hlsMode;
      if (mode === this.hlsMode) return;
      this.hlsMode = mode;
      localStorage.setItem('viewerHlsMode', mode);
      btn.parentElement.querySelectorAll('.btn-hls-mode').forEach(b => b.classList.toggle('active', b.dataset.hlsMode === mode));
      const file = this.currentFile;
      const video = document.getElementById('viewer-video');
      const videoWrap = document.getElementById('viewer-video-wrap');
      const loading = document.getElementById('viewer-loading');
      this.mediaReady = false;
      this.destroyHls();
      video.pause();
      video.removeAttribute('src');
      video.load();
      videoWrap.classList.add('hidden');
      loading.classList.remove('hidden');
      const isMp4 = file.mime_type === 'video/mp4' || file.name.split('.').pop().toLowerCase() === 'mp4';
      if (file.has_hls) this.playWithUploadedHls(file, video, videoWrap, loading);
      else if (isMp4 && file.chunk_count >= 2) this.playWithHls(file, video, videoWrap, loading);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !document.getElementById('media-viewer').classList.contains('hidden')) {
        this.close();
      }
    });
  },
};
