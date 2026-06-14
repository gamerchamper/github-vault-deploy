/**
 * Window-style resize for the media viewer — fixed overlay strips track the panel edges.
 */
const ViewerPanelLayout = {
  STORAGE_KEY: 'vault-viewer-panel-layout',
  MIN_W: 380,
  MIN_H: 260,
  STRIP: 20,
  CORNER: 28,
  viewer: null,
  panel: null,
  overlays: null,
  syncFrame: null,
  activeAxis: null,

  init() {
    this.viewer = document.getElementById('media-viewer');
    this.panel = this.viewer?.querySelector('.viewer-panel');
    if (!this.panel) return;
    this.ensureOverlays();
    window.addEventListener('resize', () => {
      this.syncOverlays();
      this.onWindowResize();
    });
  },

  ensureOverlays() {
    if (this.overlays) return;
    const axes = [
      { id: 'e', cursor: 'ew-resize', title: 'Resize width' },
      { id: 's', cursor: 'ns-resize', title: 'Resize height' },
      { id: 'ps', cursor: 'ns-resize', title: 'Resize height' },
      { id: 'se', cursor: 'nwse-resize', title: 'Resize · double-click to reset' },
    ];
    this.overlays = {};
    for (const { id, cursor, title } of axes) {
      const el = document.createElement('div');
      el.className = `viewer-resize-overlay viewer-resize-overlay-${id}`;
      el.style.cursor = cursor;
      el.title = title;
      el.dataset.axis = id === 'ps' ? 's' : (id === 'se' ? 'se' : id);
      el.addEventListener('pointerdown', (e) => this.onOverlayPointerDown(e, el.dataset.axis));
      if (id === 'se') {
        el.addEventListener('dblclick', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.resetLayout();
          if (typeof Viewer !== 'undefined' && Viewer.currentMediaType === 'video') {
            const video = document.getElementById('viewer-video');
            if (video) Viewer.fitModalToVideo(video);
          }
          this.syncOverlays();
        });
      }
      document.body.appendChild(el);
      this.overlays[id] = el;
    }
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
    if (!this.panel || !layout) return null;
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
    this.syncOverlays();
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
    this.syncOverlays();
  },

  resetLayout() {
    this.clearInlineLayout();
    try { localStorage.removeItem(this.STORAGE_KEY); } catch { /* ignore */ }
  },

  isViewerOpen() {
    return this.viewer && !this.viewer.classList.contains('hidden');
  },

  hideOverlays() {
    if (!this.overlays) return;
    for (const el of Object.values(this.overlays)) el.style.display = 'none';
  },

  placeOverlay(el, left, top, width, height) {
    el.style.display = 'block';
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.style.width = `${Math.max(1, Math.round(width))}px`;
    el.style.height = `${Math.max(1, Math.round(height))}px`;
  },

  syncOverlays() {
    if (!this.overlays || !this.panel) return;
    if (!this.isViewerOpen()) {
      this.hideOverlays();
      return;
    }

    const r = this.panel.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return;

    const strip = this.STRIP;
    const corner = this.CORNER;

    this.placeOverlay(this.overlays.e, r.right - strip, r.top, strip, r.height);
    this.placeOverlay(this.overlays.s, r.left, r.bottom - strip, r.width, strip);
    this.placeOverlay(this.overlays.se, r.right - corner, r.bottom - corner, corner, corner);

    const playerWrap = document.getElementById('viewer-video-wrap');
    const playerVisible = playerWrap && !playerWrap.classList.contains('hidden');
    if (playerVisible) {
      const pr = playerWrap.getBoundingClientRect();
      if (pr.width > 10) {
        this.placeOverlay(this.overlays.ps, pr.left, pr.bottom - strip, pr.width, strip);
      } else {
        this.overlays.ps.style.display = 'none';
      }
    } else {
      this.overlays.ps.style.display = 'none';
    }
  },

  startSyncLoop() {
    this.stopSyncLoop();
    const tick = () => {
      if (!this.isViewerOpen()) {
        this.hideOverlays();
        this.syncFrame = null;
        return;
      }
      this.syncOverlays();
      this.syncFrame = requestAnimationFrame(tick);
    };
    this.syncFrame = requestAnimationFrame(tick);
  },

  stopSyncLoop() {
    if (this.syncFrame) {
      cancelAnimationFrame(this.syncFrame);
      this.syncFrame = null;
    }
  },

  onViewerOpen() {
    if (!this.panel) this.init();
    if (!this.panel) return;
    this.ensureOverlays();

    const saved = this.read();
    if (saved?.userSized) {
      this.apply(saved);
    } else {
      this.clearInlineLayout();
    }

    this.startSyncLoop();
  },

  onViewerClose() {
    this.stopSyncLoop();
    this.hideOverlays();
    this.activeAxis = null;
    document.body.classList.remove('viewer-panel-resizing-active');
    delete document.body.dataset.viewerResizeAxis;
  },

  applySaved() {
    const saved = this.read();
    if (saved?.userSized) this.apply(saved);
    else this.syncOverlays();
  },

  onWindowResize() {
    if (!this.isUserSized() || !this.panel?.classList.contains('viewer-panel-custom')) return;
    const next = this.apply(this.read());
    if (next) this.save(next);
  },

  onOverlayPointerDown(e, axis) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    e.preventDefault();
    e.stopPropagation();

    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);

    let layout = this.read()?.userSized ? this.read() : this.captureCurrent();
    layout = this.apply(layout);

    const startX = e.clientX;
    const startY = e.clientY;
    const startW = layout.width;
    const startH = layout.height;
    const startL = layout.left;
    const startT = layout.top;
    const resizeAxis = axis;

    this.activeAxis = resizeAxis;
    this.panel.classList.add('viewer-panel-resizing');
    document.body.classList.add('viewer-panel-resizing-active');
    document.body.dataset.viewerResizeAxis = resizeAxis;

    const onMove = (ev) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      let width = startW;
      let height = startH;
      if (resizeAxis === 'e' || resizeAxis === 'se') width = startW + dx;
      if (resizeAxis === 's' || resizeAxis === 'se') height = startH + dy;
      this.apply({
        width,
        height,
        left: startL,
        top: startT,
        userSized: true,
      });
    };

    const onUp = (ev) => {
      target.releasePointerCapture(ev.pointerId);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      this.activeAxis = null;
      this.panel.classList.remove('viewer-panel-resizing');
      document.body.classList.remove('viewer-panel-resizing-active');
      delete document.body.dataset.viewerResizeAxis;
      const finalLayout = this.captureCurrent();
      this.save(finalLayout);
      this.syncOverlays();
    };

    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  },
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => ViewerPanelLayout.init());
} else {
  ViewerPanelLayout.init();
}
