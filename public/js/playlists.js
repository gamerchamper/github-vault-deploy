/**
 * Playlist & Collection management UI
 */
const Playlists = {
  currentPlaylist: null,
  currentCollection: null,
  builderItems: [],
  collectionBuilderItems: [],
  dragIndex: null,
  collectionDragIndex: null,
  pendingAddFileIds: null,

  thumbUrl(fileId) {
    if (typeof ThumbCache !== 'undefined') return ThumbCache.resolveUrl(fileId);
    return `/api/files/thumbnail/${fileId}`;
  },

  async loadPlaylistsView() {
    const data = await API.playlists.list();
    explorer.files = (data.playlists || []).map((p) => ({
      id: p.id,
      name: p.title,
      _playlist: p,
      is_folder: false,
      size: p.total_bytes || 0,
      item_count: p.item_count,
    }));
    explorer.listTotal = explorer.files.length;
    explorer.listHasMore = false;
  },

  async loadCollectionsView() {
    const data = await API.playlists.collections();
    explorer.files = (data.collections || []).map((c) => ({
      id: c.id,
      name: c.title,
      _collection: c,
      is_folder: false,
      size: 0,
      playlist_count: c.playlist_count,
    }));
    explorer.listTotal = explorer.files.length;
    explorer.listHasMore = false;
  },

  async loadDiscoverView() {
    const data = await API.playlists.discover();
    explorer.files = [];
    explorer._discover = data;
    explorer.listTotal = 0;
    explorer.listHasMore = false;
  },

  async loadCollectionDetail(collectionId) {
    const col = await API.playlists.getCollection(collectionId);
    this.currentCollection = col;
    explorer.files = (col.playlists || []).map((p) => ({
      id: p.id,
      name: p.title,
      _playlist: p,
      is_folder: false,
      size: p.total_bytes || 0,
      item_count: p.item_count,
    }));
    explorer.listTotal = explorer.files.length;
    explorer.listHasMore = false;
  },

  async loadPlaylistDetail(playlistId) {
    const pl = await API.playlists.get(playlistId);
    this.currentPlaylist = pl;
    explorer.files = (pl.items || []).map((f, idx) => ({
      ...f,
      _inPlaylist: true,
      _playlistIndex: idx,
      _playlistPosition: f.position ?? idx,
    }));
    explorer.listTotal = explorer.files.length;
    explorer.listHasMore = false;
  },

  playlistItemIds() {
    return (this.currentPlaylist?.items || explorer.files.filter((f) => f._inPlaylist)).map((f) => f.id);
  },

  async applyPlaylistOrder(fileIds) {
    const id = this.currentPlaylist?.id || explorer.playlistId;
    if (!id || !fileIds.length) return;
    await API.playlists.reorder(id, fileIds);
    await this.loadPlaylistDetail(id);
    explorer.render();
  },

  async smartSortPlaylist(playlistId) {
    const id = playlistId || this.currentPlaylist?.id || explorer.playlistId;
    if (!id) return;
    const modal = document.getElementById('playlist-builder-modal');
    const regexFromBuilder = modal && !modal.classList.contains('hidden')
      ? this.normalizeSortRegex(this.getBuilderSortRegex())
      : '';
    const regex = regexFromBuilder || this.currentPlaylist?.sort_regex || '';
    try {
      if (regex) this.validateSortRegex(regex);
      const result = await API.playlists.smartReorder(id, regex ? { sort_regex: regex } : {});
      await this.loadPlaylistDetail(id);
      explorer.render();
      if (result.moved > 0) {
        App.toast(`Reordered ${result.moved} item(s)${regex ? ' using regex' : ''}`, 'success');
      } else {
        App.toast(regex
          ? 'No order change — check regex matches filenames (e.g. EP\\.(\d+))'
          : 'Already in episode order', 'info');
      }
    } catch (err) {
      App.toast(err.message, 'error');
    }
  },

  normalizeSortRegex(raw) {
    let value = String(raw || '').trim();
    if (!value) return '';
    const wrapped = value.match(/^\/(.+)\/([a-z]*)$/i);
    if (wrapped) value = wrapped[1];
    return value;
  },

  validateSortRegex(regex) {
    try {
      // eslint-disable-next-line no-new
      new RegExp(regex, 'i');
    } catch (err) {
      throw new Error(`Invalid sort regex: ${err.message}`);
    }
  },

  async smartSortBuilderItems() {
    const modal = document.getElementById('playlist-builder-modal');
    const id = modal?.dataset.playlistId;
    if (!id || !this.builderItems?.length) {
      App.toast('Nothing to sort', 'error');
      return;
    }
    if (typeof EpisodeMeta === 'undefined') {
      App.toast('Episode sort script missing — hard-refresh (Ctrl+F5)', 'error');
      return;
    }
    const regex = this.normalizeSortRegex(this.getBuilderSortRegex());
    try {
      if (regex) this.validateSortRegex(regex);
      const beforeIds = this.buildOrderedFileIds();
      this.builderItems = EpisodeMeta.sortItems(this.builderItems, regex || null);
      const afterIds = this.buildOrderedFileIds();
      const moved = afterIds.filter((fid, idx) => fid !== beforeIds[idx]).length;
      this.renderBuilderList();

      const payload = regex ? { sort_regex: regex } : {};
      const result = await API.playlists.smartReorder(id, payload);
      if (explorer.viewMode === 'playlist-detail' && explorer.playlistId === id) {
        await this.loadPlaylistDetail(id);
        explorer.render();
      }

      if (moved > 0 || result.moved > 0) {
        const n = Math.max(moved, result.moved || 0);
        App.toast(`Reordered ${n} item(s)${regex ? ' using regex' : ''}. Click Save to keep display names.`, 'success');
      } else {
        App.toast(regex
          ? 'No order change — regex may not match. Try: EP\\.(\d+)'
          : 'Already in episode order', 'info');
      }
    } catch (err) {
      App.toast(err.message, 'error');
    }
  },

  getBuilderSortRegex() {
    return this.normalizeSortRegex(document.getElementById('builder-sort-regex')?.value);
  },

  episodeMetaBadge(file) {
    if (typeof EpisodeMeta === 'undefined') return '';
    const title = file.display_name || file.name || '';
    const regex = this.getBuilderSortRegex();
    const meta = (regex && EpisodeMeta.parseWithRegex(title, regex))
      || EpisodeMeta.parse(title, file.parent_path || '');
    if (!meta.match || !meta.label) return '';
    const hint = regex ? 'Matched sort regex' : 'Detected from title';
    return `<span class="builder-ep-detected" title="${hint}">${this.escape(meta.label)}</span>`;
  },

  async movePlaylistItem(fileId, delta) {
    const ids = this.playlistItemIds();
    const idx = ids.indexOf(fileId);
    if (idx < 0) return;
    const next = idx + delta;
    if (next < 0 || next >= ids.length) return;
    [ids[idx], ids[next]] = [ids[next], ids[idx]];
    try {
      await this.applyPlaylistOrder(ids);
      App.toast('Episode order updated', 'success');
    } catch (err) {
      App.toast(err.message, 'error');
    }
  },

  async movePlaylistItemToIndex(fileId, targetIndex) {
    const ids = this.playlistItemIds();
    const from = ids.indexOf(fileId);
    if (from < 0 || from === targetIndex) return;
    ids.splice(from, 1);
    ids.splice(targetIndex, 0, fileId);
    try {
      await this.applyPlaylistOrder(ids);
      App.toast('Episode order updated', 'success');
    } catch (err) {
      App.toast(err.message, 'error');
    }
  },

  moveBuilderItem(idx, delta) {
    const next = idx + delta;
    if (next < 0 || next >= this.builderItems.length) return;
    const [moved] = this.builderItems.splice(idx, 1);
    this.builderItems.splice(next, 0, moved);
    this.renderBuilderList();
  },

  renderDiscoverPanel(container) {
    const d = explorer._discover;
    if (!d) return;
    container.innerHTML = `
      <div class="discover-sections">
        ${this.renderDiscoverSection('Continue watching', d.continue_watching, 'continue')}
        ${this.renderDiscoverSection('Recent playlists', d.recent_playlists, 'playlist')}
      </div>
    `;
    container.querySelectorAll('[data-playlist-id]').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.dataset.playlistId;
        const fileId = el.dataset.fileId;
        this.playPlaylist(id, fileId);
      });
    });
    container.querySelectorAll('[data-open-playlist]').forEach((el) => {
      el.addEventListener('click', () => {
        explorer.navigate('/', { viewMode: 'playlist-detail', playlistId: el.dataset.openPlaylist, collectionId: null });
      });
    });
  },

  renderDiscoverSection(title, items, type) {
    if (!items?.length) return '';
    const cards = items.map((item) => {
      if (type === 'continue') {
        return `
          <button type="button" class="media-card discover-card" data-playlist-id="${item.playlist_id}" data-file-id="${item.file_id}">
            <div class="media-card-art">${item.has_thumbnail ? `<img src="${this.thumbUrl(item.file_id)}" alt="">` : '▶'}</div>
            <div class="media-card-body">
              <span class="media-card-title">${item.file_name}</span>
              <span class="media-card-meta">${item.playlist_title} · ${Math.round(item.progress_pct || 0)}%</span>
            </div>
          </button>`;
      }
      return `
        <button type="button" class="media-card discover-card" data-open-playlist="${item.id}">
          <div class="media-card-art">${item.cover_thumbnail_id ? `<img src="${this.thumbUrl(item.cover_thumbnail_id)}" alt="">` : '📋'}</div>
          <div class="media-card-body">
            <span class="media-card-title">${item.title}</span>
            <span class="media-card-meta">${item.item_count || 0} items</span>
          </div>
        </button>`;
    }).join('');
    return `<section class="discover-section"><h2 class="discover-heading">${title}</h2><div class="media-card-grid">${cards}</div></section>`;
  },

  renderPlaylistGrid(fileView) {
    const mode = explorer.viewMode;
    if (mode === 'discover') {
      const grid = document.getElementById('file-grid');
      if (grid) {
        grid.innerHTML = '<div id="discover-panel" class="discover-panel"></div>';
        this.renderDiscoverPanel(document.getElementById('discover-panel'));
      }
      return true;
    }
    if (mode === 'collection-detail' && this.currentCollection) {
      this.renderCollectionHero(fileView);
      const grid = document.getElementById('file-grid');
      if (grid) this.renderMediaCards(grid);
      return true;
    }
    if (mode === 'playlists' || mode === 'collections') {
      const grid = document.getElementById('file-grid');
      if (grid) this.renderMediaCards(grid);
      return true;
    }
    if (mode === 'playlist-detail' && this.currentPlaylist) {
      this.renderPlaylistHero(fileView);
      return false;
    }
    return false;
  },

  renderCollectionHero(fileView) {
    const col = this.currentCollection;
    const hero = document.createElement('div');
    hero.className = 'curated-hero';
    hero.innerHTML = `
      <div class="curated-hero-art">${col.cover_thumbnail_id ? `<img src="${this.thumbUrl(col.cover_thumbnail_id)}" alt="">` : '<span class="curated-hero-fallback">📚</span>'}</div>
      <div class="curated-hero-body">
        <span class="curated-hero-eyebrow">Collection</span>
        <h1 class="curated-hero-title">${col.title}</h1>
        <p class="curated-hero-desc">${col.description || ''}</p>
        <div class="curated-hero-stats">${col.playlist_count || 0} playlists</div>
        <div class="curated-hero-actions">
          <button type="button" class="btn-primary" id="btn-collection-share">Share collection</button>
          <button type="button" class="btn-secondary" id="btn-collection-manage">Manage playlists</button>
          <button type="button" class="btn-secondary" id="btn-collection-edit">Edit</button>
        </div>
      </div>
    `;
    fileView.prepend(hero);
    hero.querySelector('#btn-collection-share')?.addEventListener('click', () => this.shareCollection(col.id));
    hero.querySelector('#btn-collection-manage')?.addEventListener('click', () => this.openCollectionBuilder(col));
    hero.querySelector('#btn-collection-edit')?.addEventListener('click', () => this.openCollectionModal(col));
  },

  renderPlaylistHero(fileView) {
    const pl = this.currentPlaylist;
    const folderLinks = pl.folder_links || [];
    const folderLinksHtml = folderLinks.length ? `
      <div class="playlist-folder-links">
        <span class="playlist-folder-links-label">Linked folders (auto-sync)</span>
        <ul class="playlist-folder-links-list">
          ${folderLinks.map((link) => `
            <li class="playlist-folder-link-item">
              <span class="playlist-folder-link-name">📁 ${link.folder_name}</span>
              <span class="playlist-folder-link-meta">${link.include_subfolders ? 'incl. subfolders · ' : ''}${link.sort_by} ${link.sort_order}</span>
              <button type="button" class="btn-link btn-sync-folder-link" data-folder-id="${link.folder_id}">Sync</button>
              <button type="button" class="btn-link btn-unlink-folder" data-folder-id="${link.folder_id}">Unlink</button>
            </li>
          `).join('')}
        </ul>
      </div>
    ` : '';
    const hero = document.createElement('div');
    hero.className = 'curated-hero';
    hero.innerHTML = `
      <div class="curated-hero-art">${pl.cover_thumbnail_id ? `<img src="${this.thumbUrl(pl.cover_thumbnail_id)}" alt="">` : '<span class="curated-hero-fallback">📋</span>'}</div>
      <div class="curated-hero-body">
        <span class="curated-hero-eyebrow">Playlist</span>
        <h1 class="curated-hero-title">${pl.title}</h1>
        <p class="curated-hero-desc">${pl.description || ''}</p>
        <div class="curated-hero-stats">${pl.item_count || 0} items · ${formatSize(pl.total_bytes || 0)}</div>
        ${folderLinksHtml}
        <p class="curated-hero-order-hint">Share links and Play all use the episode order below — drag items or use ↑↓ to reorder. New folder uploads are appended without changing your order.</p>
        <div class="curated-hero-actions">
          <button type="button" class="btn-primary" id="btn-playlist-play">▶ Play all</button>
          <button type="button" class="btn-secondary" id="btn-playlist-reorder">Reorder episodes</button>
          <button type="button" class="btn-secondary" id="btn-playlist-smart-sort" title="Sort by saved regex if set, otherwise season/episode from filenames">Smart sort</button>
          <button type="button" class="btn-secondary" id="btn-playlist-edit">Edit playlist</button>
          ${folderLinks.length ? '<button type="button" class="btn-secondary" id="btn-playlist-sync-folders">Sync folders</button>' : ''}
          <button type="button" class="btn-secondary" id="btn-playlist-share">${pl.share_url ? 'Copy share link' : 'Share'}</button>
          ${pl.share_url ? '<button type="button" class="btn-secondary" id="btn-playlist-unshare">Stop sharing</button>' : ''}
          <button type="button" class="btn-secondary" id="btn-playlist-duplicate">Duplicate</button>
          <button type="button" class="btn-danger" id="btn-playlist-delete">Delete playlist</button>
        </div>
      </div>
    `;
    fileView.prepend(hero);
    hero.querySelector('#btn-playlist-play')?.addEventListener('click', () => this.playPlaylist(pl.id));
    hero.querySelector('#btn-playlist-reorder')?.addEventListener('click', () => this.openBuilder(pl));
    hero.querySelector('#btn-playlist-smart-sort')?.addEventListener('click', () => this.smartSortPlaylist(pl.id));
    hero.querySelector('#btn-playlist-edit')?.addEventListener('click', () => this.openBuilder(pl));
    hero.querySelector('#btn-playlist-sync-folders')?.addEventListener('click', () => this.syncPlaylistFolders(pl.id));
    hero.querySelector('#btn-playlist-share')?.addEventListener('click', () => this.sharePlaylist(pl.id));
    hero.querySelector('#btn-playlist-unshare')?.addEventListener('click', () => this.unsharePlaylist(pl.id));
    hero.querySelector('#btn-playlist-duplicate')?.addEventListener('click', () => this.duplicatePlaylist(pl.id));
    hero.querySelector('#btn-playlist-delete')?.addEventListener('click', () => this.deletePlaylist(pl.id, pl.title));
    hero.querySelectorAll('.btn-unlink-folder').forEach((btn) => {
      btn.addEventListener('click', () => this.unlinkFolderFromPlaylist(pl.id, btn.dataset.folderId));
    });
    hero.querySelectorAll('.btn-sync-folder-link').forEach((btn) => {
      btn.addEventListener('click', () => this.syncPlaylistFolders(pl.id));
    });
  },

  async deletePlaylist(id, title) {
    const name = (title || 'this playlist').trim();
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
    try {
      await API.playlists.delete(id);
      if (this.currentPlaylist?.id === id) this.currentPlaylist = null;
      App.toast('Playlist deleted', 'success');
      explorer.navigate('/', { viewMode: 'playlists', playlistId: null, collectionId: null });
      await explorer.refresh();
    } catch (err) {
      App.toast(err.message, 'error');
    }
  },

  async unsharePlaylist(id) {
    try {
      await API.playlists.unshare(id);
      App.toast('Share link removed', 'success');
      if (explorer.viewMode === 'playlist-detail') {
        await this.loadPlaylistDetail(id);
        explorer.render();
      }
    } catch (err) {
      App.toast(err.message, 'error');
    }
  },

  async duplicatePlaylist(id) {
    try {
      const copy = await API.playlists.duplicate(id);
      App.toast('Playlist duplicated', 'success');
      explorer.navigate('/', { viewMode: 'playlist-detail', playlistId: copy.id, collectionId: null });
    } catch (err) {
      App.toast(err.message, 'error');
    }
  },

  renderMediaCards(container) {
    const mode = explorer.viewMode;
    container.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'media-card-grid';
    for (const file of explorer.files) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'media-card';
      const pl = file._playlist;
      const col = file._collection;
      const thumbId = pl?.cover_thumbnail_id || col?.cover_thumbnail_id;
      const meta = pl
        ? `${pl.item_count || 0} items`
        : `${col?.playlist_count || 0} playlists`;
      card.innerHTML = `
        <div class="media-card-art">${thumbId ? `<img src="${this.thumbUrl(thumbId)}" alt="">` : (mode === 'collections' ? '📚' : '📋')}</div>
        <div class="media-card-body">
          <span class="media-card-title">${file.name}</span>
          <span class="media-card-meta">${meta}</span>
        </div>
      `;
      card.addEventListener('click', () => {
        if (explorer.viewMode === 'collections') {
          explorer.navigate('/', { viewMode: 'collection-detail', collectionId: file.id, type: null, search: '', playlistId: null });
        } else {
          explorer.navigate('/', { viewMode: 'playlist-detail', playlistId: file.id, type: null, search: '', collectionId: null });
        }
      });
      card.addEventListener('dblclick', () => {
        if (file._playlist) this.playPlaylist(file.id);
      });
      if (file._playlist && mode === 'playlists') {
        card.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.deletePlaylist(file.id, file.name);
        });
      }
      grid.appendChild(card);
    }
    if (!explorer.files.length) {
      grid.innerHTML = `<p class="curated-empty">${mode === 'collections' ? 'No collections yet' : 'No playlists yet'}</p>`;
    }
    container.appendChild(grid);
  },

  async playPlaylist(playlistId, startFileId) {
    const pl = await API.playlists.get(playlistId);
    const start = startFileId || pl.items?.[0]?.id;
    if (!start) {
      App.toast('Playlist is empty', 'error');
      return;
    }
    const file = pl.items.find((f) => f.id === start) || pl.items[0];
    Viewer.openFromPlaylist(file, pl);
  },

  async sharePlaylist(id) {
    try {
      const res = await API.playlists.share(id);
      await navigator.clipboard.writeText(res.url);
      App.toast('Share link copied', 'success');
    } catch (err) {
      App.toast(err.message, 'error');
    }
  },

  async shareCollection(id) {
    try {
      const res = await API.playlists.shareCollection(id);
      await navigator.clipboard.writeText(res.url);
      App.toast('Share link copied', 'success');
    } catch (err) {
      App.toast(err.message, 'error');
    }
  },

  openCreatePlaylistModal() {
    this.openPlaylistModal();
  },

  openCreateCollectionModal() {
    this.openCollectionModal();
  },

  openPlaylistModal(existing = null) {
    const modal = document.getElementById('playlist-modal');
    if (!modal) return;
    document.getElementById('playlist-modal-title').textContent = existing ? 'Edit playlist' : 'New playlist';
    document.getElementById('playlist-form-title').value = existing?.title || '';
    document.getElementById('playlist-form-desc').value = existing?.description || '';
    document.getElementById('playlist-form-visibility').value = existing?.visibility || 'private';
    modal.dataset.playlistId = existing?.id || '';
    modal.classList.remove('hidden');
  },

  openCollectionModal(existing = null) {
    const modal = document.getElementById('collection-modal');
    if (!modal) return;
    document.getElementById('collection-modal-title').textContent = existing ? 'Edit collection' : 'New collection';
    document.getElementById('collection-form-title').value = existing?.title || '';
    document.getElementById('collection-form-desc').value = existing?.description || '';
    document.getElementById('collection-form-visibility').value = existing?.visibility || 'private';
    modal.dataset.collectionId = existing?.id || '';
    modal.classList.remove('hidden');
  },

  async savePlaylistModal() {
    const modal = document.getElementById('playlist-modal');
    const id = modal?.dataset.playlistId;
    const body = {
      title: document.getElementById('playlist-form-title').value,
      description: document.getElementById('playlist-form-desc').value,
      visibility: document.getElementById('playlist-form-visibility').value,
    };
    try {
      let saved;
      if (id) {
        saved = await API.playlists.update(id, body);
      } else {
        saved = await API.playlists.create(body);
      }
      modal.classList.add('hidden');
      App.toast('Playlist saved', 'success');
      if (explorer.viewMode === 'playlists') {
        await explorer.refresh();
      }
      if (!id && saved?.id) {
        const full = await API.playlists.get(saved.id);
        if (this.pendingAddFileIds?.length) {
          await this.addFilesToPlaylist(saved.id, this.pendingAddFileIds);
          this.pendingAddFileIds = null;
          this.closePlaylistPicker();
        } else {
          this.openBuilder(full);
        }
      }
    } catch (err) {
      App.toast(err.message, 'error');
    }
  },

  async saveCollectionModal() {
    const modal = document.getElementById('collection-modal');
    const id = modal?.dataset.collectionId;
    const body = {
      title: document.getElementById('collection-form-title').value,
      description: document.getElementById('collection-form-desc').value,
      visibility: document.getElementById('collection-form-visibility').value,
    };
    try {
      if (id) await API.playlists.updateCollection(id, body);
      else await API.playlists.createCollection(body);
      modal.classList.add('hidden');
      App.toast('Collection saved', 'success');
      if (explorer.viewMode === 'collections') explorer.refresh();
    } catch (err) {
      App.toast(err.message, 'error');
    }
  },

  async openBuilder(playlist) {
    const pl = playlist?.id ? await API.playlists.get(playlist.id) : playlist;
    this.currentPlaylist = pl;
    this.builderItems = [...(pl.items || [])];
    const modal = document.getElementById('playlist-builder-modal');
    if (!modal) return;
    document.getElementById('builder-title').textContent = pl.title;
    modal.dataset.playlistId = pl.id;
    const regexInput = document.getElementById('builder-sort-regex');
    if (regexInput) regexInput.value = pl.sort_regex || '';
    this.renderBuilderList();
    modal.classList.remove('hidden');
  },

  escape(str) {
    const node = document.createElement('span');
    node.textContent = str || '';
    return node.innerHTML;
  },

  renderBuilderList() {
    const list = document.getElementById('builder-item-list');
    if (!list) return;
    list.innerHTML = '';
    this.builderItems.forEach((file, idx) => {
      const row = document.createElement('div');
      row.className = 'builder-item';
      row.draggable = true;
      row.dataset.index = String(idx);
      row.innerHTML = `
        <span class="builder-ep-num" title="Episode number">${idx + 1}</span>
        <button type="button" class="builder-move" data-dir="-1" title="Move up" ${idx === 0 ? 'disabled' : ''}>↑</button>
        <button type="button" class="builder-move" data-dir="1" title="Move down" ${idx === this.builderItems.length - 1 ? 'disabled' : ''}>↓</button>
        <span class="builder-drag" aria-hidden="true">⠿</span>
        <div class="builder-item-fields">
          ${this.episodeMetaBadge(file)}
          <span class="builder-file-name" title="Vault filename">${this.escape(file.name)}</span>
          <input type="text" class="builder-display-name form-input" value="${this.escape(file.display_name || '')}" placeholder="Display name (optional)" title="Display name in playlist" aria-label="Display name for ${this.escape(file.name)}">
        </div>
        <button type="button" class="builder-remove" data-idx="${idx}" title="Remove">×</button>
      `;
      row.querySelectorAll('.builder-move').forEach((btn) => {
        btn.addEventListener('click', () => this.moveBuilderItem(idx, parseInt(btn.dataset.dir, 10)));
      });
      const input = row.querySelector('.builder-display-name');
      input?.addEventListener('input', () => {
        const value = input.value.trim();
        file.display_name = value || null;
      });
      row.addEventListener('dragstart', (e) => { this.dragIndex = idx; e.dataTransfer.effectAllowed = 'move'; });
      row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drag-over'); });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drag-over');
        if (this.dragIndex == null || this.dragIndex === idx) return;
        const [moved] = this.builderItems.splice(this.dragIndex, 1);
        this.builderItems.splice(idx, 0, moved);
        this.dragIndex = null;
        this.renderBuilderList();
      });
      row.querySelector('.builder-remove').addEventListener('click', () => {
        this.builderItems.splice(idx, 1);
        this.renderBuilderList();
      });
      list.appendChild(row);
    });
  },

  buildOrderedFileIds() {
    const seen = new Set();
    const ids = [];
    for (const f of this.builderItems) {
      if (!f?.id || seen.has(f.id)) continue;
      seen.add(f.id);
      ids.push(f.id);
    }
    return ids;
  },

  async saveBuilder() {
    const modal = document.getElementById('playlist-builder-modal');
    const id = modal?.dataset.playlistId;
    if (!id) return;
    try {
      const current = await API.playlists.get(id);
      const currentIds = new Set((current.items || []).map((f) => f.id));
      const newIds = new Set(this.buildOrderedFileIds());
      const toRemove = [...currentIds].filter((x) => !newIds.has(x));
      const toAdd = [...newIds].filter((x) => !currentIds.has(x));
      if (toRemove.length) await API.playlists.removeItems(id, toRemove);
      if (toAdd.length) await API.playlists.addItems(id, toAdd);
      const orderedIds = this.buildOrderedFileIds();
      if (orderedIds.length) {
        await API.playlists.reorder(id, orderedIds);
      }
      const displayUpdates = this.builderItems.map((f) => ({
        file_id: f.id,
        display_name: f.display_name || null,
      }));
      await API.playlists.updateItems(id, displayUpdates);
      const sortRegex = this.getBuilderSortRegex();
      if (sortRegex !== (current.sort_regex || '')) {
        await API.playlists.update(id, { sort_regex: sortRegex || null });
      }
      modal.classList.add('hidden');
      App.toast('Playlist updated', 'success');
      if (explorer.viewMode === 'playlist-detail') {
        await this.loadPlaylistDetail(id);
        explorer.render();
      }
    } catch (err) {
      App.toast(err.message, 'error');
    }
  },

  async addFilesToPlaylist(playlistId, fileIds) {
    try {
      await API.playlists.addItems(playlistId, fileIds);
      App.toast(`Added ${fileIds.length} item(s)`, 'success');
    } catch (err) {
      App.toast(err.message, 'error');
    }
  },

  filterFileIds(fileIds) {
    return [...new Set(fileIds)].filter((id) => {
      const f = explorer.files.find((x) => x.id === id);
      return !f || !f.is_folder;
    });
  },

  async promptAddToPlaylist(fileIds) {
    const ids = this.filterFileIds(fileIds);
    if (!ids.length) {
      App.toast('Select files to add (folders are not supported)', 'error');
      return;
    }
    const data = await API.playlists.list();
    const playlists = data.playlists || [];
    if (!playlists.length) {
      this.pendingAddFileIds = ids;
      this.openCreatePlaylistModal();
      return;
    }
    this.openPlaylistPicker(ids, playlists, { mode: 'add' });
  },

  async promptLinkFolderToPlaylist(folderId) {
    const folder = explorer.files.find((f) => f.id === folderId);
    if (!folder?.is_folder) {
      App.toast('Select a folder to link', 'error');
      return;
    }
    const data = await API.playlists.list();
    const playlists = data.playlists || [];
    if (!playlists.length) {
      App.toast('Create a playlist first', 'error');
      this.openCreatePlaylistModal();
      return;
    }
    this.openPlaylistPicker([folderId], playlists, { mode: 'link', folderId, folderName: folder.name });
  },

  async linkFolderToPlaylist(playlistId, folderId, options = {}) {
    try {
      const pl = await API.playlists.linkFolder(playlistId, folderId, options);
      App.toast('Folder linked — playlist will stay in sync', 'success');
      if (explorer.viewMode === 'playlist-detail' && this.currentPlaylist?.id === playlistId) {
        this.currentPlaylist = pl;
        await this.loadPlaylistDetail(playlistId);
        explorer.render();
      }
      return pl;
    } catch (err) {
      App.toast(err.message, 'error');
      return null;
    }
  },

  async unlinkFolderFromPlaylist(playlistId, folderId) {
    if (!confirm('Unlink this folder? Synced items from the folder will be removed from the playlist.')) return;
    try {
      const pl = await API.playlists.unlinkFolder(playlistId, folderId);
      App.toast('Folder unlinked', 'success');
      if (explorer.viewMode === 'playlist-detail' && this.currentPlaylist?.id === playlistId) {
        this.currentPlaylist = pl;
        await this.loadPlaylistDetail(playlistId);
        explorer.render();
      }
    } catch (err) {
      App.toast(err.message, 'error');
    }
  },

  async syncPlaylistFolders(playlistId) {
    try {
      const res = await API.playlists.sync(playlistId);
      const msg = res.added || res.removed
        ? `Synced (+${res.added || 0} / −${res.removed || 0})`
        : 'Playlist is up to date';
      App.toast(msg, 'success');
      if (explorer.viewMode === 'playlist-detail' && this.currentPlaylist?.id === playlistId) {
        this.currentPlaylist = res.playlist;
        await this.loadPlaylistDetail(playlistId);
        explorer.render();
      }
    } catch (err) {
      App.toast(err.message, 'error');
    }
  },

  openPlaylistPicker(fileIds, playlists, { mode = 'add', folderId = null, folderName = '' } = {}) {
    const modal = document.getElementById('playlist-picker-modal');
    const list = document.getElementById('playlist-picker-list');
    const title = document.getElementById('playlist-picker-title');
    const folderOpts = document.getElementById('playlist-picker-folder-opts');
    if (!modal || !list) return;
    modal.dataset.mode = mode;
    modal.dataset.fileIds = JSON.stringify(fileIds);
    modal.dataset.folderId = folderId || '';
    if (title) {
      title.textContent = mode === 'link'
        ? `Link “${folderName || 'folder'}” to playlist`
        : 'Add to playlist';
    }
    folderOpts?.classList.toggle('hidden', mode !== 'link');
    if (mode === 'link') {
      const subCb = document.getElementById('playlist-picker-include-subfolders');
      if (subCb) subCb.checked = false;
    }
    list.innerHTML = '';
    for (const pl of playlists) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'playlist-picker-item';
      btn.textContent = `${pl.title} (${pl.item_count || 0} items)`;
      btn.addEventListener('click', async () => {
        if (mode === 'link' && folderId) {
          const includeSubfolders = document.getElementById('playlist-picker-include-subfolders')?.checked;
          const sortBy = document.getElementById('playlist-picker-sort-by')?.value || 'name';
          await this.linkFolderToPlaylist(pl.id, folderId, {
            include_subfolders: includeSubfolders,
            sort_by: sortBy,
          });
        } else {
          await this.addFilesToPlaylist(pl.id, fileIds);
        }
        this.closePlaylistPicker();
      });
      list.appendChild(btn);
    }
    modal.classList.remove('hidden');
  },

  closePlaylistPicker() {
    document.getElementById('playlist-picker-modal')?.classList.add('hidden');
  },

  async openCollectionBuilder(collection) {
    const col = collection?.id ? await API.playlists.getCollection(collection.id) : collection;
    this.currentCollection = col;
    this.collectionBuilderItems = [...(col.playlists || [])];
    const modal = document.getElementById('collection-builder-modal');
    if (!modal) return;
    document.getElementById('collection-builder-title').textContent = col.title;
    modal.dataset.collectionId = col.id;
    this.renderCollectionBuilderList();
    modal.classList.remove('hidden');
  },

  renderCollectionBuilderList() {
    const list = document.getElementById('collection-builder-list');
    if (!list) return;
    list.innerHTML = '';
    this.collectionBuilderItems.forEach((pl, idx) => {
      const row = document.createElement('div');
      row.className = 'builder-item';
      row.draggable = true;
      row.dataset.index = String(idx);
      row.innerHTML = `
        <span class="builder-drag" aria-hidden="true">⠿</span>
        <span class="builder-name">${pl.title}</span>
        <span class="builder-meta">${pl.item_count || 0} items</span>
        <button type="button" class="builder-remove" data-idx="${idx}" title="Remove">×</button>
      `;
      row.addEventListener('dragstart', (e) => { this.collectionDragIndex = idx; e.dataTransfer.effectAllowed = 'move'; });
      row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drag-over'); });
      row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
      row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drag-over');
        if (this.collectionDragIndex == null || this.collectionDragIndex === idx) return;
        const [moved] = this.collectionBuilderItems.splice(this.collectionDragIndex, 1);
        this.collectionBuilderItems.splice(idx, 0, moved);
        this.collectionDragIndex = null;
        this.renderCollectionBuilderList();
      });
      row.querySelector('.builder-remove').addEventListener('click', () => {
        this.collectionBuilderItems.splice(idx, 1);
        this.renderCollectionBuilderList();
      });
      list.appendChild(row);
    });
  },

  async saveCollectionBuilder() {
    const modal = document.getElementById('collection-builder-modal');
    const id = modal?.dataset.collectionId;
    if (!id) return;
    try {
      const current = await API.playlists.getCollection(id);
      const currentIds = new Set((current.playlists || []).map((p) => p.id));
      const newIds = new Set(this.collectionBuilderItems.map((p) => p.id));
      const toRemove = [...currentIds].filter((x) => !newIds.has(x));
      const toAdd = [...newIds].filter((x) => !currentIds.has(x));
      for (const playlistId of toRemove) {
        await API.playlists.removePlaylistFromCollection(id, playlistId);
      }
      for (const playlistId of toAdd) {
        await API.playlists.addPlaylistToCollection(id, playlistId);
      }
      modal.classList.add('hidden');
      App.toast('Collection updated', 'success');
      if (explorer.viewMode === 'collection-detail') {
        await this.loadCollectionDetail(id);
        explorer.render();
      }
    } catch (err) {
      App.toast(err.message, 'error');
    }
  },

  async searchPlaylistsForCollection() {
    const q = document.getElementById('collection-builder-search')?.value?.trim().toLowerCase();
    const results = document.getElementById('collection-builder-results');
    if (!results || !q) return;
    const data = await API.playlists.list();
    results.innerHTML = '';
    for (const pl of (data.playlists || [])) {
      if (!pl.title?.toLowerCase().includes(q)) continue;
      if (this.collectionBuilderItems.find((x) => x.id === pl.id)) continue;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'builder-search-hit';
      btn.textContent = `${pl.title} (${pl.item_count || 0} items)`;
      btn.addEventListener('click', () => {
        this.collectionBuilderItems.push(pl);
        this.renderCollectionBuilderList();
      });
      results.appendChild(btn);
    }
  },

  bindEvents() {
    document.getElementById('btn-new-playlist')?.addEventListener('click', () => this.openCreatePlaylistModal());
    document.getElementById('btn-new-collection')?.addEventListener('click', () => this.openCreateCollectionModal());
    document.getElementById('btn-save-playlist')?.addEventListener('click', () => this.savePlaylistModal());
    document.getElementById('btn-save-collection')?.addEventListener('click', () => this.saveCollectionModal());
    document.getElementById('btn-save-builder')?.addEventListener('click', () => this.saveBuilder());
    document.getElementById('btn-builder-smart-sort')?.addEventListener('click', () => this.smartSortBuilderItems());
    document.getElementById('builder-sort-regex')?.addEventListener('input', () => {
      if (document.getElementById('playlist-builder-modal')?.classList.contains('hidden')) return;
      this.renderBuilderList();
    });
    document.getElementById('btn-save-collection-builder')?.addEventListener('click', () => this.saveCollectionBuilder());
    document.getElementById('collection-builder-add')?.addEventListener('click', () => this.searchPlaylistsForCollection());
    document.getElementById('collection-builder-search')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.searchPlaylistsForCollection();
    });
    document.getElementById('playlist-picker-new')?.addEventListener('click', () => {
      const modal = document.getElementById('playlist-picker-modal');
      if (modal?.dataset.mode === 'link') {
        this.closePlaylistPicker();
        this.openCreatePlaylistModal();
        return;
      }
      const fileIds = JSON.parse(modal?.dataset.fileIds || '[]');
      this.pendingAddFileIds = fileIds;
      this.closePlaylistPicker();
      this.openCreatePlaylistModal();
    });
    document.getElementById('builder-search')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('builder-add-files')?.click();
    });
    document.getElementById('builder-add-files')?.addEventListener('click', async () => {
      const q = document.getElementById('builder-search')?.value?.trim();
      if (!q) return;
      const res = await API.files.search(q, { limit: 20 });
      const results = document.getElementById('builder-search-results');
      results.innerHTML = '';
      for (const f of res.files || []) {
        if (f.is_folder) continue;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'builder-search-hit';
        btn.textContent = f.name;
        btn.addEventListener('click', () => {
          if (!this.builderItems.find((x) => x.id === f.id)) {
            this.builderItems.push(f);
            this.renderBuilderList();
          }
        });
        results.appendChild(btn);
      }
    });
  },
};
