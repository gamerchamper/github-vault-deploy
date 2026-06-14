/**
 * Playlist sidebar in media viewer
 */
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
    if (cover && coverId) {
      cover.src = API.files.thumbnail(coverId, null);
      cover.classList.remove('hidden');
    } else if (cover) {
      cover.classList.add('hidden');
    }
    this.el.classList.remove('hidden');
    document.getElementById('media-viewer')?.classList.add('viewer-has-playlist');
    this.render();
    this.updateRepeatBtn(PlaylistQueue.repeat);
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
