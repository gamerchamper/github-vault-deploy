/**
 * Playlist sidebar in media viewer
 */
(function patchPlaylistQueueUi() {
  if (typeof PlaylistQueue === 'undefined') return;
  PlaylistQueue.ensureUiHelpers?.();
  if (typeof PlaylistQueue.decorateQueueRow === 'function') return;
  const TH = 90;
  PlaylistQueue.SEEN_THRESHOLD = PlaylistQueue.SEEN_THRESHOLD || TH;
  PlaylistQueue.isSeen = function isSeen(prog) {
    if (!prog) return false;
    return !!(prog.completed || prog.progress_pct >= TH);
  };
  PlaylistQueue.decorateQueueRow = function decorateQueueRow(row, file, idx, { currentId = null } = {}) {
    const prog = this.getProgress(file.id);
    row.dataset.fileId = file.id;
    row.classList.toggle('is-active', currentId === file.id);
    row.classList.toggle('is-seen', this.isSeen(prog));
    row.classList.toggle('is-completed', this.isSeen(prog));
    row.classList.toggle('is-in-progress', !this.isSeen(prog) && prog.progress_pct >= 3);
    return prog;
  };
  PlaylistQueue.progressRingSvg = function progressRingSvg(prog) {
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
  PlaylistQueue.appendQueueProgress = function appendQueueProgress(body, prog) {
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
})();

const PlaylistPlayer = {
  el: null,
  listEl: null,
  searchEl: null,
  collapsed: false,
  filteredItems: null,

  init() {
    this.el = document.getElementById('viewer-playlist-panel');
    this.listEl = document.getElementById('viewer-playlist-list');
    this.searchEl = document.getElementById('viewer-playlist-search');
    if (!this.el) return;

    document.getElementById('viewer-playlist-toggle')?.addEventListener('click', () => this.toggleCollapse());
    document.getElementById('viewer-playlist-shuffle')?.addEventListener('click', () => {
      PlaylistQueue.toggleShuffle();
      this.render();
      App.toast(PlaylistQueue.shuffle ? 'Shuffle on' : 'Shuffle off', 'info');
    });
    document.getElementById('viewer-playlist-repeat')?.addEventListener('click', () => {
      const mode = PlaylistQueue.cycleRepeat();
      this.updateRepeatBtn(mode);
      App.toast(`Repeat: ${mode}`, 'info');
    });
    document.getElementById('viewer-playlist-prev')?.addEventListener('click', () => this.playAdjacent('prev'));
    document.getElementById('viewer-playlist-next')?.addEventListener('click', () => this.playAdjacent('next'));
    this.searchEl?.addEventListener('input', () => this.render());

    const stored = localStorage.getItem('viewerPlaylistCollapsed');
    if (stored === '1') this.setCollapsed(true);
  },

  show(playlist) {
    if (!this.el || !playlist) return;
    PlaylistQueue.setFromPlaylist(playlist, Viewer.currentFile?.id);
    document.getElementById('viewer-playlist-title').textContent = playlist.title || 'Playlist';
    document.getElementById('viewer-playlist-meta').textContent =
      `${playlist.items?.length || 0} items`;
    const coverId = playlist.cover_thumbnail_id || playlist.items?.[0]?.id;
    const cover = document.getElementById('viewer-playlist-cover');
    if (cover && coverId && (typeof ThumbCache === 'undefined' || !ThumbCache.isFailed(coverId))) {
      const src = typeof ThumbCache !== 'undefined'
        ? ThumbCache.resolveUrl(coverId)
        : API.files.thumbnail(coverId, null);
      if (src) {
        cover.onerror = () => {
          ThumbCache?.markFailed?.(coverId);
          cover.classList.add('hidden');
        };
        cover.src = src;
        cover.classList.remove('hidden');
        ThumbCache?.prefetch?.(coverId)?.then((url) => {
          if (url && cover.isConnected) cover.src = url;
        }).catch(() => {});
      } else {
        cover.classList.add('hidden');
      }
    } else if (cover) {
      cover.classList.add('hidden');
    }
    this.el.classList.remove('hidden');
    document.getElementById('media-viewer')?.classList.add('viewer-has-playlist');
    this.render();
    this.updateRepeatBtn(PlaylistQueue.repeat);
    this.hydrateProgressFromServer();
  },

  async hydrateProgressFromServer() {
    if (!PlaylistQueue.playlistId || PlaylistQueue.isPublic) return;
    try {
      const { progress } = await API.playlists.getProgress(PlaylistQueue.playlistId);
      if (Array.isArray(progress) && progress.length) {
        PlaylistQueue.applyProgress(progress);
        this.render();
      }
    } catch { /* ignore */ }
  },

  hide() {
    this.el?.classList.add('hidden');
    document.getElementById('media-viewer')?.classList.remove('viewer-has-playlist');
    PlaylistQueue.reset();
  },

  toggleCollapse() {
    this.setCollapsed(!this.collapsed);
  },

  setCollapsed(collapsed) {
    this.collapsed = collapsed;
    this.el?.classList.toggle('playlist-panel-collapsed', collapsed);
    localStorage.setItem('viewerPlaylistCollapsed', collapsed ? '1' : '0');
  },

  updateRepeatBtn(mode) {
    const btn = document.getElementById('viewer-playlist-repeat');
    if (!btn) return;
    btn.dataset.mode = mode;
    btn.title = `Repeat: ${mode}`;
    btn.setAttribute('aria-pressed', mode !== 'off' ? 'true' : 'false');
  },

  getFilteredItems() {
    const q = (this.searchEl?.value || '').trim().toLowerCase();
    if (!q) return PlaylistQueue.items;
    return PlaylistQueue.items.filter((f) => PlaylistQueue.itemSearchText(f).includes(q));
  },

  render() {
    if (!this.listEl) return;
    const current = PlaylistQueue.current();
    const items = this.getFilteredItems();
    this.listEl.innerHTML = '';

    const fragment = document.createDocumentFragment();
    for (const file of items) {
      const idx = PlaylistQueue.items.findIndex((f) => f.id === file.id);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'playlist-queue-item';
      const prog = PlaylistQueue.decorateQueueRow(row, file, idx, { currentId: current?.id });

      const thumb = document.createElement('div');
      thumb.className = 'playlist-queue-thumb';
      thumb.insertAdjacentHTML('beforeend', PlaylistQueue.progressRingSvg(prog));
      if (file.has_thumbnail) {
        const img = document.createElement('img');
        img.src = API.files.thumbnail(file.id, file.thumbVersion);
        img.alt = '';
        img.loading = 'lazy';
        thumb.appendChild(img);
      } else {
        const icon = document.createElement('span');
        icon.className = 'playlist-queue-thumb-icon';
        icon.textContent = this.typeIcon(file);
        thumb.appendChild(icon);
      }

      const body = document.createElement('div');
      body.className = 'playlist-queue-body';
      const name = document.createElement('span');
      name.className = 'playlist-queue-name';
      name.textContent = file.display_name?.trim()
        || (typeof DisplayNames !== 'undefined' ? DisplayNames.get(file.id, file.name) : file.name);
      const meta = document.createElement('span');
      meta.className = 'playlist-queue-meta';
      const metaParts = PlaylistQueue.itemMetaParts(file, idx);
      if (PlaylistQueue.isSeen(prog)) metaParts.push('Watched');
      else if (prog.progress_pct >= 3) metaParts.push(`${Math.round(prog.progress_pct)}%`);
      meta.textContent = metaParts.join(' · ');
      body.append(name, meta);
      PlaylistQueue.appendQueueProgress(body, prog);

      row.append(thumb, body);
      row.addEventListener('click', () => this.playItem(file.id));
      fragment.appendChild(row);
    }
    this.listEl.appendChild(fragment);
  },

  onProgressUpdate(fileId) {
    if (!this.listEl) return;
    const row = this.listEl.querySelector(`[data-file-id="${fileId}"]`);
    if (!row) {
      this.render();
      return;
    }
    const file = PlaylistQueue.items.find((f) => f.id === fileId);
    if (!file) return;
    const idx = PlaylistQueue.items.findIndex((f) => f.id === fileId);
    const prog = PlaylistQueue.decorateQueueRow(row, file, idx, { currentId: PlaylistQueue.current()?.id });
    const meta = row.querySelector('.playlist-queue-meta');
    if (meta) {
      const metaParts = PlaylistQueue.itemMetaParts(file, idx);
      if (PlaylistQueue.isSeen(prog)) metaParts.push('Watched');
      else if (prog.progress_pct >= 3) metaParts.push(`${Math.round(prog.progress_pct)}%`);
      meta.textContent = metaParts.join(' · ');
    }
    const ring = row.querySelector('.playlist-queue-ring');
    if (ring) ring.outerHTML = PlaylistQueue.progressRingSvg(prog);
    const oldBar = row.querySelector('.playlist-queue-progress');
    const oldBadge = row.querySelector('.playlist-queue-seen-badge');
    oldBar?.remove();
    oldBadge?.remove();
    const body = row.querySelector('.playlist-queue-body');
    if (body) PlaylistQueue.appendQueueProgress(body, prog);
  },

  typeIcon(file) {
    const type = getPreviewType(file.name, file.mime_type);
    const icons = { video: '▶', audio: '♫', image: '🖼', pdf: '📄', text: '📝' };
    return icons[type] || '📄';
  },

  playItem(fileId) {
    const file = PlaylistQueue.goTo(fileId);
    if (!file) return;
    Viewer.openFromPlaylist(file);
    this.render();
  },

  playAdjacent(dir) {
    const file = dir === 'prev' ? PlaylistQueue.previous() : PlaylistQueue.next();
    if (!file) return;
    Viewer.openFromPlaylist(file);
    this.render();
  },

  onMediaEnded() {
    if (!PlaylistQueue.autoplay) return;
    if (PlaylistQueue.repeat === 'one') {
      Viewer.openFromPlaylist(PlaylistQueue.current());
      return;
    }
    const next = PlaylistQueue.next();
    if (next) Viewer.openFromPlaylist(next);
  },
};
