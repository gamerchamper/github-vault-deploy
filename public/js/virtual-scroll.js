/**
 * Virtual scrolling for file grid/list using IntersectionObserver + requestAnimationFrame.
 * overscan >= 20 for smooth scrolling with 10,000+ items.
 */
const VirtualGrid = {
  overscan: 20,
  rowHeightGrid: 136,
  rowHeightList: 52,
  threshold: 40,
  rafId: null,
  range: { start: 0, end: 0 },
  enabled: false,

  init(explorer) {
    this.explorer = explorer;
    this.viewport = document.getElementById('file-view');
    this.grid = document.getElementById('file-grid');
    if (!this.viewport || !this.grid) return;

    this.topSentinel = document.createElement('div');
    this.topSentinel.className = 'virtual-spacer virtual-spacer-top';
    this.bottomSentinel = document.createElement('div');
    this.bottomSentinel.className = 'virtual-spacer virtual-spacer-bottom';

    this.viewport.addEventListener('scroll', () => this.scheduleUpdate(), { passive: true });
    window.addEventListener('resize', () => this.scheduleUpdate());

    this.observer = new IntersectionObserver(
      () => this.scheduleUpdate(),
      { root: this.viewport, rootMargin: '200px 0px', threshold: 0 }
    );
    this.observer.observe(this.topSentinel);
    this.observer.observe(this.bottomSentinel);
  },

  isListMode() {
    return this.grid?.classList.contains('file-grid-list');
  },

  getColumns() {
    if (this.isListMode()) return 1;
    const minCol = 110;
    const gap = 6;
    const padding = 28;
    const width = Math.max(0, (this.viewport?.clientWidth || 0) - padding);
    return Math.max(1, Math.floor((width + gap) / (minCol + gap)));
  },

  getRowHeight() {
    return this.isListMode() ? this.rowHeightList : this.rowHeightGrid;
  },

  shouldVirtualize(count) {
    return count > this.threshold;
  },

  scheduleUpdate() {
    if (this.rafId) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.updateRange();
    });
  },

  updateRange() {
    if (!this.enabled || !this.explorer) return;
    const total = this.explorer.displayFiles?.length || this.explorer.files.length;
    if (!this.shouldVirtualize(total)) {
      this.range = { start: 0, end: total };
      return;
    }

    const cols = this.getColumns();
    const rowH = this.getRowHeight();
    const scrollTop = this.viewport.scrollTop;
    const viewH = this.viewport.clientHeight;
    const totalRows = Math.ceil(total / cols);
    const overscanRows = Math.ceil(this.overscan / cols);

    let startRow = Math.floor(scrollTop / rowH) - overscanRows;
    let endRow = Math.ceil((scrollTop + viewH) / rowH) + overscanRows;
    startRow = Math.max(0, startRow);
    endRow = Math.min(totalRows, endRow);

    const start = startRow * cols;
    const end = Math.min(total, endRow * cols);

    if (start !== this.range.start || end !== this.range.end) {
      this.range = { start, end, totalRows, rowH, cols, total };
      this.explorer.renderVisibleRange();
    } else {
      this.updateSpacers(this.range);
    }
  },

  computeRangeForRender() {
    const total = this.explorer?.displayFiles?.length || this.explorer?.files?.length || 0;
    if (!this.enabled || !this.shouldVirtualize(total)) {
      return { start: 0, end: total, virtual: false };
    }
    if (!this.range.end) {
      const cols = this.getColumns();
      const rowH = this.getRowHeight();
      const viewH = this.viewport?.clientHeight || 600;
      const overscanRows = Math.ceil(this.overscan / cols);
      const visibleRows = Math.ceil(viewH / rowH) + overscanRows * 2;
      this.range = { start: 0, end: Math.min(total, visibleRows * cols) };
    }
    return { start: this.range.start, end: this.range.end, virtual: true };
  },

  updateSpacers(range) {
    if (!range?.virtual && !this.enabled) return;
    const { start = 0, end = 0, totalRows = 0, rowH = 0, cols = 1, total = 0 } = range;
    const startRow = Math.floor(start / cols);
    const endRow = Math.ceil(end / cols);
    const topH = startRow * rowH;
    const bottomH = Math.max(0, (totalRows - endRow) * rowH);

    if (this.topSentinel) this.topSentinel.style.height = `${topH}px`;
    if (this.bottomSentinel) this.bottomSentinel.style.height = `${bottomH}px`;
  },

  attachSpacers(grid) {
    if (!this.topSentinel.parentElement) {
      grid.prepend(this.topSentinel);
      grid.append(this.bottomSentinel);
    }
  },

  reset() {
    this.range = { start: 0, end: 0 };
    if (this.topSentinel) this.topSentinel.style.height = '0px';
    if (this.bottomSentinel) this.bottomSentinel.style.height = '0px';
  },

  setEnabled(on) {
    this.enabled = !!on;
    if (!on) {
      this.reset();
    } else {
      this.scheduleUpdate();
    }
  },
};
