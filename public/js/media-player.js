const MediaPlayer = {
  CONTROLS_AUDIO: ['play-large', 'play', 'progress', 'current-time', 'duration', 'mute', 'volume', 'settings', 'airplay'],
  CONTROLS_VIDEO: ['play-large', 'play', 'progress', 'current-time', 'duration', 'mute', 'volume', 'settings', 'pip', 'airplay', 'fullscreen'],

  CAST_ICON: `<svg class="icon--cast" role="presentation" focusable="false" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11zm20-7H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z"/></svg>`,

  /** Prepare a <video> for browser-native enhancement (Edge VSR, RTX VSR, HW decode). */
  configureVideoElement(video, options = {}) {
    if (!video || video.tagName !== 'VIDEO') return video;

    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.playsInline = true;
    video.setAttribute('x-webkit-airplay', 'allow');
    video.disableRemotePlayback = false;
    if (!video.getAttribute('preload')) video.setAttribute('preload', 'auto');
    // Edge/Chrome attach hover quick actions (Enhance, PiP, etc.) to controlled videos.
    video.setAttribute('controls', '');
    if (!video.getAttribute('controlslist')) {
      video.setAttribute('controlslist', 'nodownload');
    }
    video.classList.add('vault-video-enhanced');

    if ('disablePictureInPicture' in video) {
      video.disablePictureInPicture = false;
    }

    const wrap = video.closest('.viewer-player-wrap, .share-video-player, .details-preview-media');
    if (options.enhancerWrap !== false && wrap) {
      wrap.classList.add('vault-video-enhanced-wrap');
    }

    return video;
  },

  configureAudioElement(audio, options = {}) {
    if (!audio || audio.tagName !== 'AUDIO') return audio;

    audio.setAttribute('x-webkit-airplay', 'allow');
    audio.disableRemotePlayback = false;
    audio.classList.add('vault-audio-remote');

    const wrap = audio.closest('.viewer-player-wrap, .share-audio-player, .details-preview-media');
    if (options.enhancerWrap !== false && wrap) {
      wrap.classList.add('vault-audio-remote-wrap');
    }

    return audio;
  },

  supportsRemotePlayback(media) {
    return !!(media && 'remote' in media && typeof media.remote?.watchAvailability === 'function');
  },

  insertControlButton(plyr, name, label, html, anchorName) {
    const controls = plyr?.elements?.controls;
    if (!controls || controls.querySelector(`[data-plyr="${name}"]`)) return null;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'plyr__controls__item plyr__control';
    btn.dataset.plyr = name;
    btn.hidden = true;
    btn.innerHTML = `${html}<span class="plyr__tooltip" role="tooltip">${label}</span><span class="plyr__sr-only">${label}</span>`;

    const anchor = controls.querySelector(`[data-plyr="${anchorName}"]`);
    if (anchor?.parentNode) anchor.parentNode.insertBefore(btn, anchor);
    else controls.appendChild(btn);
    return btn;
  },

  /** Chromecast / remote playback (Chrome, Edge) — keeps auth cookies via browser relay. */
  enableRemotePlayback(plyr) {
    const media = plyr?.media;
    if (!this.supportsRemotePlayback(media)) return null;

    const attach = () => {
      const btn = this.insertControlButton(plyr, 'cast', 'Cast', this.CAST_ICON, 'fullscreen');
      if (!btn || btn.dataset.vaultCastBound) return btn;
      btn.dataset.vaultCastBound = '1';

      const state = { available: false, watchId: null, connected: false };

      const sync = () => {
        btn.hidden = !state.available;
        btn.classList.toggle('plyr__control--pressed', state.connected);
        btn.disabled = !state.available;
      };

      const onConnect = () => {
        state.connected = true;
        sync();
      };
      const onDisconnect = () => {
        state.connected = false;
        sync();
      };

      media.remote.addEventListener('connect', onConnect);
      media.remote.addEventListener('disconnect', onDisconnect);

      media.remote.watchAvailability((available) => {
        state.available = available;
        sync();
      }).then((watchId) => {
        state.watchId = watchId;
      }).catch(() => {});

      btn.addEventListener('click', () => {
        media.remote.prompt().catch(() => {});
      });

      plyr.on('destroy', () => {
        media.remote.removeEventListener('connect', onConnect);
        media.remote.removeEventListener('disconnect', onDisconnect);
        if (state.watchId != null) {
          media.remote.cancelWatchAvailability(state.watchId).catch(() => {});
        }
      });

      sync();
      return btn;
    };

    if (plyr.elements?.controls) return attach();
    plyr.on('ready', () => attach());
    return null;
  },

  /** Keep native controls enabled for Edge quick actions while Plyr supplies the visible UI. */
  enableBrowserVideoActions(plyr) {
    const video = plyr?.media;
    if (!video || video.tagName !== 'VIDEO') return;

    this.configureVideoElement(video);

    const keepNativeControls = () => {
      if (!video.isConnected) return;
      if (!video.hasAttribute('controls')) video.setAttribute('controls', '');
    };

    keepNativeControls();
    plyr.on('ready', keepNativeControls);
    plyr.on('loadedmetadata', keepNativeControls);

    if (typeof MutationObserver !== 'undefined') {
      const obs = new MutationObserver(keepNativeControls);
      obs.observe(video, { attributes: true, attributeFilter: ['controls'] });
      plyr.on('destroy', () => obs.disconnect());
    }
  },

  plyrOptions(isAudio) {
    const options = {
      controls: isAudio ? this.CONTROLS_AUDIO : this.CONTROLS_VIDEO,
      speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] },
      settings: ['speed'],
    };
    if (!isAudio) {
      options.playsinline = true;
      options.disableContextMenu = false;
      options.fullscreen = { enabled: true, iosNative: true, fallback: true };
    }
    return options;
  },

  createPlyr(el, isAudio, hooks = {}) {
    if (typeof Plyr === 'undefined') return null;
    if (isAudio) this.configureAudioElement(el);
    else this.configureVideoElement(el);
    const plyr = new Plyr(el, this.plyrOptions(isAudio));
    if (isAudio) this.configureAudioElement(plyr.media || el);
    else {
      this.enableBrowserVideoActions(plyr);
      const wrapper = plyr.elements?.container?.querySelector?.('.plyr__video-wrapper');
      if (wrapper) wrapper.classList.add('vault-video-enhanced-wrap');
    }
    this.enableRemotePlayback(plyr);
    if (hooks.onProgress) plyr.on('progress', hooks.onProgress);
    if (hooks.onTimeupdate) plyr.on('timeupdate', hooks.onTimeupdate);
    if (hooks.onPlay) plyr.on('play', hooks.onPlay);
    if (hooks.onPause) plyr.on('pause', hooks.onPause);
    if (hooks.onEnded) plyr.on('ended', hooks.onEnded);
    if (!isAudio && hooks.onEnterFullscreen) plyr.on('enterfullscreen', hooks.onEnterFullscreen);
    if (!isAudio && hooks.onExitFullscreen) plyr.on('exitfullscreen', hooks.onExitFullscreen);
    return plyr;
  },

  setupAudioArt({ thumbEl, fallbackEl, thumbUrl, hasThumbnail }) {
    if (!thumbEl || !fallbackEl) return;
    thumbEl.removeAttribute('src');
    thumbEl.classList.add('hidden');
    fallbackEl.classList.add('hidden');

    if (hasThumbnail && thumbUrl) {
      thumbEl.onload = () => {
        thumbEl.classList.remove('hidden');
        fallbackEl.classList.add('hidden');
      };
      thumbEl.onerror = () => {
        thumbEl.classList.add('hidden');
        fallbackEl.classList.remove('hidden');
      };
      thumbEl.src = thumbUrl;
    } else {
      fallbackEl.classList.remove('hidden');
    }
  },

  createAudioVizState() {
    return { ctx: null, analyser: null, source: null, data: null, raf: null, tick: 0 };
  },

  initAudioViz(viz, audioEl, canvas) {
    if (!canvas || typeof AudioContext === 'undefined') return viz;

    if (!viz.source) {
      try {
        const ctx = new AudioContext();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.82;
        const source = ctx.createMediaElementSource(audioEl);
        source.connect(analyser);
        analyser.connect(ctx.destination);
        viz.ctx = ctx;
        viz.analyser = analyser;
        viz.source = source;
        viz.data = new Uint8Array(analyser.frequencyBinCount);
      } catch {
        return viz;
      }
    }

    this.drawAudioViz(viz, audioEl, canvas);
    return viz;
  },

  resumeAudioViz(viz, audioEl, canvas) {
    if (viz.ctx?.state === 'suspended') {
      viz.ctx.resume().catch(() => {});
    }
    this.drawAudioViz(viz, audioEl, canvas);
  },

  drawAudioViz(viz, audioEl, canvas) {
    if (!viz || !canvas) return;

    if (viz.raf) {
      cancelAnimationFrame(viz.raf);
      viz.raf = null;
    }

    const c = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    const bars = 48;
    const gap = 3 * dpr;
    const barW = (w - gap * (bars - 1)) / bars;
    const playing = audioEl && !audioEl.paused && !audioEl.ended;

    if (playing && viz.analyser) {
      viz.analyser.getByteFrequencyData(viz.data);
    }

    viz.tick += 1;
    c.clearRect(0, 0, w, h);

    for (let i = 0; i < bars; i++) {
      let norm;
      if (playing && viz.data) {
        const idx = Math.floor((i / bars) * viz.data.length * 0.7);
        norm = (viz.data[idx] || 0) / 255;
      } else {
        norm = 0.08 + Math.sin(viz.tick * 0.04 + i * 0.35) * 0.04;
      }

      const barH = Math.max(4 * dpr, norm * h * 0.92);
      const x = i * (barW + gap);
      const y = (h - barH) / 2;
      const grad = c.createLinearGradient(x, y + barH, x, y);
      grad.addColorStop(0, 'rgba(91, 140, 247, 0.4)');
      grad.addColorStop(0.5, 'rgba(74, 158, 255, 0.95)');
      grad.addColorStop(1, 'rgba(168, 85, 247, 0.95)');
      c.fillStyle = grad;
      c.fillRect(x, y, barW, barH);
    }

    viz.raf = requestAnimationFrame(() => this.drawAudioViz(viz, audioEl, canvas));
  },

  stopAudioViz(viz) {
    if (!viz) return;
    if (viz.raf) {
      cancelAnimationFrame(viz.raf);
      viz.raf = null;
    }
    if (viz.ctx?.state === 'running') {
      viz.ctx.suspend().catch(() => {});
    }
  },

  attachStreamPlayback(el, hooks = {}) {
    if (el?.tagName === 'VIDEO') this.configureVideoElement(el);
    else if (el?.tagName === 'AUDIO') this.configureAudioElement(el);
    el.preload = 'auto';
    let ready = false;
    const handlers = [];
    const on = (type, fn) => {
      el.addEventListener(type, fn);
      handlers.push({ type, fn });
    };

    const markReady = () => {
      if (ready) return;
      ready = true;
      hooks.onReady?.();
      if (hooks.autoplay !== false) {
        el.play().catch(() => {});
      }
    };

    on('loadedmetadata', markReady);
    on('canplay', markReady);
    on('progress', () => {
      if (el.buffered.length > 0) markReady();
    });
    if (hooks.onPlaying) on('playing', hooks.onPlaying);
    if (hooks.onError) on('error', hooks.onError);

    return () => {
      for (const { type, fn } of handlers) el.removeEventListener(type, fn);
    };
  },

  buildAudioPlayerHtml() {
    return `
      <div class="viewer-player-wrap viewer-audio-player share-audio-player">
        <div class="audio-visual-stage">
          <div class="audio-art-wrap">
            <img class="viewer-audio-thumb share-audio-thumb hidden" alt="">
            <div class="viewer-audio-thumb-fallback share-audio-thumb-fallback hidden">
              <span class="audio-fallback-icon">🎵</span>
            </div>
          </div>
          <canvas class="viewer-audio-viz share-audio-viz" aria-hidden="true"></canvas>
        </div>
        <audio class="share-audio-el vault-audio-remote" playsinline preload="auto" x-webkit-airplay="allow"></audio>
      </div>
    `;
  },

  buildVideoPlayerHtml() {
    return `
      <div class="viewer-player-wrap share-video-player vault-video-enhanced-wrap">
        <video class="share-video-el vault-video-enhanced" controls playsinline webkit-playsinline preload="auto" x-webkit-airplay="allow" controlslist="nodownload"></video>
      </div>
    `;
  },
};

function vaultLoaderHtml(label = 'Loading...', statusId = '') {
  const idAttr = statusId ? ` id="${statusId}"` : '';
  return `<div class="vault-loader" role="status" aria-live="polite">
    <div class="vault-loader-mark" aria-hidden="true">
      <div class="vault-loader-ring"></div>
      <svg class="vault-loader-logo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
        <path d="M12 2L2 7l10 5 10-5-10-5z"/>
        <path d="M2 17l10 5 10-5"/>
        <path d="M2 12l10 5 10-5"/>
      </svg>
    </div>
    <span class="vault-loader-label"${idAttr}>${label}</span>
  </div>`;
}
