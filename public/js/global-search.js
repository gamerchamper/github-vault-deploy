/**
 * Global vault search — cross-folder, virtualized results
 */
const GlobalSearch = {
  open: false,
  query: '',
  results: [],
  flatResults: [],
  recentKey: 'vault-recent-searches',
  debounce: null,
  rowHeight: 44,
  overscan: 12,
  scrollHandler: null,

  init() {
    const overlay = document.getElementById('global-search');
    if (!overlay) return;

    document.getElementById('btn-global-search')?.addEventListener('click', () => this.show());
    document.getElementById('global-search-close')?.addEventListener('click', () => this.hide());
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.hide();
    });

    const input = document.getElementById('global-search-input');
    input?.addEventListener('input', () => {
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => this.search(input.value), 200);
    });
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hide();
      if (e.key === 'Enter') this.search(input.value, true);
    });

    document.getElementById('global-search-results')?.addEventListener('click', (e) => {
      const row = e.target.closest('[data-search-id]');
      if (!row) return;
      const file = this.results.find((f) => f.id === row.dataset.searchId);
      if (!file) return;
      this.hide();
      this.openResult(file);
    });
  },

  show() {
    const overlay = document.getElementById('global-search');
    overlay?.classList.remove('hidden');
    this.open = true;
    const input = document.getElementById('global-search-input');
    if (input) {
      input.value = '';
      input.focus();
    }
    this.renderRecent();
    this.results = [];
    this.renderResults();
  },

  hide() {
    document.getElementById('global-search')?.classList.add('hidden');
    this.open = false;
  },

  getRecent() {
    try {
      return JSON.parse(localStorage.getItem(this.recentKey) || '[]');
    } catch {
      return [];
    }
  },

  saveRecent(q) {
    const term = (q || '').trim();
    if (!term || term.length < 2) return;
    let recent = this.getRecent().filter((r) => r !== term);
    recent.unshift(term);
    recent = recent.slice(0, 8);
    localStorage.setItem(this.recentKey, JSON.stringify(recent));
  },

  renderRecent() {
    const el = document.getElementById('global-search-recent');
    if (!el) return;
    const recent = this.getRecent();
    if (!recent.length) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = `
      <div class="global-search-section-label">Recent searches</div>
      <div class="global-search-chips">
        ${recent.map((r) => `<button type="button" class="filter-chip global-search-chip" data-recent="${this.escape(r)}">${this.escape(r)}</button>`).join('')}
      </div>
    `;
    el.querySelectorAll('[data-recent]').forEach((btn) => {
      btn.onclick = () => {
        const input = document.getElementById('global-search-input');
        if (input) input.value = btn.dataset.recent;
        this.search(btn.dataset.recent, true);
      };
    });
  },

  async search(q, save = false) {
    this.query = (q || '').trim();
    const resultsEl = document.getElementById('global-search-results');
    if (!this.query || this.query.length < 2) {
      this.results = [];
      if (resultsEl) resultsEl.innerHTML = '<div class="global-search-empty">Type at least 2 characters to search</div>';
      return;
    }
    if (save) this.saveRecent(this.query);
    if (resultsEl) resultsEl.innerHTML = '<div class="global-search-empty">Searching…</div>';

    try {
      const params = new URLSearchParams({ q: this.query, limit: '100' });
      const data = await API.get(`/api/files/search?${params}`);
      this.results = data.files || [];
      this.renderResults();
    } catch (err) {
      if (resultsEl) resultsEl.innerHTML = `<div class="global-search-empty error">${this.escape(err.message)}</div>`;
    }
  },

  buildFlatResults() {
    const groups = new Map();
    for (const f of this.results) {
      const folder = f.parent_path || '/';
      if (!groups.has(folder)) groups.set(folder, []);
      groups.get(folder).push(f);
    }
    const flat = [];
    for (const [folder, files] of groups) {
      flat.push({ type: 'label', folder });
      for (const f of files) flat.push({ type: 'row', file: f });
    }
    this.flatResults = flat;
  },

  renderResults() {
    const el = document.getElementById('global-search-results');
    if (!el) return;
    if (this.scrollHandler) {
      el.removeEventListener('scroll', this.scrollHandler);
      this.scrollHandler = null;
    }
    if (!this.results.length) {
      el.innerHTML = `<div class="global-search-empty">No results for "${this.escape(this.query)}"</div>`;
      return;
    }

    this.buildFlatResults();
    el.innerHTML = `
      <div class="global-search-count">${this.results.length} result${this.results.length === 1 ? '' : 's'}</div>
      <div class="global-search-virtual" id="global-search-virtual">
        <div class="global-search-virtual-spacer" id="global-search-spacer"></div>
        <div class="global-search-virtual-window" id="global-search-window"></div>
      </div>
    `;
    this.renderVisibleRows();
    this.scrollHandler = () => this.renderVisibleRows();
    el.addEventListener('scroll', this.scrollHandler, { passive: true });
  },

  renderVisibleRows() {
    const container = document.getElementById('global-search-results');
    const windowEl = document.getElementById('global-search-window');
    const spacerEl = document.getElementById('global-search-spacer');
    if (!container || !windowEl || !spacerEl) return;

    const total = this.flatResults.length;
    const scrollTop = container.scrollTop;
    const viewH = container.clientHeight || 400;
    const start = Math.max(0, Math.floor(scrollTop / this.rowHeight) - this.overscan);
    const visibleCount = Math.ceil(viewH / this.rowHeight) + this.overscan * 2;
    const end = Math.min(total, start + visibleCount);

    spacerEl.style.height = `${total * this.rowHeight}px`;
    windowEl.style.transform = `translateY(${start * this.rowHeight}px)`;
    windowEl.style.setProperty('--global-search-row-height', `${this.rowHeight}px`);

    let html = '';
    for (let i = start; i < end; i++) {
      const item = this.flatResults[i];
      if (item.type === 'label') {
        html += `<div class="global-search-group-label">${this.escape(item.folder === '/' ? 'Home' : item.folder)}</div>`;
      } else {
        const f = item.file;
        html += `
          <button type="button" class="global-search-row" data-search-id="${f.id}">
            <span class="global-search-icon">${getFileIcon(f.name, f.is_folder)}</span>
            <span class="global-search-name">${this.escape(f.name)}</span>
            <span class="global-search-meta">${f.is_folder ? 'Folder' : formatSize(f.size || 0)}</span>
          </button>`;
      }
    }
    windowEl.innerHTML = html;
  },

  openResult(file) {
    if (file.is_folder) {
      explorer.pushHistory(file.path);
      explorer.navigate(file.path, { viewMode: 'files', type: null, search: '' });
      return;
    }
    const parent = file.parent_path || '/';
    explorer.pushHistory(parent);
    explorer.navigate(parent, { viewMode: 'files', type: null, search: '' }).then(() => {
      explorer.selected.clear();
      explorer.selected.add(file.id);
      explorer.updateSelectionClasses();
      if (typeof Viewer !== 'undefined') Viewer.open(file);
    });
  },

  escape(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  },
};
