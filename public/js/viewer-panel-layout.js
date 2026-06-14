/**
 * Draggable window-style resize for the media viewer panel (right + bottom edges).
 * Persists size/position across media switches via localStorage.
 */
const ViewerPanelLayout = {
  STORAGE_KEY: 'vault-viewer-panel-layout',
  MIN_W: 380,
  MIN_H: 260,
  HANDLE_SIZE: 10,
  viewer: null,
  panel: null,
  drag: null,

  init() {
    this.viewer = document.getElementById('media-viewer');
    this.panel = this.viewer?.querySelector('.viewer-panel');
    if (!this.panel || this.panel.dataset.layoutReady) return;
    this.panel.dataset.layoutReady = '1';
    this.ensureHandles();
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
    return { ...layout, width: Math.round(width), height: Math.round(height), left: Math.round(left), top: Math.round(top), userSized: true };
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
    if (!this.panel) this.init();
    if (!this.panel) return;
    const saved = this.read();
    if (saved?.userSized) {
      this.apply(saved);
    } else {
      this.clearInlineLayout();
    }
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

  ensureHandles() {
    for (const axis of ['e', 's', 'se']) {
      const handle = document.createElement('div');
      handle.className = `viewer-resize-handle viewer-resize-${axis}`;
      handle.dataset.axis = axis;
      handle.title = axis === 'se' ? 'Drag to resize · double-click to reset' : 'Drag to resize';
      handle.addEventListener('pointerdown', (e) => this.onPointerDown(e, axis));
      handle.addEventListener('dblclick', (e) => {
        if (axis !== 'se') return;
        e.preventDefault();
        e.stopPropagation();
        this.resetLayout();
        if (typeof Viewer !== 'undefined' && Viewer.currentMediaType === 'video') {
          const video = document.getElementById('viewer-video');
          if (video) Viewer.fitModalToVideo(video);
        }
      });
      this.panel.appendChild(handle);
    }
  },

  onPointerDown(e, axis) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);

    let layout = this.read()?.userSized ? this.read() : this.captureCurrent();
    layout = this.apply(layout);

    const startX = e.clientX;
    const startY = e.clientY;
    const startW = layout.width;
    const startH = layout.height;
    const startL = layout.left;
    const startT = layout.top;

    this.panel.classList.add('viewer-panel-resizing');
    document.body.classList.add('viewer-panel-resizing-active');
    document.body.dataset.viewerResizeAxis = axis;

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

    const onUp = (ev) => {
      handle.releasePointerCapture(ev.pointerId);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
      this.panel.classList.remove('viewer-panel-resizing');
      document.body.classList.remove('viewer-panel-resizing-active');
      delete document.body.dataset.viewerResizeAxis;
      const finalLayout = this.captureCurrent();
      this.save(finalLayout);
    };

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  },
};
