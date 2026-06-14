/**
 * Window-style resize for the media viewer — fixed overlay strips track the panel edges.
 */
const ViewerPanelLayout = {
  STORAGE_KEY: 'vault-viewer-panel-layout',
  STRIP: 10,
  CORNER: 16,
  GAP: 3,
  viewer: null,
  panel: null,
  overlays: null,
  syncFrame: null,
  activeAxis: null,
  _reflowFrame: null,

  handleOutset() {
    return this.stripSize() + this.GAP;
  },

  isCoarsePointer() {
    return window.matchMedia('(pointer: coarse)').matches || window.innerWidth <= 768;
  },

  stripSize() {
    return this.isCoarsePointer() ? 18 : this.STRIP;
  },

  cornerSize() {
    return this.isCoarsePointer() ? 22 : this.CORNER;
  },

  minWidth() {
    return this.isCoarsePointer() ? 200 : 260;
  },

  minHeight() {
    return this.isCoarsePointer() ? 140 : 180;
  },

  getViewport() {
    const vv = window.visualViewport;
    return {
      width: vv?.width ?? window.innerWidth,
      height: vv?.height ?? window.innerHeight,
      offsetLeft: vv?.offsetLeft ?? 0,
      offsetTop: vv?.offsetTop ?? 0,
    };
  },

  getBounds() {
    const vp = this.getViewport();
    const margin = this.isCoarsePointer() ? 2 : 4;
    return {
      vp,
      margin,
      outset: this.handleOutset(),
      minW: this.minWidth(),
      minH: this.minHeight(),
      vw: vp.width,
      vh: vp.height,
      offsetLeft: vp.offsetLeft,
      offsetTop: vp.offsetTop,
    };
  },

  init() {
    this.viewer = document.getElementById('media-viewer');
    this.panel = this.viewer?.querySelector('.viewer-panel');
    if (!this.panel) return;
    this.ensureOverlays();
    window.addEventListener('resize', () => {
      this.syncOverlays();
      this.onWindowResize();
    });
    window.visualViewport?.addEventListener('resize', () => {
      this.syncOverlays();
      this.onWindowResize();
    });
  },

  ensureOverlays() {
    document.querySelectorAll('.viewer-resize-overlay-ps').forEach((el) => el.remove());
    if (this.overlays) return;
    const axes = [
      { id: 'e', cursor: 'ew-resize', title: 'Resize width' },
      { id: 's', cursor: 'ns-resize', title: 'Resize height' },
      { id: 'se', cursor: 'nwse-resize', title: 'Resize · double-click to reset' },
    ];
    this.overlays = {};
    for (const { id, cursor, title } of axes) {
      const el = document.createElement('div');
      el.className = `viewer-resize-overlay viewer-resize-overlay-${id}`;
      el.style.cursor = cursor;
      el.title = title;
      el.dataset.axis = id === 'se' ? 'se' : id;
      el.addEventListener('pointerdown', (e) => this.onOverlayPointerDown(e, el.dataset.axis));
      if (id === 'se') {
        el.addEventListener('dblclick', (e) => {
          e.preventDefault();
          e.stopPropagation();
          this.resetToDefault();
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
    const { margin, outset, minW, minH, vw, vh, offsetLeft, offsetTop } = this.getBounds();
    const viewRight = offsetLeft + vw;
    const viewBottom = offsetTop + vh;

    let width = Math.max(minW, layout.width || minW);
    let height = Math.max(minH, layout.height || minH);
    let left = layout.left ?? Math.round(offsetLeft + (vw - width) / 2);
    let top = layout.top ?? Math.round(offsetTop + (vh - height) / 2);

    const maxW = Math.max(minW, viewRight - left - margin - outset);
    const maxH = Math.max(minH, viewBottom - top - margin - outset);
    width = Math.min(width, maxW);
    height = Math.min(height, maxH);

    left = Math.min(Math.max(offsetLeft + margin, left), viewRight - width - margin - outset);
    top = Math.min(Math.max(offsetTop + margin, top), viewBottom - height - margin - outset);

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

  scheduleReflow() {
    if (this._reflowFrame) return;
    this._reflowFrame = requestAnimationFrame(() => {
      this._reflowFrame = null;
      window.dispatchEvent(new Event('resize'));
    });
  },

  apply(layout, { reflow = false } = {}) {
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
    if (reflow) this.scheduleReflow();
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
    try { localStorage.removeItem(this.STORAGE_KEY); } catch { /* ignore */ }
    this.clearInlineLayout();
  },

  resetToDefault() {
    this._resetting = true;
    this.resetLayout();
    const video = document.getElementById('viewer-video');
    if (typeof Viewer !== 'undefined' && Viewer.currentMediaType === 'video' && video?.videoWidth) {
      Viewer.fitModalToVideo(video);
    }
    requestAnimationFrame(() => {
      this._resetting = false;
      this.syncOverlays();
    });
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
    el.style.pointerEvents = 'auto';
  },

  syncOverlays() {
    if (!this.overlays || !this.panel) return;
    if (!this.isViewerOpen()) {
      this.hideOverlays();
      return;
    }

    const r = this.panel.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return;

    const strip = this.stripSize();
    const corner = this.cornerSize();
    const gap = this.GAP;

    this.placeOverlay(this.overlays.e, r.right + gap, r.top, strip, r.height);
    this.placeOverlay(this.overlays.s, r.left, r.bottom + gap, r.width, strip);
    this.placeOverlay(this.overlays.se, r.right + gap, r.bottom + gap, corner, corner);
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
      this.apply(saved, { reflow: true });
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
    if (saved?.userSized) this.apply(saved, { reflow: true });
    else this.syncOverlays();
  },

  onWindowResize() {
    if (this.activeAxis) return;
    if (!this.isUserSized() || !this.panel?.classList.contains('viewer-panel-custom')) return;
    const next = this.apply(this.read(), { reflow: true });
    if (next) this.save(next);
  },

  onOverlayPointerDown(e, axis) {
    if (this._resetting) return;
    if (axis === 'se' && e.detail >= 2) {
      e.preventDefault();
      e.stopPropagation();
      this.resetToDefault();
      return;
    }
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const target = e.currentTarget;
    target.setPointerCapture(e.pointerId);

    this.activeAxis = axis;
    this.panel.classList.add('viewer-panel-resizing');
    document.body.classList.add('viewer-panel-resizing-active');
    document.body.dataset.viewerResizeAxis = axis;

    let layout = this.read()?.userSized ? this.read() : this.captureCurrent();
    layout = this.apply(layout);

    const startX = e.clientX;
    const startY = e.clientY;
    const startW = layout.width;
    const startH = layout.height;
    const startL = layout.left;
    const startT = layout.top;
    const resizeAxis = axis;

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
      this.scheduleReflow();
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
