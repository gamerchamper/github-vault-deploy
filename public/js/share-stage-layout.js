/**
 * Resizable share cinema stage (public share / playlist share pages).
 */
const ShareStageLayout = {
  STORAGE_KEY: 'vault-share-stage-layout',
  STRIP: 10,
  CORNER: 16,
  GAP: 3,
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
    return this.isCoarsePointer() ? 180 : 240;
  },

  minHeight() {
    return this.isCoarsePointer() ? 120 : 160;
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
    this.panel = document.getElementById('share-cinema-stage');
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
    document.querySelectorAll('.share-resize-overlay-ps').forEach((el) => el.remove());
    if (this.overlays) return;
    const axes = [
      { id: 'e', cursor: 'ew-resize', title: 'Resize width' },
      { id: 's', cursor: 'ns-resize', title: 'Resize height' },
      { id: 'se', cursor: 'nwse-resize', title: 'Resize · double-click to reset' },
    ];
    this.overlays = {};
    for (const { id, cursor, title } of axes) {
      const el = document.createElement('div');
      el.className = `share-resize-overlay share-resize-overlay-${id}`;
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

  clampToViewport(layout) {
    if (!layout) return layout;
    const { margin, outset, minW, minH, vw, vh, offsetLeft, offsetTop } = this.getBounds();
    const viewRight = offsetLeft + vw;
    const viewBottom = offsetTop + vh;
    const parent = this.panel?.parentElement?.getBoundingClientRect();

    let width = Math.max(minW, layout.width || minW);
    let height = Math.max(minH, layout.height || minH);
    let left = layout.left ?? (parent?.left ?? offsetLeft) + margin;
    let top = layout.top ?? this.panel?.getBoundingClientRect().top ?? offsetTop + margin;

    const maxW = Math.max(minW, viewRight - offsetLeft - margin * 2 - outset);
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

  updateLayoutMode(clamped) {
    const userSized = this.panel?.classList.contains('share-stage-user-sized');
    document.body.classList.toggle('share-rail-stack', userSized);
    if (clamped?.width) {
      document.documentElement.style.setProperty('--share-user-stage-width', `${clamped.width}px`);
    } else {
      document.documentElement.style.removeProperty('--share-user-stage-width');
    }
  },

  syncLayoutMode() {
    if (!this.isActive() || !this.panel?.classList.contains('share-stage-user-sized')) {
      document.body.classList.remove('share-rail-stack');
      document.documentElement.style.removeProperty('--share-user-stage-width');
      return;
    }
    const rect = this.panel.getBoundingClientRect();
    this.updateLayoutMode({ width: rect.width });
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
    const parent = this.panel.parentElement?.getBoundingClientRect();

    this.panel.classList.add('share-stage-user-sized', 'share-stage-fitted');
    this.panel.classList.remove('share-stage-capped');
    this.panel.style.setProperty('--share-stage-height', `${clamped.height}px`);
    this.panel.style.width = `${clamped.width}px`;
    this.panel.style.height = `${clamped.height}px`;
    this.panel.style.minHeight = `${clamped.height}px`;
    this.panel.style.maxHeight = 'none';
    this.panel.style.flex = '0 0 auto';
    this.panel.style.alignSelf = 'flex-start';

    if (parent) {
      this.panel.style.marginLeft = `${Math.max(0, clamped.left - parent.left)}px`;
      this.panel.style.marginRight = 'auto';
    }

    this.syncOverlays();
    this.updateLayoutMode(clamped);
    if (reflow) this.scheduleReflow();
    return clamped;
  },

  clearInlineLayout() {
    if (!this.panel) return;
    this.panel.classList.remove('share-stage-user-sized', 'share-stage-fitted', 'share-stage-capped', 'share-stage-resizing');
    document.body.classList.remove('share-rail-stack');
    document.documentElement.style.removeProperty('--share-user-stage-width');
    this.panel.style.removeProperty('--share-stage-height');
    this.panel.style.width = '';
    this.panel.style.height = '';
    this.panel.style.minHeight = '';
    this.panel.style.maxHeight = '';
    this.panel.style.marginLeft = '';
    this.panel.style.marginRight = '';
    this.panel.style.alignSelf = '';
    this.panel.style.flex = '';
    this.syncOverlays();
  },

  resetLayout() {
    try { localStorage.removeItem(this.STORAGE_KEY); } catch { /* ignore */ }
    this.clearInlineLayout();
  },

  resetToDefault() {
    this._resetting = true;
    this.resetLayout();
    const video = document.querySelector('#share-viewer .share-video-el');
    if (typeof ShareViewer !== 'undefined') {
      if (video) ShareViewer.fitCinemaStage(video, { force: true });
      else ShareViewer.refitCinemaStage();
    }
    requestAnimationFrame(() => {
      this._resetting = false;
      this.syncOverlays();
    });
  },

  isActive() {
    const fileView = document.getElementById('share-file-view');
    return document.body.classList.contains('share-cinema-active')
      && fileView && !fileView.classList.contains('hidden');
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
    if (!this.isActive()) {
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
      if (!this.isActive()) {
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

  onOpen() {
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

  onClose() {
    this.stopSyncLoop();
    this.hideOverlays();
    this.activeAxis = null;
    document.body.classList.remove('share-stage-resizing-active');
    delete document.body.dataset.shareResizeAxis;
  },

  applySaved() {
    const saved = this.read();
    if (saved?.userSized) this.apply(saved, { reflow: true });
    else this.syncOverlays();
  },

  onWindowResize() {
    if (this.activeAxis) return;
    if (!this.isUserSized() || !this.panel?.classList.contains('share-stage-user-sized')) return;
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
    this.panel.classList.add('share-stage-resizing');
    document.body.classList.add('share-stage-resizing-active');
    document.body.dataset.shareResizeAxis = axis;

    let layout = this.read()?.userSized ? this.read() : this.captureCurrent();
    layout = this.apply(layout);

    const startX = e.clientX;
    const startY = e.clientY;
    const startW = layout.width;
    const startH = layout.height;
    const startL = layout.left;
    const startT = layout.top;

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
      target.releasePointerCapture(ev.pointerId);
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      this.activeAxis = null;
      this.panel.classList.remove('share-stage-resizing');
      document.body.classList.remove('share-stage-resizing-active');
      delete document.body.dataset.shareResizeAxis;
      const finalLayout = this.captureCurrent();
      this.save(finalLayout);
      this.syncOverlays();
      this.updateLayoutMode(finalLayout);
      this.scheduleReflow();
    };

    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  },
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => ShareStageLayout.init());
} else {
  ShareStageLayout.init();
}
