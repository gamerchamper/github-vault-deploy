/**
 * Playlist panel on the public share page (stacked above shoutbox).
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

const SharePlaylist = {
  token: null,
  playlist: null,
  onPlayItem: null,
  listEl: null,
  panelEl: null,
  searchEl: null,
  searchQuery: '',

  init(token, onPlayItem) {
    this.token = token;
    this.onPlayItem = onPlayItem;
    this.panelEl = document.getElementById('share-playlist-panel');
    this.listEl = document.getElementById('share-playlist-list');
    this.searchEl = document.getElementById('share-playlist-search');
    if (!this.panelEl) return;

    document.getElementById('share-playlist-prev')?.addEventListener('click', () => this.playAdjacent('prev'));
    document.getElementById('share-playlist-next')?.addEventListener('click', () => this.playAdjacent('next'));
    document.getElementById('share-playlist-shuffle')?.addEventListener('click', () => {
      PlaylistQueue.toggleShuffle();
      this.render();
    });
    document.getElementById('share-playlist-repeat')?.addEventListener('click', () => {
      const mode = PlaylistQueue.cycleRepeat();
      this.updateRepeatBtn(mode);
    });
    this.searchEl?.addEventListener('input', () => {
      this.searchQuery = (this.searchEl?.value || '').trim().toLowerCase();
      this.render();
    });
  },

  apiBase() {
    return `/api/public/playlist/${this.token}`;
  },

  thumbnailUrl(fileId) {
    return `${this.apiBase()}/thumbnail?file=${encodeURIComponent(fileId)}`;
  },

  async load() {
    const res = await fetch(this.apiBase());
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Playlist not found' }));
      throw new Error(err.error || 'Playlist not found');
    }
    this.playlist = await res.json();
    PlaylistQueue.setFromPlaylist(this.playlist, null, {
      isPublic: true,
      publicToken: this.token,
    });
    this.showPanel();
    this.render();
    this.updateRepeatBtn(PlaylistQueue.repeat);
    this.updateShuffleBtn();

    const first = this.pickFirstMedia();
    if (first && this.onPlayItem) {
      await this.onPlayItem(first.id);
    } else if (!first) {
      throw new Error('This playlist has no playable media');
    }
  },

  pickFirstMedia() {
    const items = PlaylistQueue.items;
    if (!items.length) return null;
    const isVideo = (f) => {
      const ext = (f.name || '').split('.').pop().toLowerCase();
      const mime = f.mime_type || '';
      return mime.startsWith('video/') || ['mp4', 'webm', 'mkv', 'mov', 'm4v', 'avi'].includes(ext);
    };
    const isMedia = (f) => {
      const ext = (f.name || '').split('.').pop().toLowerCase();
      const mime = f.mime_type || '';
      if (mime.startsWith('video/') || mime.startsWith('audio/')) return true;
      return ['mp4', 'webm', 'mkv', 'mov', 'm4v', 'avi', 'mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'].includes(ext);
    };
    return items.find(isVideo) || items.find(isMedia) || items[0];
  },

  showPanel() {
    if (!this.panelEl || !this.playlist) return;
    document.body.classList.add('share-playlist-active');
    document.getElementById('share-right-rail')?.classList.add('share-right-rail-open');
    this.panelEl.classList.remove('hidden');

    const pl = this.playlist;
    const title = document.getElementById('share-playlist-title');
    const meta = document.getElementById('share-playlist-meta');
    const desc = document.getElementById('share-playlist-desc');
    const owner = document.getElementById('share-playlist-owner');
    const coverWrap = document.getElementById('share-playlist-cover-wrap');
    const cover = document.getElementById('share-playlist-cover');

    if (title) title.textContent = pl.title || 'Playlist';
    if (meta) {
      const parts = [`${pl.items?.length || 0} items`];
      const totalDur = PlaylistQueue.totalHlsDuration(pl.items);
      if (totalDur > 0) parts.push(PlaylistQueue.formatHlsDuration(totalDur));
      if (pl.total_bytes) parts.push(formatSize(pl.total_bytes));
      meta.textContent = parts.join(' · ');
    }

    if (desc) {
      const text = (pl.description || '').trim();
      if (text) {
        desc.textContent = text;
        desc.classList.remove('hidden');
      } else {
        desc.textContent = '';
        desc.classList.add('hidden');
      }
    }

    if (owner) {
      if (pl.owner_name) {
        owner.textContent = `Shared by ${pl.owner_name}`;
        owner.classList.remove('hidden');
      } else {
        owner.textContent = '';
        owner.classList.add('hidden');
      }
    }

    const coverId = pl.cover_thumbnail_id || pl.items?.find((f) => f.has_thumbnail)?.id;
    if (coverWrap && cover) {
      if (coverId) {
        cover.src = this.thumbnailUrl(coverId);
        coverWrap.classList.remove('hidden');
      } else {
        cover.removeAttribute('src');
        coverWrap.classList.add('hidden');
      }
    }

    ShareStageLayout?.syncLayoutMode?.();
    ShareViewer?.refitCinemaStage?.();
  },

  getFilteredItems() {
    if (!this.searchQuery) return PlaylistQueue.items;
    return PlaylistQueue.items.filter((f) => PlaylistQueue.itemSearchText(f).includes(this.searchQuery));
  },

  updateRepeatBtn(mode) {
    const btn = document.getElementById('share-playlist-repeat');
    if (!btn) return;
    btn.dataset.mode = mode;
    btn.title = `Repeat: ${mode}`;
    btn.setAttribute('aria-pressed', mode !== 'off' ? 'true' : 'false');
    btn.classList.toggle('is-active', mode !== 'off');
  },

  updateShuffleBtn() {
    const btn = document.getElementById('share-playlist-shuffle');
    if (!btn) return;
    btn.classList.toggle('is-active', PlaylistQueue.shuffle);
    btn.setAttribute('aria-pressed', PlaylistQueue.shuffle ? 'true' : 'false');
  },

  scrollActiveRowIntoView(activeRow) {
    if (!activeRow || !this.listEl) return;
    requestAnimationFrame(() => {
      const list = this.listEl;
      const margin = 8;
      const rowTop = activeRow.offsetTop - margin;
      const rowBottom = activeRow.offsetTop + activeRow.offsetHeight + margin;
      const viewTop = list.scrollTop;
      const viewBottom = viewTop + list.clientHeight;
      if (rowTop < viewTop) list.scrollTop = rowTop;
      else if (rowBottom > viewBottom) list.scrollTop = rowBottom - list.clientHeight;
    });
  },

  render() {
    if (!this.listEl) return;
    const current = PlaylistQueue.current();
    const items = this.getFilteredItems();
    this.listEl.innerHTML = '';
    this.updateShuffleBtn();

    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'share-playlist-empty';
      empty.textContent = this.searchQuery ? 'No matching items' : 'Playlist is empty';
      this.listEl.appendChild(empty);
      return;
    }

    const fragment = document.createDocumentFragment();
    let activeRow = null;

    for (const file of items) {
      const idx = PlaylistQueue.items.findIndex((f) => f.id === file.id);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'playlist-queue-item';
      row.dataset.fileId = file.id;
      const prog = PlaylistQueue.decorateQueueRow(row, file, idx, { currentId: current?.id });
      if (current?.id === file.id) activeRow = row;

      const thumb = document.createElement('div');
      thumb.className = 'playlist-queue-thumb';
      thumb.insertAdjacentHTML('beforeend', PlaylistQueue.progressRingSvg(prog));
      if (file.has_thumbnail) {
        const img = document.createElement('img');
        img.src = this.thumbnailUrl(file.id);
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
      name.textContent = PlaylistQueue.itemLabel(file);
      const meta = document.createElement('span');
      meta.className = 'playlist-queue-meta';
      const metaParts = PlaylistQueue.itemMetaParts(file, idx);
      if (PlaylistQueue.isSeen(prog)) metaParts.push('Watched');
      else if (prog.progress_pct >= 3) metaParts.push(`${Math.round(prog.progress_pct)}%`);
      meta.textContent = metaParts.join(' · ');
      body.append(name, meta);
      PlaylistQueue.appendQueueProgress(body, prog);

      if (file.display_name?.trim() && file.display_name.trim() !== file.name) {
        const orig = document.createElement('span');
        orig.className = 'playlist-queue-original';
        orig.textContent = file.name;
        orig.title = 'Original filename';
        body.appendChild(orig);
      }

      row.append(thumb, body);
      row.addEventListener('click', () => this.playItem(file.id));
      fragment.appendChild(row);
    }
    this.listEl.appendChild(fragment);

    if (activeRow) {
      this.scrollActiveRowIntoView(activeRow);
    }
  },

  typeIcon(file) {
    const type = getPreviewType(file.name, file.mime_type);
    const icons = { video: '▶', audio: '♫', image: '🖼', pdf: '📄', text: '📝' };
    return icons[type] || '📄';
  },

  playItem(fileId) {
    const file = PlaylistQueue.goTo(fileId);
    if (!file || !this.onPlayItem) return;
    this.onPlayItem(file.id);
    this.render();
  },

  playAdjacent(direction) {
    const file = direction === 'prev' ? PlaylistQueue.previous() : PlaylistQueue.next();
    if (!file) return;
    this.playItem(file.id);
  },

  onMediaEnded() {
    if (!PlaylistQueue.autoplay) return;
    if (PlaylistQueue.repeat === 'one') {
      const cur = PlaylistQueue.current();
      if (cur) this.playItem(cur.id);
      return;
    }
    const next = PlaylistQueue.next();
    if (next) this.playItem(next.id);
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
    row.querySelector('.playlist-queue-progress')?.remove();
    row.querySelector('.playlist-queue-seen-badge')?.remove();
    const body = row.querySelector('.playlist-queue-body');
    if (body) PlaylistQueue.appendQueueProgress(body, prog);
  },

  destroy() {
    this.token = null;
    this.playlist = null;
    this.searchQuery = '';
    if (this.searchEl) this.searchEl.value = '';
    this.panelEl?.classList.add('hidden');
    document.body.classList.remove('share-playlist-active');
    document.getElementById('share-right-rail')?.classList.remove('share-right-rail-open');
    ShareStageLayout?.syncLayoutMode?.();
    PlaylistQueue.reset();
  },
};
