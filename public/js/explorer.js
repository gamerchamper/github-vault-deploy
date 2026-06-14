class Explorer {
  constructor() {
    this.currentPath = '/';
    this.files = [];
    this.selected = new Set();
    this.history = ['/'];
    this.historyIndex = 0;
    this.contextTarget = null;
    this.moveIds = [];
    this.moveDestination = '/';
    this.dragIds = null;
    this.contextMode = 'item';
    this.renamingId = null;
    this.accountView = 'primary';
    this.viewMode = 'files';
    this.filterType = null;
    this.searchQuery = '';
    this.sort = localStorage.getItem('vault-sort') || 'name';
    this.sortOrder = localStorage.getItem('vault-sort-order') || 'asc';
    this.pageSize = 200;
    this.listTotal = 0;
    this.listHasMore = false;
    this.listOffset = 0;
    this.loadingMore = false;
    this._elementCache = new Map();
    this._boundInfiniteScroll = false;
    this.trashCollapsed = new Set();
    this.displayFiles = [];
    this._navGen = 0;
    this._loadingDepth = 0;
  }

  isCuratedBrowseView() {
    return ['playlists', 'collections', 'discover', 'playlist-detail', 'collection-detail'].includes(this.viewMode);
  }

  clearCuratedChrome() {
    document.getElementById('file-view')?.querySelectorAll('.curated-hero, .discover-panel').forEach((el) => el.remove());
  }

  buildTrashTreeFiles() {
    const byParent = new Map();
    for (const f of this.files) {
      const parent = f.parent_path || '/';
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(f);
    }
    const parents = [...byParent.keys()].sort();
    const out = [];
    for (const parent of parents) {
      const collapsed = this.trashCollapsed.has(parent);
      const label = parent === '/' ? 'Home' : parent.split('/').filter(Boolean).pop() || parent;
      out.push({
        id: `trash-group:${parent}`,
        name: label,
        path: parent,
        is_folder: true,
        _trashGroupHeader: true,
        _trashGroupPath: parent,
        _trashGroupCount: byParent.get(parent).length,
        parent_path: '/',
      });
      if (!collapsed) {
        for (const f of byParent.get(parent).sort((a, b) => a.name.localeCompare(b.name))) {
          out.push(f);
        }
      }
    }
    return out;
  }

  getRenderableFiles() {
    if (this.viewMode === 'trash' && this.files.length) {
      return this.buildTrashTreeFiles();
    }
    return this.files;
  }

  toggleTrashGroup(parentPath) {
    if (this.trashCollapsed.has(parentPath)) this.trashCollapsed.delete(parentPath);
    else this.trashCollapsed.add(parentPath);
    this.render();
  }

  bindInfiniteScroll() {
    if (this._boundInfiniteScroll) return;
    const viewport = document.getElementById('file-view');
    if (!viewport) return;
    this._boundInfiniteScroll = true;
    viewport.addEventListener('scroll', () => {
      if (!this.listHasMore || this.loadingMore || this.viewMode !== 'files') return;
      const nearBottom = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 400;
      if (nearBottom) this.loadMore();
    }, { passive: true });
  }

  displayName(file) {
    if (file._inPlaylist && file.display_name?.trim()) return file.display_name.trim();
    return DisplayNames.get(file.id, file.name);
  }

  isTrashView() {
    return this.viewMode === 'trash';
  }

  isSpecialView() {
    return this.viewMode !== 'files';
  }

  isCuratedCardView() {
    return ['playlists', 'collections', 'discover', 'collection-detail'].includes(this.viewMode);
  }

  /** Map detail views to the sidebar / filter chip tab that owns them */
  resolveActiveView(viewMode = this.viewMode) {
    const parent = {
      'playlist-detail': 'playlists',
      'collection-detail': 'collections',
    };
    return parent[viewMode] || viewMode;
  }

  positionContextMenu(menu, clientX, clientY) {
    menu.classList.remove('hidden');
    menu.style.left = `${clientX}px`;
    menu.style.top = `${clientY}px`;

    const rect = menu.getBoundingClientRect();
    const pad = 8;
    let left = clientX;
    let top = clientY;
    if (rect.right > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - rect.width - pad);
    if (rect.bottom > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - rect.height - pad);
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }

  setLoading(show) {
    this._loadingDepth = Math.max(0, this._loadingDepth + (show ? 1 : -1));
    const active = this._loadingDepth > 0;
    document.getElementById('view-loading').classList.toggle('hidden', !active);
    const grid = document.getElementById('file-grid');
    if (grid) grid.style.opacity = active ? '0.5' : '1';
  }

  setEmptyState(mode) {
    const empty = document.getElementById('empty-state');
    if (!empty) return;
    const states = {
      default: { title: 'This folder is empty', hint: 'Upload files or create a new folder to get started' },
      search: { title: 'No matching files', hint: 'Try a different search term or clear filters' },
      filter: { title: 'No files match this filter', hint: 'Clear the filter chip to see all items' },
      favorites: { title: 'No favorites yet', hint: 'Right-click a file and choose Add to favorites' },
      recent: { title: 'No recent files', hint: 'Files you open or preview will appear here' },
      trash: { title: 'Trash is empty', hint: 'Deleted files are kept here until permanently removed' },
      shared: { title: 'No shared files', hint: 'Share a file to see it in this view' },
      playlists: { title: 'No playlists yet', hint: 'Create a playlist to curate your media' },
      collections: { title: 'No collections yet', hint: 'Group playlists into collections' },
      discover: { title: 'Nothing to discover yet', hint: 'Play playlists to see continue watching here' },
      'playlist-detail': { title: 'Playlist is empty', hint: 'Edit the playlist to add files' },
      'collection-detail': { title: 'Collection is empty', hint: 'Add playlists to this collection' },
    };
    const s = states[mode] || states.default;
    const titleEl = empty.querySelector('p:not(.empty-hint)');
    const hintEl = empty.querySelector('.empty-hint');
    if (titleEl) titleEl.textContent = s.title;
    if (hintEl) hintEl.textContent = s.hint;
  }

  async navigate(path, opts = {}) {
    const {
      silent = false,
      search = this.searchQuery,
      type = this.filterType,
      viewMode = this.viewMode,
      sort = this.sort,
      order = this.sortOrder,
    } = opts;

    const nextViewMode = viewMode || 'files';
    const nextPlaylistId = 'playlistId' in opts
      ? (opts.playlistId || null)
      : (nextViewMode === 'playlist-detail' ? this.playlistId : null);
    const nextCollectionId = 'collectionId' in opts
      ? (opts.collectionId || null)
      : (nextViewMode === 'collection-detail' ? this.collectionId : null);

    const gen = ++this._navGen;

    if (typeof App !== 'undefined' && App.showFilesPanel) {
      App.showFilesPanel(this.resolveActiveView(nextViewMode));
    }

    this.currentPath = path;
    this.searchQuery = search || '';
    this.filterType = type || null;
    this.viewMode = nextViewMode;
    this.playlistId = nextPlaylistId;
    this.collectionId = nextCollectionId;
    this.sort = sort || 'name';
    this.sortOrder = order || 'asc';
    this.selected.clear();
    this.updateToolbar();
    this.syncFilterChips();
    VirtualGrid?.reset?.();
    if (this.isCuratedCardView() || nextViewMode === 'playlist-detail') {
      VirtualGrid?.setEnabled?.(false);
      this.displayFiles = [];
    }
    if (nextViewMode !== 'discover') this._discover = null;

    const fileView = document.getElementById('file-view');
    if (fileView) fileView.scrollTop = 0;

    if (!silent) this.setLoading(true);
    try {
      await this.loadFiles();
      if (gen !== this._navGen) return;
      this.render();
      this.updateBreadcrumb();
      this.updateStatus();
      this.syncFilterChips();
      this.updateFolderTreeSelection();
      App?.updateCuratedRibbon?.();
    } catch (err) {
      if (gen === this._navGen) App.toast(err.message, 'error');
    } finally {
      if (!silent && gen === this._navGen) this.setLoading(false);
    }
  }

  async loadFiles() {
    if (this.viewMode === 'playlists') {
      await Playlists.loadPlaylistsView();
      return;
    }
    if (this.viewMode === 'collections') {
      await Playlists.loadCollectionsView();
      return;
    }
    if (this.viewMode === 'discover') {
      await Playlists.loadDiscoverView();
      return;
    }
    if (this.viewMode === 'playlist-detail' && this.playlistId) {
      await Playlists.loadPlaylistDetail(this.playlistId);
      return;
    }
    if (this.viewMode === 'collection-detail' && this.collectionId) {
      await Playlists.loadCollectionDetail(this.collectionId);
      return;
    }
    if (this.viewMode === 'favorites') {
      const data = await API.files.favorites();
      this.files = (data.files || []).map((f) => ({ ...f, _favorite: true }));
      return;
    }
    if (this.viewMode === 'recent') {
      const data = await API.get('/api/files/recent?limit=100');
      this.files = data.files || [];
      return;
    }
    if (this.viewMode === 'trash') {
      const data = await API.files.trashList();
      this.listHasMore = false;
      this.files = (data.files || []).map((f) => ({
        ...f,
        _trash: true,
        encryption_mode: 'chunk',
        chunk_count: f.chunk_count || 0,
        has_thumbnail: f.has_thumbnail || 0,
        has_hls: false,
      }));
      return;
    }
    if (this.viewMode === 'shared') {
      const data = await API.get('/api/files/shared');
      this.files = data.files || [];
      return;
    }

    const params = new URLSearchParams({ path: this.currentPath });
    if (this.searchQuery) params.set('search', this.searchQuery);
    if (this.filterType) params.set('type', this.filterType);
    if (this.sort) params.set('sort', this.sort);
    if (this.sortOrder) params.set('order', this.sortOrder);
    params.set('limit', String(this.pageSize));
    params.set('offset', '0');
    if (this.accountView && this.accountView !== 'primary') params.set('view', this.accountView);
    const data = await API.get(`/api/files/list?${params}`);
    this.files = data.files || [];
    this.listTotal = data.total ?? this.files.length;
    this.listHasMore = !!data.hasMore;
    this.listOffset = data.nextOffset ?? this.files.length;
    this.bindInfiniteScroll();
  }

  async loadMore() {
    if (!this.listHasMore || this.loadingMore || this.viewMode !== 'files') return;
    this.loadingMore = true;
    try {
      const params = new URLSearchParams({ path: this.currentPath });
      if (this.searchQuery) params.set('search', this.searchQuery);
      if (this.filterType) params.set('type', this.filterType);
      if (this.sort) params.set('sort', this.sort);
      if (this.sortOrder) params.set('order', this.sortOrder);
      params.set('limit', String(this.pageSize));
      params.set('offset', String(this.listOffset));
      if (this.accountView && this.accountView !== 'primary') params.set('view', this.accountView);
      const data = await API.get(`/api/files/list?${params}`);
      const next = data.files || [];
      const ids = new Set(this.files.map((f) => f.id));
      for (const f of next) {
        if (!ids.has(f.id)) this.files.push(f);
      }
      this.listHasMore = !!data.hasMore;
      this.listOffset = data.nextOffset ?? this.files.length;
      this.render();
      this.updateStatus();
    } catch (err) {
      App.toast(err.message, 'error');
    } finally {
      this.loadingMore = false;
    }
  }

  setSort(sort, order) {
    this.sort = sort;
    this.sortOrder = order;
    localStorage.setItem('vault-sort', sort);
    localStorage.setItem('vault-sort-order', order);
    if (this.viewMode === 'files') {
      this.navigate(this.currentPath, { viewMode: 'files', type: this.filterType, search: this.searchQuery, sort, order });
    }
  }

  syncFilterChips() {
    const activeView = this.resolveActiveView();
    document.querySelectorAll('.filter-chip').forEach((chip) => {
      const chipType = chip.dataset.type;
      const chipView = chip.dataset.view;
      let active = false;
      if (chipView) active = activeView === chipView;
      else if (chipType) active = this.viewMode === 'files' && this.filterType === chipType;
      else if (chip.dataset.all) active = this.viewMode === 'files' && !this.filterType;
      chip.classList.toggle('active', active);
      chip.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  updateFolderTreeSelection() {
    const tree = document.getElementById('folder-tree');
    if (!tree) return;
    tree.querySelectorAll('.tree-item').forEach((el) => {
      const selected = this.viewMode === 'files' && el.dataset.path === this.currentPath;
      el.classList.toggle('selected', selected);
    });
  }

  applyFilter(typeOrView) {
    const special = ['favorites', 'recent', 'trash', 'shared', 'discover', 'playlists', 'collections'];
    if (typeOrView === 'all' || typeOrView === null) {
      this.navigate(this.currentPath || '/', { viewMode: 'files', type: null, search: '', playlistId: null, collectionId: null });
      return;
    }
    if (special.includes(typeOrView)) {
      this.navigate('/', { viewMode: typeOrView, type: null, search: '', playlistId: null, collectionId: null });
      return;
    }
    const nextType = this.filterType === typeOrView ? null : typeOrView;
    this.navigate(this.currentPath, { viewMode: 'files', type: nextType, search: this.searchQuery });
  }

  async refresh({ filesOnly = false } = {}) {
    await this.navigate(this.currentPath, { silent: true });
    if (!filesOnly) await this.buildFolderTree();
  }

  goBack() {
    if (this.historyIndex > 0) {
      this.historyIndex--;
      const path = this.history[this.historyIndex];
      this.navigate(path, { viewMode: 'files', type: null });
    }
  }

  goUp() {
    if (this.isSpecialView() || this.currentPath === '/') return;
    const parts = this.currentPath.split('/').filter(Boolean);
    parts.pop();
    const newPath = parts.length ? '/' + parts.join('/') : '/';
    this.pushHistory(newPath);
    this.navigate(newPath, { viewMode: 'files', type: this.filterType });
  }

  pushHistory(path) {
    this.history = this.history.slice(0, this.historyIndex + 1);
    this.history.push(path);
    this.historyIndex = this.history.length - 1;
    document.getElementById('btn-back').disabled = this.historyIndex <= 0;
  }

  openItem(file) {
    if (this.isTrashView()) return;
    if (this.viewMode === 'playlist-detail' && file._inPlaylist) {
      Playlists.playPlaylist(this.playlistId, file.id);
      return;
    }
    if (file._playlist && (this.viewMode === 'playlists' || this.viewMode === 'collection-detail')) {
      Playlists.playPlaylist(file.id);
      return;
    }
    if (file.is_folder) {
      this.pushHistory(file.path);
      this.navigate(file.path, { viewMode: 'files', type: this.filterType });
    } else {
      API.files.accessed(file.id).catch(() => {});
      if (!Viewer.open(file)) this.downloadFile(file);
    }
  }

  fileItemClass(file, { settled = true } = {}) {
    return 'file-item'
      + (settled ? ' file-item-settled' : '')
      + (this.selected.has(file.id) ? ' selected' : '')
      + (file.pending ? ' pending' : '')
      + (file._trash ? ' file-trash' : '')
      + (file.is_favorite ? ' file-favorite' : '');
  }

  formatDate(ts) {
    if (!ts) return '—';
    try {
      return new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    } catch {
      return ts;
    }
  }

  formatHlsDuration(seconds) {
    if (!seconds || !Number.isFinite(seconds)) return '0:00';
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  hlsFileOverlay(file) {
    if (!file || file.is_folder || file.pending) return '';
    const hasHls = Number(file.has_hls) > 0 || Number(file.hls_segment_count) > 0;
    if (!hasHls) return '';
    const dur = Number(file.hls_duration_sec) || 0;
    const durationLabel = this.formatHlsDuration(dur);
    const broken = this.isHlsIncomplete(file);
    const brokenClass = broken ? ' hls-duration-broken' : '';
    const title = broken
      ? `HLS may be incomplete — ${durationLabel} (${file.hls_segment_count || 0} segment(s))`
      : `HLS duration ${durationLabel}`;
    return `<div class="hls-file-badges" title="${this.escape(title)}">`
      + `<span class="hls-duration-badge${brokenClass}">${durationLabel}</span>`
      + '<span class="hls-file-badge">m3u8</span>'
      + '</div>';
  }

  fileItemHtml(file) {
    if (file._trashGroupHeader) {
      const collapsed = this.trashCollapsed.has(file._trashGroupPath);
      const arrow = collapsed ? '▶' : '▼';
      return `
        <div class="file-icon-wrap"><div class="file-icon">📁</div></div>
        <div class="file-name trash-group-name">${arrow} ${this.escape(file.name)} <span class="trash-group-count">(${file._trashGroupCount})</span></div>
        <div class="file-size">${this.escape(file._trashGroupPath)}</div>
      `;
    }
    const isPending = !!file.pending;
    const isTrash = !!file._trash;
    const thumbSrc = file.has_thumbnail
      ? ThumbCache.resolveUrl(file.id, file.thumbVersion)
      : '';
    const hasHls = !isPending && !file.is_folder && (file.has_hls || (file.hls_segment_count > 0));
    const hlsOverlay = hasHls ? this.hlsFileOverlay(file) : '';
    const iconHtml = !isPending && file.has_thumbnail
      ? `<div class="file-icon-wrap"><img class="file-thumb" src="${thumbSrc}" alt="" loading="lazy" decoding="async">${hlsOverlay}</div>`
      : `<div class="file-icon-wrap"><div class="file-icon">${isPending ? '⏳' : getFileIcon(file.name, file.is_folder)}</div>${hlsOverlay}${file.is_favorite ? '<span class="favorite-badge" title="Favorite">★</span>' : ''}</div>`;

    const label = this.displayName(file);
    const title = label !== file.name ? file.name : '';

    let metaHtml = '';
    if (isTrash) {
      const origPath = file.path || file.parent_path || '/';
      const deleted = file.deleted_at || file.created_at;
      metaHtml = `
        <div class="file-meta file-meta-trash">
          <span class="file-meta-path" title="${this.escape(origPath)}">${this.escape(origPath)}</span>
          <span class="file-meta-date">Deleted ${this.escape(this.formatDate(deleted))}</span>
        </div>
        <div class="file-size">${formatSize(file.size || 0)}</div>
      `;
    } else if (isPending) {
      metaHtml = `
        <div class="file-upload-bar"><div class="file-upload-bar-fill" data-bar="${file.uploadPercent || 0}"></div></div>
        <div class="file-size">${this.escape(file.uploadStatus || 'Uploading...')}</div>
      `;
    } else if (!file.is_folder) {
      const epBadge = this.viewMode === 'playlist-detail' && file._inPlaylist
        ? `<span class="playlist-ep-badge" title="Episode order">#${(file._playlistIndex ?? file.position ?? 0) + 1}</span>`
        : '';
      const orderControls = this.viewMode === 'playlist-detail' && file._inPlaylist
        ? `<div class="playlist-order-controls">
            <button type="button" class="playlist-order-btn" data-order="-1" title="Move earlier" aria-label="Move earlier">↑</button>
            <button type="button" class="playlist-order-btn" data-order="1" title="Move later" aria-label="Move later">↓</button>
          </div>`
        : '';
      metaHtml = `${orderControls}<div class="file-size">${epBadge}${formatSize(file.size)}</div>`;
    }

    let viewBadge = '';
    if (this.accountView !== 'primary' && !file.is_folder && file.view_status && file.view_status !== 'folder') {
      if (file.view_status === 'synced') {
        viewBadge = '<span class="view-badge synced" title="Fully available in this view">✓</span>';
      } else if (file.view_status === 'partial') {
        viewBadge = `<span class="view-badge partial" title="Partially available">${file.view_chunks_available || 0}/${file.view_chunks_total || 0}</span>`;
      }
    }

    return `
      ${iconHtml}
      <div class="file-name"${title ? ` title="${this.escape(title)}"` : ''}>${this.escape(label)}${viewBadge}</div>
      ${metaHtml}
    `;
  }

  bindFileItem(el, file) {
    if (file._trashGroupHeader) {
      el.classList.add('trash-group-header');
      el.onclick = (e) => {
        e.stopPropagation();
        this.toggleTrashGroup(file._trashGroupPath);
      };
      return;
    }
    if (file.pending) return;
    if (this.viewMode === 'playlist-detail' && file._inPlaylist) {
      el.querySelectorAll('.playlist-order-btn').forEach((btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const delta = parseInt(btn.dataset.order, 10);
          Playlists.movePlaylistItem(file.id, delta);
        });
      });
      el.draggable = true;
      el.addEventListener('dragstart', (e) => {
        if (e.target.closest('.playlist-order-btn')) {
          e.preventDefault();
          return;
        }
        this.playlistDragFileId = file.id;
        e.dataTransfer.setData('application/x-vault-playlist-reorder', file.id);
        e.dataTransfer.effectAllowed = 'move';
        e.currentTarget.classList.add('dragging');
      });
      el.addEventListener('dragover', (e) => {
        if (!e.dataTransfer.types.includes('application/x-vault-playlist-reorder')) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        el.classList.add('drop-target');
      });
      el.addEventListener('dragleave', (e) => {
        if (!el.contains(e.relatedTarget)) el.classList.remove('drop-target');
      });
      el.addEventListener('drop', async (e) => {
        if (!e.dataTransfer.types.includes('application/x-vault-playlist-reorder')) return;
        e.preventDefault();
        e.stopPropagation();
        el.classList.remove('drop-target');
        const draggedId = e.dataTransfer.getData('application/x-vault-playlist-reorder');
        if (!draggedId || draggedId === file.id) return;
        const targetIndex = this.files.findIndex((f) => f.id === file.id);
        if (targetIndex < 0) return;
        await Playlists.movePlaylistItemToIndex(draggedId, targetIndex);
      });
      el.addEventListener('dragend', () => {
        this.playlistDragFileId = null;
        el.classList.remove('dragging', 'drop-target');
      });
    }
    el.onclick = (e) => this.handleClick(e, file);
    el.ondblclick = (e) => {
      if (this.renamingId || e.target.closest('.file-rename-input')) return;
      this.openItem(file);
    };
    el.oncontextmenu = (e) => this.showContextMenu(e, file);
    if (!this.isTrashView() && !(this.viewMode === 'playlist-detail' && file._inPlaylist)) {
      el.draggable = true;
      el.addEventListener('dragstart', (e) => this.handleDragStart(e, file));
      el.addEventListener('dragend', () => this.handleDragEnd());
      if (file.is_folder) this.bindFolderDropTarget(el, file);
    }

    const img = el.querySelector('img.file-thumb');
    if (img && file.has_thumbnail) {
      ThumbCache.prefetch(file.id, file.thumbVersion).then((url) => {
        if (url && img.isConnected) img.src = url;
      }).catch(() => {});
    }
  }

  getMoveIds(file) {
    return this.selected.has(file.id) ? [...this.selected] : [file.id];
  }

  getSelectedFileObjects() {
    return this.files.filter((f) => this.selected.has(f.id) && !f.is_folder);
  }

  getActionTargets(file = null) {
    const fromSelection = this.getSelectedFileObjects();
    if (fromSelection.length > 0) return fromSelection;
    if (this.selected.size > 0 && file && this.selected.has(file.id) && !file.is_folder) {
      return [file];
    }
    return file && !file.is_folder ? [file] : [];
  }

  isHlsIncomplete(file) {
    if (!file || file.is_folder) return false;
    const count = Number(file.hls_segment_count) || 0;
    if (!count && !Number(file.has_hls)) return false;
    const min = Math.max(1, Math.ceil((file.size || 0) / (40 * 1024 * 1024)));
    return count < min;
  }

  isHlsEligible(file) {
    if (!file || file.is_folder) return false;
    return Number(file.has_hls) > 0 || Number(file.hls_segment_count) > 0;
  }

  isVideoEligibleForHls(file) {
    return !!file && !file.is_folder
      && (file.mime_type?.startsWith('video/') || /\.mp4$/i.test(file.name || ''))
      && (Number(file.has_hls) <= 0 || this.isHlsIncomplete(file));
  }

  hideSelectionActionsMenu() {
    document.getElementById('selection-actions-menu')?.classList.add('hidden');
    const btn = document.getElementById('btn-selection-actions');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  toggleSelectionActionsMenu() {
    const menu = document.getElementById('selection-actions-menu');
    const btn = document.getElementById('btn-selection-actions');
    if (!menu || !btn || btn.disabled) return;
    const willOpen = menu.classList.contains('hidden');
    menu.classList.toggle('hidden');
    btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
  }

  async verifyHlsSelected() {
    return VerifyHls.runForSelection();
  }

  async uploadThumbnailSelected() {
    return ThumbUpload.runForSelection();
  }

  async refreshThumbnailsSelected() {
    const targets = this.getSelectedFileObjects();
    if (!targets.length) {
      App.toast('Select at least one file', 'error');
      return;
    }
    let done = 0;
    let failed = 0;
    for (const file of targets) {
      try {
        await this.refreshThumbnail(file, { quiet: true });
        done += 1;
      } catch (err) {
        failed += 1;
        App.toast(`${file.name}: ${err.message || 'Refresh failed'}`, 'error');
      }
    }
    if (done) {
      App.toast(`Refreshed ${done} thumbnail(s)${failed ? ` (${failed} failed)` : ''}`, failed ? 'error' : 'success');
      await this.refresh({ filesOnly: true });
    }
  }

  async hlsConvertSelected() {
    const targets = this.getSelectedFileObjects().filter((f) => this.isVideoEligibleForHls(f));
    if (!targets.length) {
      App.toast('No eligible videos selected for HLS conversion', 'error');
      return;
    }
    for (const file of targets) {
      try {
        const result = await API.files.hlsConvert(file.id);
        if (result?.taskId) TaskPanel.track(result.taskId);
      } catch (err) {
        App.toast(`${file.name}: ${err.message || 'HLS conversion failed'}`, 'error');
      }
    }
    TaskPanel.setExpanded(true);
    App.toast(`Started HLS conversion for ${targets.length} file(s)`, 'success');
  }

  verifyFileSelected() {
    const targets = this.getSelectedFileObjects();
    if (!targets.length) {
      App.toast('Select a file to verify', 'error');
      return;
    }
    if (targets.length > 1) {
      App.toast('Verify file works on one file at a time — select a single file', 'error');
      return;
    }
    VerifyRepair.prompt(targets[0]);
  }

  runBulkAction(action) {
    this.hideSelectionActionsMenu();
    if (action === 'verify-hls') return this.verifyHlsSelected();
    if (action === 'upload-thumb') return this.uploadThumbnailSelected();
    if (action === 'refresh-thumb') return this.refreshThumbnailsSelected();
    if (action === 'verify-file') return this.verifyFileSelected();
    if (action === 'hls-convert') return this.hlsConvertSelected();
    if (action === 'delete') return this.deleteSelected();
    return null;
  }

  handleDragStart(e, file) {
    const ids = this.getMoveIds(file);
    this.dragIds = ids;
    e.dataTransfer.setData('application/x-vault-move', JSON.stringify(ids));
    e.dataTransfer.effectAllowed = 'move';
    e.currentTarget.classList.add('dragging');
  }

  handleDragEnd() {
    this.dragIds = null;
    document.querySelectorAll('.file-item.dragging, .file-item.drop-target').forEach((el) => {
      el.classList.remove('dragging', 'drop-target');
    });
  }

  bindFolderDropTarget(el, folder) {
    el.addEventListener('dragover', (e) => {
      if (!e.dataTransfer.types.includes('application/x-vault-move')) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      el.classList.add('drop-target');
    });
    el.addEventListener('dragleave', (e) => {
      if (!el.contains(e.relatedTarget)) el.classList.remove('drop-target');
    });
    el.addEventListener('drop', async (e) => {
      if (!e.dataTransfer.types.includes('application/x-vault-move')) return;
      e.preventDefault();
      e.stopPropagation();
      el.classList.remove('drop-target');
      const ids = JSON.parse(e.dataTransfer.getData('application/x-vault-move') || '[]');
      await this.moveItems(ids, folder.path);
    });
  }

  createFileElement(file, { settled = false } = {}) {
    const el = document.createElement('div');
    el.className = this.fileItemClass(file, { settled });
    el.dataset.id = file.id;
    el.dataset.renderSig = this.fileRenderSig(file);
    el.tabIndex = 0;
    el.setAttribute('role', 'option');
    el.setAttribute('aria-selected', this.selected.has(file.id) ? 'true' : 'false');
    el.innerHTML = this.fileItemHtml(file);
    applyDynamicStyles(el);
    this.bindFileItem(el, file);
    return el;
  }

  updateFileElement(el, file) {
    const sig = this.fileRenderSig(file);
    const nextClass = this.fileItemClass(file, { settled: true });
    el.className = nextClass;
    el.setAttribute('aria-selected', this.selected.has(file.id) ? 'true' : 'false');

    if (file.pending) {
      const fill = el.querySelector('.file-upload-bar-fill');
      const statusEl = el.querySelector('.file-size');
      if (fill) fill.style.width = `${file.uploadPercent || 0}%`;
      if (statusEl) statusEl.textContent = file.uploadStatus || 'Uploading...';
      el.dataset.renderSig = sig;
      return;
    }

    if (el.dataset.renderSig === sig) return;

    el.dataset.renderSig = sig;
    el.innerHTML = this.fileItemHtml(file);
    applyDynamicStyles(el);
    this.bindFileItem(el, file);
  }

  updateSelectionClasses() {
    document.querySelectorAll('#file-grid .file-item').forEach((el) => {
      const on = this.selected.has(el.dataset.id);
      el.classList.toggle('selected', on);
      el.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  render() {
    const grid = document.getElementById('file-grid');
    const empty = document.getElementById('empty-state');
    const fileView = document.getElementById('file-view');
    if (!grid) return;

    this.clearCuratedChrome();

    const curatedModes = ['playlists', 'collections', 'discover', 'playlist-detail', 'collection-detail'];
    if (curatedModes.includes(this.viewMode) && typeof Playlists !== 'undefined') {
      if (this.isCuratedCardView()) {
        VirtualGrid?.setEnabled?.(false);
        this.displayFiles = [];
      }
      grid.replaceChildren();
      const mount = fileView || grid.parentElement;
      if (mount) {
        const usedCards = Playlists.renderPlaylistGrid(mount);
        if (usedCards) {
          const discoverHasContent = this.viewMode === 'discover' && (
            (explorer._discover?.continue_watching?.length || 0) > 0
            || (explorer._discover?.recent_playlists?.length || 0) > 0
          );
          const showEmpty = this.files.length === 0 && !discoverHasContent;
          empty?.classList.toggle('hidden', !showEmpty);
          if (showEmpty) {
            this.setEmptyState(this.viewMode);
          }
          return;
        }
      }
    }

    this.displayFiles = this.getRenderableFiles();
    VirtualGrid.setEnabled(this.displayFiles.length > VirtualGrid.threshold);

    if (this.files.length === 0) {
      grid.replaceChildren();
      empty?.classList.remove('hidden');
      let emptyMode = 'default';
      if (this.searchQuery) emptyMode = 'search';
      else if (this.filterType) emptyMode = 'filter';
      else if (this.viewMode !== 'files') emptyMode = this.viewMode;
      this.setEmptyState(emptyMode);
      return;
    }
    empty?.classList.add('hidden');
    this.renderVisibleRange();
  }

  renderVisibleRange() {
    if (this.isCuratedCardView()) return;
    const grid = document.getElementById('file-grid');
    if (!grid) return;

    const range = VirtualGrid.computeRangeForRender();
    const slice = this.displayFiles.slice(range.start, range.end);
    const virtual = !!range.virtual;

    if (virtual) VirtualGrid.attachSpacers(grid);

    const existing = new Map(
      [...grid.querySelectorAll('.file-item')].map((el) => [el.dataset.id, el])
    );
    const nextEls = [];

    if (virtual) nextEls.push(VirtualGrid.topSentinel);

    for (const file of slice) {
      let el = existing.get(file.id);
      if (el) {
        existing.delete(file.id);
        this.updateFileElement(el, file);
      } else {
        el = this.createFileElement(file, { settled: virtual });
      }
      nextEls.push(el);
    }

    if (virtual) nextEls.push(VirtualGrid.bottomSentinel);

    for (const el of existing.values()) el.remove();
    this.syncGridChildren(grid, nextEls);

    if (virtual) {
      const cols = VirtualGrid.getColumns();
      const rowH = VirtualGrid.getRowHeight();
      const totalRows = Math.ceil(this.displayFiles.length / cols);
      VirtualGrid.range = {
        start: range.start,
        end: range.end,
        totalRows,
        rowH,
        cols,
        total: this.displayFiles.length,
        virtual: true,
      };
      VirtualGrid.updateSpacers(VirtualGrid.range);
    }

    ThumbCache.warmVisible(slice);
  }

  syncGridChildren(grid, nextEls) {
    const current = [...grid.children];
    if (current.length === nextEls.length && current.every((node, i) => node === nextEls[i])) return;
    grid.replaceChildren(...nextEls);
  }

  fileRenderSig(file) {
    return [
      file.id,
      file.name,
      file.size,
      file.mime_type || '',
      file.is_folder ? 1 : 0,
      file.pending ? 1 : 0,
      file.uploadPercent || 0,
      file.uploadStatus || '',
      file.has_thumbnail ? 1 : 0,
      file.has_hls ? 1 : 0,
      file.hls_segment_count || 0,
      file.hls_duration_sec || 0,
      file.is_favorite ? 1 : 0,
      file._inPlaylist ? (file._playlistIndex ?? file.position ?? '') : '',
      file._trash ? 1 : 0,
      file._trashGroupHeader ? `${file._trashGroupPath}:${file._trashGroupCount}` : '',
      this.viewMode,
    ].join('\x1e');
  }

  handleClick(e, file) {
    if (e.ctrlKey || e.metaKey) {
      if (this.selected.has(file.id)) this.selected.delete(file.id);
      else this.selected.add(file.id);
    } else {
      this.selected.clear();
      this.selected.add(file.id);
    }
    this.updateSelectionClasses();
    this.updateToolbar();
    this.updateStatus();

    if (this.selected.size === 1 && typeof showDetailsPanel === 'function') {
      const selectedFile = this.files.find((f) => f.id === [...this.selected][0]);
      if (selectedFile) showDetailsPanel(selectedFile);
    }
    if (this.selected.size !== 1 && typeof hideDetailsPanel === 'function') {
      hideDetailsPanel();
    }
  }

  selectAll() {
    this.selected.clear();
    for (const f of this.files) this.selected.add(f.id);
    this.updateSelectionClasses();
    this.updateToolbar();
    this.updateStatus();
  }

  updateBreadcrumb() {
    const bc = document.getElementById('breadcrumb');
    if (!bc) return;
    bc.innerHTML = '';

    const specialLabels = {
      favorites: 'Favorites',
      recent: 'Recent',
      shared: 'Shared',
      trash: 'Trash',
      playlists: 'Playlists',
      collections: 'Collections',
      discover: 'Discover',
      'playlist-detail': 'Playlist',
      'collection-detail': 'Collection',
    };
    if (specialLabels[this.viewMode]) {
      const parentLabel = specialLabels[this.viewMode];
      const detailTitle = this.viewMode === 'playlist-detail'
        ? Playlists.currentPlaylist?.title
        : this.viewMode === 'collection-detail'
          ? Playlists.currentCollection?.title
          : null;
      bc.innerHTML = '';
      const homeBtn = document.createElement('button');
      homeBtn.type = 'button';
      homeBtn.className = 'breadcrumb-item';
      homeBtn.textContent = 'Home';
      homeBtn.addEventListener('click', () => {
        this.pushHistory('/');
        this.navigate('/', { viewMode: 'files', type: null, search: '', playlistId: null, collectionId: null });
      });
      bc.appendChild(homeBtn);

      const parentView = this.resolveActiveView();
      if (detailTitle && (this.viewMode === 'playlist-detail' || this.viewMode === 'collection-detail')) {
        const sep1 = document.createElement('span');
        sep1.className = 'breadcrumb-sep';
        sep1.textContent = '›';
        bc.appendChild(sep1);
        const parentBtn = document.createElement('button');
        parentBtn.type = 'button';
        parentBtn.className = 'breadcrumb-item';
        parentBtn.textContent = parentLabel;
        parentBtn.addEventListener('click', () => {
          this.navigate('/', { viewMode: parentView, type: null, search: '', playlistId: null, collectionId: null });
        });
        bc.appendChild(parentBtn);
        const sep2 = document.createElement('span');
        sep2.className = 'breadcrumb-sep';
        sep2.textContent = '›';
        bc.appendChild(sep2);
        const span = document.createElement('span');
        span.className = 'breadcrumb-special';
        span.textContent = detailTitle;
        bc.appendChild(span);
      } else {
        const sep = document.createElement('span');
        sep.className = 'breadcrumb-sep';
        sep.textContent = '›';
        bc.appendChild(sep);
        const span = document.createElement('span');
        span.className = 'breadcrumb-special';
        span.textContent = parentLabel;
        bc.appendChild(span);
      }
      document.getElementById('btn-up').disabled = true;
      return;
    }

    const parts = this.currentPath === '/' ? [] : this.currentPath.split('/').filter(Boolean);
    const items = [{ name: 'Home', path: '/' }, ...parts.map((p, i) => ({
      name: p,
      path: '/' + parts.slice(0, i + 1).join('/'),
    }))];

    items.forEach((item, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.className = 'breadcrumb-sep';
        sep.textContent = '›';
        sep.setAttribute('aria-hidden', 'true');
        bc.appendChild(sep);
      }
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'breadcrumb-item';
      el.textContent = item.name;
      el.addEventListener('click', () => {
        this.pushHistory(item.path);
        this.navigate(item.path, { viewMode: 'files', type: this.filterType });
      });
      bc.appendChild(el);
    });

    document.getElementById('btn-up').disabled = this.currentPath === '/';
  }

  updateStatus() {
    const total = this.files.length;
    const folders = this.files.filter((f) => f.is_folder).length;
    const files = total - folders;
    const itemsEl = document.getElementById('status-items');
    if (itemsEl) {
      let label = `${total} item${total !== 1 ? 's' : ''}`;
      if (this.viewMode === 'files') {
        label += ` (${folders} folder${folders !== 1 ? 's' : ''}, ${files} file${files !== 1 ? 's' : ''})`;
      } else {
        label += ` · ${this.viewMode}`;
      }
      itemsEl.textContent = label;
    }

    if (this.selected.size > 0) {
      const selectedFiles = this.files.filter((f) => this.selected.has(f.id) && !f.is_folder);
      const size = selectedFiles.reduce((s, f) => s + (f.size || 0), 0);
      document.getElementById('status-selected').textContent = `${this.selected.size} selected`;
      document.getElementById('status-size').textContent = selectedFiles.length ? formatSize(size) : '';
    } else {
      document.getElementById('status-selected').textContent = '';
      document.getElementById('status-size').textContent = '';
    }
  }

  updateToolbar() {
    const hasSelection = this.selected.size > 0;
    const selectedFiles = this.files.filter((f) => this.selected.has(f.id));
    const hasFiles = selectedFiles.some((f) => !f.is_folder);
    const singleFolder = selectedFiles.length === 1 && selectedFiles[0].is_folder;
    const trash = this.isTrashView();
    const curated = this.isCuratedBrowseView();
    const playlistDetail = this.viewMode === 'playlist-detail';
    const collectionDetail = this.viewMode === 'collection-detail';

    const dl = document.getElementById('btn-download');
    const mv = document.getElementById('btn-move');
    const del = document.getElementById('btn-delete');
    const restore = document.getElementById('btn-restore');
    const permDel = document.getElementById('btn-permanent-delete');

    if (dl) dl.disabled = !hasFiles || trash || curated;
    if (mv) mv.disabled = !hasSelection || trash || curated;
    if (del) {
      del.disabled = !hasSelection || (curated && !playlistDetail && !collectionDetail);
      const label = del.querySelector('span:last-child');
      if (label) {
        if (trash) label.textContent = 'Delete forever';
        else if (playlistDetail) label.textContent = 'Remove from playlist';
        else if (collectionDetail) label.textContent = 'Remove from collection';
        else label.textContent = 'Delete';
      }
    }
    if (restore) restore.classList.toggle('hidden', !trash);
    if (restore) restore.disabled = !hasSelection;
    if (permDel) permDel.classList.toggle('hidden', !trash);
    if (permDel) permDel.disabled = !hasSelection;

    const actionsBtn = document.getElementById('btn-selection-actions');
    const actionsMenu = document.getElementById('selection-actions-menu');
    const curatedBlocked = trash || curated;
    if (actionsBtn) {
      actionsBtn.disabled = !hasSelection || curatedBlocked || playlistDetail || collectionDetail;
    }
    if (actionsMenu && actionsBtn?.disabled) {
      actionsMenu.classList.add('hidden');
      actionsBtn.setAttribute('aria-expanded', 'false');
    }
    if (actionsMenu) {
      const fileTargets = selectedFiles.filter((f) => !f.is_folder);
      const hlsTargets = fileTargets.filter((f) => this.isHlsEligible(f));
      const videoTargets = fileTargets.filter((f) => this.isVideoEligibleForHls(f));
      const verifyHlsItem = actionsMenu.querySelector('[data-bulk-action="verify-hls"]');
      const uploadThumbItem = actionsMenu.querySelector('[data-bulk-action="upload-thumb"]');
      const refreshThumbItem = actionsMenu.querySelector('[data-bulk-action="refresh-thumb"]');
      const verifyFileItem = actionsMenu.querySelector('[data-bulk-action="verify-file"]');
      const hlsConvertItem = actionsMenu.querySelector('[data-bulk-action="hls-convert"]');
      const deleteItem = actionsMenu.querySelector('[data-bulk-action="delete"]');
      if (verifyHlsItem) {
        verifyHlsItem.disabled = hlsTargets.length === 0;
        verifyHlsItem.textContent = hlsTargets.length > 1
          ? `Verify HLS (${hlsTargets.length} files)`
          : 'Verify HLS';
      }
      if (uploadThumbItem) {
        uploadThumbItem.disabled = fileTargets.length === 0;
        uploadThumbItem.textContent = fileTargets.length > 1
          ? `Set custom thumbnails (${fileTargets.length} files)`
          : 'Set custom thumbnail';
      }
      if (refreshThumbItem) {
        refreshThumbItem.disabled = fileTargets.length === 0;
        refreshThumbItem.textContent = fileTargets.length > 1
          ? `Refresh thumbnails (${fileTargets.length} files)`
          : 'Refresh thumbnail';
      }
      if (verifyFileItem) {
        verifyFileItem.disabled = fileTargets.length !== 1;
        verifyFileItem.textContent = 'Verify file';
      }
      if (hlsConvertItem) {
        hlsConvertItem.disabled = videoTargets.length === 0;
        const reconvert = videoTargets.some((f) => this.isHlsIncomplete(f));
        hlsConvertItem.textContent = videoTargets.length > 1
          ? (reconvert ? `Re-convert to HLS (${videoTargets.length} files)` : `Convert to HLS (${videoTargets.length} files)`)
          : (reconvert ? 'Re-convert to HLS' : 'Convert to HLS');
      }
      if (deleteItem) {
        deleteItem.textContent = trash ? 'Delete forever' : 'Delete';
      }
    }

    const openItem = document.querySelector('[data-action="open"]');
    if (openItem) openItem.style.display = singleFolder ? '' : 'none';
  }

  async downloadFile(file) {
    await DownloadManager.downloadFile(file, { view: this.accountView });
  }

  async downloadSelected() {
    const files = this.files.filter((f) => this.selected.has(f.id) && !f.is_folder);
    for (const file of files) await this.downloadFile(file);
  }

  async refreshThumbnail(file, opts = {}) {
    if (!file || file.is_folder) return;
    try {
      if (!opts.quiet) App.toast(`Refreshing thumbnail for ${file.name}...`);
      await API.files.refreshThumbnail(file.id);
      await ThumbUpload.applyThumbnailToFile(file);
      if (!opts.quiet) App.toast(`Thumbnail updated for ${file.name}`, 'success');
      if (!opts.quiet) await this.refresh({ filesOnly: true });
    } catch (err) {
      let msg = err.message || 'Refresh failed';
      if (msg === 'Not Found') {
        msg = 'Refresh endpoint not found — hard-refresh the page (Ctrl+Shift+R)';
      }
      App.toast(msg, 'error');
    }
  }

  async deleteSelected() {
    const ids = [...this.selected];
    if (!ids.length) return;

    if (this.viewMode === 'playlist-detail' && this.playlistId) {
      return this.removeFromPlaylistSelected();
    }
    if (this.viewMode === 'collection-detail' && this.collectionId) {
      return this.removeFromCollectionSelected();
    }
    if (this.isCuratedBrowseView()) return;

    if (this.isTrashView()) {
      return this.permanentDeleteSelected();
    }

    const count = ids.length;
    if (!confirm(`Move ${count} item(s) to trash?`)) return;

    const deleteBtn = document.getElementById('btn-delete');
    App.setButtonLoading(deleteBtn, true);
    document.querySelectorAll('.file-item').forEach((el) => {
      if (ids.includes(el.dataset.id)) el.classList.add('removing');
    });

    try {
      await API.files.trashBatch(ids);
      DisplayNames.removeMany(ids);
      this.selected.clear();
      this.updateToolbar();
      this.files = this.files.filter((f) => !ids.includes(f.id));
      this.render();
      this.updateStatus();
      App.toast(`${count} item${count === 1 ? '' : 's'} moved to trash`, 'success');
      App.loadStats();
    } catch (err) {
      document.querySelectorAll('.file-item.removing').forEach((el) => el.classList.remove('removing'));
      App.toast(`Failed to delete: ${err.message}`, 'error');
    }
    App.setButtonLoading(deleteBtn, false);
  }

  async removeFromPlaylistSelected() {
    const ids = [...this.selected];
    if (!ids.length || !this.playlistId) return;
    if (!confirm(`Remove ${ids.length} item(s) from this playlist?`)) return;
    try {
      await API.playlists.removeItems(this.playlistId, ids);
      this.selected.clear();
      await Playlists.loadPlaylistDetail(this.playlistId);
      this.render();
      this.updateToolbar();
      this.updateStatus();
      App.toast('Removed from playlist', 'success');
    } catch (err) {
      App.toast(err.message, 'error');
    }
  }

  async removeFromCollectionSelected() {
    const ids = [...this.selected];
    if (!ids.length || !this.collectionId) return;
    if (!confirm(`Remove ${ids.length} playlist(s) from this collection?`)) return;
    try {
      for (const playlistId of ids) {
        await API.playlists.removePlaylistFromCollection(this.collectionId, playlistId);
      }
      this.selected.clear();
      await Playlists.loadCollectionDetail(this.collectionId);
      this.render();
      this.updateToolbar();
      this.updateStatus();
      App.toast('Removed from collection', 'success');
    } catch (err) {
      App.toast(err.message, 'error');
    }
  }

  async restoreSelected() {
    const ids = [...this.selected];
    if (!ids.length) return;
    const btn = document.getElementById('btn-restore');
    App.setButtonLoading(btn, true);
    try {
      await API.files.restoreBatch(ids);
      this.selected.clear();
      this.files = this.files.filter((f) => !ids.includes(f.id));
      this.render();
      this.updateToolbar();
      this.updateStatus();
      App.toast(`Restored ${ids.length} item${ids.length === 1 ? '' : 's'}`, 'success');
      App.loadStats();
    } catch (err) {
      App.toast(err.message, 'error');
    }
    App.setButtonLoading(btn, false);
  }

  async restoreFile(file) {
    if (!file?.id) return;
    try {
      await API.files.restore(file.id);
      this.files = this.files.filter((f) => f.id !== file.id);
      this.selected.delete(file.id);
      this.render();
      this.updateToolbar();
      this.updateStatus();
      App.toast(`Restored ${file.name}`, 'success');
    } catch (err) {
      App.toast(err.message, 'error');
    }
  }

  async permanentDeleteSelected() {
    const ids = [...this.selected];
    if (!ids.length) return;
    if (!confirm(`Permanently delete ${ids.length} item(s)? This removes chunks from GitHub and cannot be undone.`)) return;

    const btn = document.getElementById('btn-permanent-delete') || document.getElementById('btn-delete');
    App.setButtonLoading(btn, true);
    document.querySelectorAll('.file-item').forEach((el) => {
      if (ids.includes(el.dataset.id)) el.classList.add('removing');
    });

    try {
      const { taskId } = await API.files.deleteBatch(ids);
      TaskPanel.track(taskId);
      DisplayNames.removeMany(ids);
      this.selected.clear();
      this.files = this.files.filter((f) => !ids.includes(f.id));
      this.render();
      this.updateToolbar();
      this.updateStatus();
    } catch (err) {
      document.querySelectorAll('.file-item.removing').forEach((el) => el.classList.remove('removing'));
      App.toast(`Failed to delete: ${err.message}`, 'error');
    }
    App.setButtonLoading(btn, false);
  }

  async toggleFavorite(file) {
    if (!file?.id || file.is_folder) return;
    try {
      const result = await API.files.favorite(file.id);
      file.is_favorite = result.is_favorite ? 1 : 0;
      const el = document.querySelector(`#file-grid .file-item[data-id="${file.id}"]`);
      if (el) this.updateFileElement(el, file);
      App.toast(result.is_favorite ? 'Added to favorites' : 'Removed from favorites', 'success');
      if (this.viewMode === 'favorites' && !result.is_favorite) {
        this.files = this.files.filter((f) => f.id !== file.id);
        this.render();
        this.updateStatus();
      }
    } catch (err) {
      App.toast(err.message, 'error');
    }
  }

  showContextMenu(e, file) {
    e.preventDefault();
    e.stopPropagation();
    this.contextMode = 'item';
    this.contextTarget = file;
    if (!this.selected.has(file.id)) {
      this.selected.clear();
      this.selected.add(file.id);
      this.updateSelectionClasses();
      this.updateToolbar();
    }

    const menu = document.getElementById('context-menu');
    const itemActions = document.getElementById('context-item-actions');
    const trashActions = document.getElementById('context-trash-actions');
    const blankActions = document.getElementById('context-blank-actions');

    itemActions?.classList.toggle('hidden', this.isTrashView());
    trashActions?.classList.toggle('hidden', !this.isTrashView());
    blankActions?.classList.add('hidden');

    if (this.isTrashView()) {
      this.positionContextMenu(menu, e.clientX, e.clientY);
      return;
    }

    const openItem = menu.querySelector('[data-action="open"]');
    const previewItem = menu.querySelector('[data-action="preview"]');
    const renameItem = menu.querySelector('[data-action="rename"]');
    const favoriteItem = menu.querySelector('[data-action="favorite"]');
    const previewType = !file.is_folder && getPreviewType(file.name, file.mime_type);

    openItem.style.display = file.is_folder ? '' : 'none';
    previewItem.style.display = previewType ? '' : 'none';
    previewItem.textContent = previewType === 'video' ? 'Play' : 'Preview';
    renameItem.style.display = this.selected.size === 1 ? '' : 'none';
    if (favoriteItem) {
      favoriteItem.style.display = file.is_folder ? 'none' : '';
      favoriteItem.textContent = file.is_favorite ? 'Remove from favorites' : 'Add to favorites';
    }

    const dlItem = menu.querySelector('[data-action="download"]');
    const detailsItem = menu.querySelector('[data-action="details"]');
    const shareItem = menu.querySelector('[data-action="share"]');
    const thumbItem = menu.querySelector('[data-action="refresh-thumb"]');
    const uploadThumbItem = menu.querySelector('[data-action="upload-thumb"]');
    const verifyItem = menu.querySelector('[data-action="verify-file"]');
    const verifyHlsItem = menu.querySelector('[data-action="verify-hls"]');
    const hlsItem = menu.querySelector('[data-action="hls-convert"]');
    const moveItem = menu.querySelector('[data-action="move"]');
    const addPlaylistItem = menu.querySelector('[data-action="add-to-playlist"]');
    const linkFolderItem = menu.querySelector('[data-action="link-folder-to-playlist"]');
    const deleteItem = menu.querySelector('[data-action="delete"]');

    dlItem.style.display = file.is_folder ? 'none' : '';
    detailsItem.style.display = file.is_folder ? 'none' : '';
    shareItem.style.display = file.is_folder ? 'none' : '';
    if (thumbItem) thumbItem.style.display = file.is_folder ? 'none' : '';
    if (uploadThumbItem) uploadThumbItem.style.display = file.is_folder ? 'none' : '';
    if (thumbItem && fileTargets.length > 1) {
      thumbItem.textContent = `Refresh thumbnails (${fileTargets.length} files)`;
    } else if (thumbItem) {
      thumbItem.textContent = 'Refresh thumbnail';
    }
    if (uploadThumbItem && fileTargets.length > 1) {
      uploadThumbItem.textContent = `Set custom thumbnails (${fileTargets.length} files)...`;
    } else if (uploadThumbItem) {
      uploadThumbItem.textContent = 'Set custom thumbnail...';
    }
    if (verifyItem) verifyItem.style.display = file.is_folder ? 'none' : '';
    const actionTargets = this.getActionTargets(file);
    const fileTargets = actionTargets.filter((f) => !f.is_folder);
    const hlsTargets = actionTargets.filter((f) => this.isHlsEligible(f));
    const videoTargets = actionTargets.filter((f) => this.isVideoEligibleForHls(f));
    if (verifyHlsItem) {
      const showVerifyHls = !file.is_folder && hlsTargets.length > 0;
      verifyHlsItem.style.display = showVerifyHls ? '' : 'none';
      verifyHlsItem.classList.remove('hidden');
      verifyHlsItem.textContent = hlsTargets.length > 1
        ? `Verify HLS (${hlsTargets.length} files)`
        : 'Verify HLS';
    }
    if (verifyItem && actionTargets.length > 1) {
      verifyItem.style.display = 'none';
    }
    if (addPlaylistItem) addPlaylistItem.style.display = file.is_folder ? 'none' : '';
    if (linkFolderItem) linkFolderItem.style.display = file.is_folder ? '' : 'none';
    if (hlsItem) {
      const showConvert = videoTargets.length > 0;
      hlsItem.style.display = showConvert ? '' : 'none';
      hlsItem.classList.remove('hidden');
      const reconvert = videoTargets.some((f) => this.isHlsIncomplete(f));
      hlsItem.textContent = videoTargets.length > 1
        ? (reconvert ? `Re-convert to HLS (${videoTargets.length} files)` : `Convert to HLS (${videoTargets.length} files)`)
        : (reconvert ? 'Re-convert to HLS' : 'Convert to HLS');
    }

    const playlistDetail = this.viewMode === 'playlist-detail' && file._inPlaylist;

    if (playlistDetail) {
      previewItem.style.display = '';
      previewItem.textContent = 'Play';
      renameItem.style.display = 'none';
      if (favoriteItem) favoriteItem.style.display = 'none';
      dlItem.style.display = 'none';
      detailsItem.style.display = 'none';
      shareItem.style.display = 'none';
      if (thumbItem) thumbItem.style.display = 'none';
      if (uploadThumbItem) uploadThumbItem.style.display = 'none';
      if (verifyItem) verifyItem.style.display = 'none';
      if (verifyHlsItem) verifyHlsItem.style.display = 'none';
      if (hlsItem) hlsItem.style.display = 'none';
      if (moveItem) moveItem.style.display = 'none';
      if (addPlaylistItem) addPlaylistItem.style.display = 'none';
      if (linkFolderItem) linkFolderItem.style.display = 'none';
      if (deleteItem) deleteItem.textContent = 'Remove from playlist';
    } else if (this.isCuratedBrowseView()) {
      if (moveItem) moveItem.style.display = 'none';
      if (addPlaylistItem) addPlaylistItem.style.display = 'none';
      if (linkFolderItem) linkFolderItem.style.display = 'none';
      if (deleteItem) deleteItem.style.display = 'none';
    } else if (deleteItem) {
      deleteItem.textContent = 'Move to trash';
    }

    this.positionContextMenu(menu, e.clientX, e.clientY);
  }

  showBlankContextMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    this.contextMode = 'blank';
    this.contextTarget = null;

    const menu = document.getElementById('context-menu');
    document.getElementById('context-item-actions')?.classList.add('hidden');
    document.getElementById('context-trash-actions')?.classList.add('hidden');
    document.getElementById('context-blank-actions')?.classList.remove('hidden');
    this.positionContextMenu(menu, e.clientX, e.clientY);
  }

  hideContextMenu() {
    document.getElementById('context-menu')?.classList.add('hidden');
    this.contextMode = 'item';
  }

  startRename(file) {
    if (!file || file.pending || this.isTrashView()) return;
    const el = document.getElementById('file-grid')?.querySelector(`.file-item[data-id="${file.id}"]`);
    if (!el) return;

    const nameEl = el.querySelector('.file-name');
    if (!nameEl || nameEl.querySelector('.file-rename-input')) return;

    this.renamingId = file.id;
    el.classList.add('renaming');

    const current = this.displayName(file);
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'file-rename-input';
    input.value = current;
    input.setAttribute('aria-label', 'Rename file');

    let cancelled = false;

    const finish = () => {
      if (!cancelled) {
        const next = input.value.trim();
        if (next && next !== file.name) DisplayNames.set(file.id, next);
        else DisplayNames.remove(file.id);
      }
      this.renamingId = null;
      el.classList.remove('renaming');
      this.render();
      if (file.is_folder) this.buildFolderTree();
    };

    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
      if (ev.key === 'Escape') {
        ev.preventDefault();
        cancelled = true;
        this.renamingId = null;
        el.classList.remove('renaming');
        nameEl.textContent = current;
      }
    });
    input.addEventListener('blur', finish, { once: true });
    input.addEventListener('click', (ev) => ev.stopPropagation());

    nameEl.replaceChildren(input);
    input.focus();
    input.select();
  }

  async moveItems(ids, destination) {
    const uniqueIds = [...new Set((ids || []).filter(Boolean))];
    if (!uniqueIds.length) return;

    try {
      const result = await API.files.move(uniqueIds, destination);
      if (result.moved === 0) {
        App.toast('Items are already in that folder', 'info');
        return;
      }
      const label = result.moved === 1 ? '1 item moved' : `${result.moved} items moved`;
      App.toast(label, 'success');
      this.selected.clear();
      this.updateToolbar();
      await this.refresh();
    } catch (err) {
      App.toast(err.message, 'error');
    }
  }

  async showMoveDialog(ids) {
    const uniqueIds = [...new Set((ids || []).filter(Boolean))];
    if (!uniqueIds.length) return;

    this.moveIds = uniqueIds;
    this.moveDestination = '/';

    const desc = document.getElementById('move-modal-desc');
    desc.textContent = uniqueIds.length === 1
      ? 'Choose where to move this item.'
      : `Choose where to move ${uniqueIds.length} items.`;

    const picker = document.getElementById('move-folder-picker');
    picker.innerHTML = '<div class="folder-picker-item selected" data-path="/"><span>🏠</span> Home</div>';

    const homeItem = picker.querySelector('[data-path="/"]');
    homeItem.addEventListener('click', () => this.selectMoveDestination('/', picker));

    try {
      const allFolders = await this.getAllFolders('/');
      const excluded = await this.getExcludedMoveDestinations(uniqueIds);
      this.renderMovePicker(picker, allFolders, excluded);
    } catch { /* Home-only picker */ }

    document.getElementById('btn-confirm-move').disabled = false;
    document.getElementById('move-modal').classList.remove('hidden');
  }

  async getExcludedMoveDestinations(ids) {
    const excluded = new Set();
    for (const id of ids) {
      let file = this.files.find((entry) => entry.id === id);
      if (!file) {
        const data = await API.files.details(id).catch(() => null);
        file = data?.file;
      }
      if (!file?.is_folder) continue;
      excluded.add(file.path);
      const descendants = await this.getAllFolders(file.path);
      this.collectFolderPaths(descendants, excluded);
    }
    return excluded;
  }

  collectFolderPaths(folders, paths) {
    for (const folder of folders) {
      paths.add(folder.path);
      if (folder.children?.length) this.collectFolderPaths(folder.children, paths);
    }
  }

  selectMoveDestination(path, picker) {
    this.moveDestination = path;
    picker.querySelectorAll('.folder-picker-item').forEach((el) => {
      el.classList.toggle('selected', el.dataset.path === path);
    });
    document.getElementById('btn-confirm-move').disabled = false;
  }

  renderMovePicker(container, folders, excludedPaths) {
    for (const folder of folders) {
      const el = document.createElement('div');
      const disabled = excludedPaths.has(folder.path);
      el.className = `folder-picker-item${disabled ? ' disabled' : ''}`;
      el.dataset.path = folder.path;
      el.style.paddingLeft = `${12 + (folder.depth || 0) * 12}px`;
      el.innerHTML = `<span>📁</span> ${this.escape(folder.name)}`;
      if (!disabled) {
        el.addEventListener('click', () => this.selectMoveDestination(folder.path, container));
      }
      container.appendChild(el);

      if (folder.children?.length) {
        this.renderMovePicker(container, folder.children.map((child) => ({
          ...child,
          depth: (folder.depth || 0) + 1,
        })), excludedPaths);
      }
    }
  }

  async confirmMove() {
    const btn = document.getElementById('btn-confirm-move');
    App.setButtonLoading(btn, true);
    try {
      await this.moveItems(this.moveIds, this.moveDestination);
      document.getElementById('move-modal').classList.add('hidden');
    } finally {
      App.setButtonLoading(btn, false);
    }
  }

  async buildFolderTree() {
    const tree = document.getElementById('folder-tree');
    if (!tree) return;
    tree.innerHTML = '';

    try {
      const allFolders = await this.getAllFolders('/');
      this.renderTree(tree, allFolders, '/');
    } catch { /* optional */ }
  }

  async getAllFolders(path, depth = 0) {
    const data = await API.files.list(path);
    const folders = data.files.filter((f) => f.is_folder);
    const result = [];
    for (const folder of folders) {
      const children = await this.getAllFolders(folder.path, depth + 1);
      result.push({ ...folder, children, depth });
    }
    return result;
  }

  renderTree(container, folders, basePath) {
    for (const folder of folders) {
      const el = document.createElement('div');
      el.className = 'tree-item';
      el.dataset.path = folder.path;
      el.innerHTML = `<span>📁</span> ${this.escape(this.displayName(folder))}`;
      if (this.viewMode === 'files' && folder.path === this.currentPath) {
        el.classList.add('selected');
      }
      el.addEventListener('click', () => {
        this.pushHistory(folder.path);
        this.navigate(folder.path, { viewMode: 'files', type: this.filterType });
      });
      container.appendChild(el);
      if (folder.children?.length) {
        const childContainer = document.createElement('div');
        childContainer.style.paddingLeft = '12px';
        this.renderTree(childContainer, folder.children, folder.path);
        container.appendChild(childContainer);
      }
    }
  }

  updatePendingProgress(pendingId, percent, status) {
    const item = this.files.find((f) => f.id === pendingId);
    if (!item) return;

    item.uploadPercent = percent;
    item.uploadStatus = status;

    const el = document.getElementById('file-grid')?.querySelector(`[data-id="${pendingId}"]`);
    if (el) {
      const fill = el.querySelector('.file-upload-bar-fill');
      const statusEl = el.querySelector('.file-size');
      if (fill) fill.style.width = `${percent}%`;
      if (statusEl) statusEl.textContent = status;
      return;
    }
    this.render();
  }

  escape(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
}
