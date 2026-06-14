/**
 * Window-style resize for the media viewer panel (right + bottom edges).
 * Persists size/position across media switches via localStorage.
 */
const ViewerPanelLayout = {
  STORAGE_KEY: 'vault-viewer-panel-layout',
  MIN_W: 380,
  MIN_H: 260,
  EDGE_PX: 14,
  viewer: null,
  panel: null,
  activeAxis: null,
  boundDocMove: null,
  boundDocDown: null,
  listenersAttached: false,

  init() {
    this.boundDocMove = (e) => this.onDocumentMove(e);
    this.boundDocDown = (e) => this.onDocumentDown(e);

    this.viewer = document.getElementById('media-viewer');
    this.panel = this.viewer?.querySelector('.viewer-panel');
    if (!this.panel || this.panel.dataset.layoutReady) return;
    this.panel.dataset.layoutReady = '1';

    this.panel.querySelector('.viewer-resize-se')?.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.resetLayout();
      if (typeof Viewer !== 'undefined' && Viewer.currentMediaType === 'video') {
        const video = document.getElementById('viewer-video');
        if (video) Viewer.fitModalToVideo(video);
      }
    });

    window.addEventListener('resize', () => this.onWindowResize());
  },

  read() {
    try {
      const raw = localStorage.getItem(this.STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },

  save(layout) {
    try {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify(layout));
    } catch { /* quota */ }
  },

  isUserSized() {
    return !!this.read()?.userSized;
  },

  shouldSkipAutoFit() {
    return this.isUserSized();
  },

  clampToViewport(layout) {
    if (!layout) return layout;
    const margin = 12;
    const maxW = Math.max(this.MIN_W, window.innerWidth - margin * 2);
    const maxH = Math.max(this.MIN_H, window.innerHeight - margin * 2);
    let width = Math.min(Math.max(this.MIN_W, layout.width || this.MIN_W), maxW);
    let height = Math.min(Math.max(this.MIN_H, layout.height || this.MIN_H), maxH);
    let left = layout.left ?? Math.round((window.innerWidth - width) / 2);
    let top = layout.top ?? Math.round((window.innerHeight - height) / 2);
    left = Math.min(Math.max(margin, left), window.innerWidth - width - margin);
    top = Math.min(Math.max(margin, top), window.innerHeight - height - margin);
    return {
      ...layout,
      width: Math.round(width),
      height: Math.round(height),
      left: Math.round(left),
      top: Math.round(top),
      userSized: true,
    };
  },

  captureCurrent() {
    const rect = this.panel.getBoundingClientRect();
    return this.clampToViewport({
      width: rect.width,
      height: rect.height,
      left: rect.left,
      top: rect.top,
      userSized: true,
    });
  },

  apply(layout) {
    if (!this.panel || !layout) return;
    const clamped = this.clampToViewport(layout);
    this.panel.classList.add('viewer-panel-custom');
    this.viewer?.classList.add('viewer-layout-custom');
    this.panel.style.position = 'fixed';
    this.panel.style.left = `${clamped.left}px`;
    this.panel.style.top = `${clamped.top}px`;
    this.panel.style.width = `${clamped.width}px`;
    this.panel.style.height = `${clamped.height}px`;
    this.panel.style.maxWidth = 'none';
    this.panel.style.maxHeight = 'none';
    this.panel.style.margin = '0';
    return clamped;
  },

  clearInlineLayout() {
    if (!this.panel) return;
    this.panel.classList.remove('viewer-panel-custom');
    this.viewer?.classList.remove('viewer-layout-custom');
    this.panel.style.position = '';
    this.panel.style.left = '';
    this.panel.style.top = '';
    this.panel.style.width = '';
    this.panel.style.height = '';
    this.panel.style.maxWidth = '';
    this.panel.style.maxHeight = '';
    this.panel.style.margin = '';
  },

  resetLayout() {
    this.clearInlineLayout();
    try { localStorage.removeItem(this.STORAGE_KEY); } catch { /* ignore */ }
  },

  onViewerOpen() {
    if (!this.boundDocMove) this.init();
    if (!this.panel) this.init();
    if (!this.panel || !this.boundDocMove) return;
    this.viewer?.classList.add('viewer-resize-enabled');
    if (!this.listenersAttached) {
      document.addEventListener('mousemove', this.boundDocMove);
      document.addEventListener('mousedown', this.boundDocDown);
      this.listenersAttached = true;
    }

    const saved = this.read();
    if (saved?.userSized) {
      this.apply(saved);
    } else {
      this.clearInlineLayout();
    }
  },

  onViewerClose() {
    this.viewer?.classList.remove('viewer-resize-enabled');
    if (this.listenersAttached) {
      document.removeEventListener('mousemove', this.boundDocMove);
      document.removeEventListener('mousedown', this.boundDocDown);
      this.listenersAttached = false;
    }
    this.clearCursor();
  },

  applySaved() {
    const saved = this.read();
    if (saved?.userSized) this.apply(saved);
  },

  onWindowResize() {
    if (!this.isUserSized() || !this.panel?.classList.contains('viewer-panel-custom')) return;
    const next = this.apply(this.read());
    if (next) this.save(next);
  },

  isViewerOpen() {
    return this.viewer && !this.viewer.classList.contains('hidden');
  },

  hitTest(e) {
    if (!this.panel) return null;
    const panelRect = this.panel.getBoundingClientRect();
    const edge = this.EDGE_PX;
    const x = e.clientX;
    const y = e.clientY;

    if (x < panelRect.left - 2 || x > panelRect.right + 2 || y < panelRect.top || y > panelRect.bottom + 2) {
      return null;
    }

    const nearRight = x >= panelRect.right - edge;
    let nearBottom = y >= panelRect.bottom - edge;

    const playerWrap = this.panel.querySelector('.viewer-player-wrap:not(.hidden)');
    if (playerWrap) {
      const playerRect = playerWrap.getBoundingClientRect();
      if (y >= playerRect.bottom - 10 && y <= playerRect.bottom + 8
        && x >= playerRect.left && x <= playerRect.right) {
        nearBottom = true;
      }
    }

    const mainColumn = this.panel.querySelector('.viewer-main-column');
    if (!nearBottom && mainColumn) {
      const mainRect = mainColumn.getBoundingClientRect();
      if (y >= mainRect.bottom - edge && y <= mainRect.bottom + 4
        && x >= mainRect.left && x <= mainRect.right) {
        nearBottom = true;
      }
    }

    if (nearRight && nearBottom) return 'se';
    if (nearRight) return 'e';
    if (nearBottom) return 's';
    return null;
  },

  cursorForAxis(axis) {
    if (axis === 'e') return 'ew-resize';
    if (axis === 's') return 'ns-resize';
    if (axis === 'se') return 'nwse-resize';
    return '';
  },

  setCursor(axis) {
    document.body.classList.remove('viewer-cursor-ew', 'viewer-cursor-ns', 'viewer-cursor-nwse');
    if (axis === 'e') document.body.classList.add('viewer-cursor-ew');
    else if (axis === 's') document.body.classList.add('viewer-cursor-ns');
    else if (axis === 'se') document.body.classList.add('viewer-cursor-nwse');
    this.panel?.classList.toggle('viewer-panel-edge-e', axis === 'e' || axis === 'se');
    this.panel?.classList.toggle('viewer-panel-edge-s', axis === 's' || axis === 'se');
    this.panel?.classList.toggle('viewer-panel-edge-se', axis === 'se');
  },

  clearCursor() {
    if (this.activeAxis) return;
    document.body.classList.remove('viewer-cursor-ew', 'viewer-cursor-ns', 'viewer-cursor-nwse');
    this.panel?.classList.remove('viewer-panel-edge-e', 'viewer-panel-edge-s', 'viewer-panel-edge-se');
  },

  onDocumentMove(e) {
    if (!this.isViewerOpen() || this.activeAxis) return;
    const axis = this.hitTest(e);
    if (axis) this.setCursor(axis);
    else this.clearCursor();
  },

  onDocumentDown(e) {
    if (!this.isViewerOpen() || e.button !== 0 || this.activeAxis) return;
    const axis = this.hitTest(e);
    if (!axis) return;

    e.preventDefault();
    e.stopPropagation();
    this.startResize(e, axis);
  },

  startResize(e, axis) {
    let layout = this.read()?.userSized ? this.read() : this.captureCurrent();
    layout = this.apply(layout);

    const startX = e.clientX;
    const startY = e.clientY;
    const startW = layout.width;
    const startH = layout.height;
    const startL = layout.left;
    const startT = layout.top;

    this.activeAxis = axis;
    this.panel.classList.add('viewer-panel-resizing');
    document.body.classList.add('viewer-panel-resizing-active');
    document.body.dataset.viewerResizeAxis = axis;
    this.setCursor(axis);

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      let width = startW;
      let height = startH;
      if (axis === 'e' || axis === 'se') width = startW + dx;
      if (axis === 's' || axis === 'se') height = startH + dy;
      this.apply({
        width,
        height,
        left: startL,
        top: startT,
        userSized: true,
      });
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      this.activeAxis = null;
      this.panel.classList.remove('viewer-panel-resizing');
      document.body.classList.remove('viewer-panel-resizing-active');
      delete document.body.dataset.viewerResizeAxis;
      this.clearCursor();
      const finalLayout = this.captureCurrent();
      this.save(finalLayout);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  },
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => ViewerPanelLayout.init());
} else {
  ViewerPanelLayout.init();
}
