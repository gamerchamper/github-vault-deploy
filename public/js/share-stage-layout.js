/**
 * Resizable share cinema stage (public share / playlist share pages).
 */
const ShareStageLayout = {
  STORAGE_KEY: 'vault-share-stage-layout',
  MIN_W: 320,
  MIN_H: 200,
  STRIP: 20,
  CORNER: 28,
  panel: null,
  overlays: null,
  syncFrame: null,
  activeAxis: null,

  init() {
    this.panel = document.getElementById('share-cinema-stage');
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
      el.className = `share-resize-overlay share-resize-overlay-${id}`;
      el.style.cursor = cursor;
      el.title = title;
      el.dataset.axis = id === 'ps' ? 's' : (id === 'se' ? 'se' : id);
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

  maxHeight() {
    const topDock = document.getElementById('share-top-dock')?.offsetHeight || 0;
    const dock = document.getElementById('share-cinema-dock')?.offsetHeight || 140;
    return Math.max(this.MIN_H, window.innerHeight - topDock - Math.min(dock, 280) - 24);
  },

  clampToViewport(layout) {
    if (!layout) return layout;
    const margin = 12;
    const parent = this.panel?.parentElement?.getBoundingClientRect();
    const maxW = Math.max(this.MIN_W, (parent?.width || window.innerWidth) - margin * 2);
    const maxH = this.maxHeight();
    let width = Math.min(Math.max(this.MIN_W, layout.width || this.MIN_W), maxW);
    let height = Math.min(Math.max(this.MIN_H, layout.height || this.MIN_H), maxH);
    let left = layout.left ?? (parent ? parent.left + (parent.width - width) / 2 : margin);
    let top = layout.top ?? this.panel?.getBoundingClientRect().top ?? margin;
    if (parent) {
      left = Math.min(Math.max(parent.left + margin, left), parent.right - width - margin);
    } else {
      left = Math.min(Math.max(margin, left), window.innerWidth - width - margin);
    }
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
    const parent = this.panel.parentElement?.getBoundingClientRect();

    this.panel.classList.add('share-stage-user-sized', 'share-stage-fitted');
    this.panel.style.setProperty('--share-stage-height', `${clamped.height}px`);
    this.panel.style.width = `${clamped.width}px`;
    this.panel.style.height = `${clamped.height}px`;
    this.panel.style.minHeight = `${clamped.height}px`;
    this.panel.style.maxHeight = `${clamped.height}px`;
    this.panel.style.flex = '0 0 auto';
    this.panel.style.alignSelf = 'flex-start';

    if (parent) {
      this.panel.style.marginLeft = `${Math.max(0, clamped.left - parent.left)}px`;
      this.panel.style.marginRight = 'auto';
    }

    this.syncOverlays();
    return clamped;
  },

  clearInlineLayout() {
    if (!this.panel) return;
    this.panel.classList.remove('share-stage-user-sized', 'share-stage-fitted', 'share-stage-capped', 'share-stage-resizing');
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
  },

  syncOverlays() {
    if (!this.overlays || !this.panel) return;
    if (!this.isActive()) {
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

    const playerWrap = document.querySelector('#share-viewer .share-video-player:not(.hidden)');
    if (playerWrap) {
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
      this.apply(saved);
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
    if (saved?.userSized) this.apply(saved);
    else this.syncOverlays();
  },

  onWindowResize() {
    if (!this.isUserSized() || !this.panel?.classList.contains('share-stage-user-sized')) return;
    const next = this.apply(this.read());
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

    this.activeAxis = axis;
    this.panel.classList.add('share-stage-resizing');
    document.body.classList.add('share-stage-resizing-active');
    document.body.dataset.shareResizeAxis = axis;

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
