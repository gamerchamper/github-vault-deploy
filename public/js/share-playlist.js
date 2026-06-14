/**
 * Playlist panel on the public share page (stacked above shoutbox).
 */
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
      if (current?.id === file.id) {
        row.classList.add('is-active');
        activeRow = row;
      }

      const thumb = document.createElement('div');
      thumb.className = 'playlist-queue-thumb';
      if (file.has_thumbnail) {
        const img = document.createElement('img');
        img.src = this.thumbnailUrl(file.id);
        img.alt = '';
        img.loading = 'lazy';
        thumb.appendChild(img);
      } else {
        thumb.textContent = this.typeIcon(file);
      }

      const body = document.createElement('div');
      body.className = 'playlist-queue-body';
      const name = document.createElement('span');
      name.className = 'playlist-queue-name';
      name.textContent = PlaylistQueue.itemLabel(file);
      const meta = document.createElement('span');
      meta.className = 'playlist-queue-meta';
      meta.textContent = PlaylistQueue.itemMetaParts(file, idx).join(' · ');
      body.append(name, meta);

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
      requestAnimationFrame(() => {
        activeRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
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

  destroy() {
    this.token = null;
    this.playlist = null;
    this.searchQuery = '';
    if (this.searchEl) this.searchEl.value = '';
    this.panelEl?.classList.add('hidden');
    document.body.classList.remove('share-playlist-active');
    document.getElementById('share-right-rail')?.classList.remove('share-right-rail-open');
    PlaylistQueue.reset();
  },
};
