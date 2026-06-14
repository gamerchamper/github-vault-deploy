/**
 * Resizable share cinema stage (public share / playlist share pages).
 */
const ShareStageLayout = {
  STORAGE_KEY: 'vault-share-stage-layout',
  STRIP: 10,
  CORNER: 16,
  GAP: 3,
  STACK_HYSTERESIS: 48,
  GRID_MIN_WIDTH: 720,
  panel: null,
  overlays: null,
  syncFrame: null,
  activeAxis: null,
  activePointerId: null,
  _reflowFrame: null,
  _stackMode: false,
  _stackColumn: false,

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

  isResizing() {
    return !!this.activeAxis;
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

  getRailWidth() {
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--share-right-rail-width');
    const parsed = parseFloat(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 360;
  },

  isRailOpen() {
    const rail = document.getElementById('share-right-rail');
    return !!(
      rail?.classList.contains('share-right-rail-open')
      || document.body.classList.contains('share-shoutbox-open')
      || document.body.classList.contains('share-playlist-active')
    );
  },

  getAppFrameWidth() {
    return document.getElementById('share-app-frame')?.clientWidth
      ?? this.getViewport().width;
  },

  getSideBySideMaxStageWidth() {
    const minW = this.minWidth();
    const layout = this.panel?.parentElement;
    const railW = this.isRailOpen() ? this.getRailWidth() : 0;
    const margin = 8;

    // When stacked, measure the old side-by-side limit (not the expanded full-width column).
    if (document.body.classList.contains('share-rail-stack') && railW > 0) {
      return Math.max(minW, this.getAppFrameWidth() - railW - margin);
    }

    if (layout?.clientWidth > 0) {
      return Math.max(minW, layout.clientWidth);
    }

    if (railW > 0) {
      return Math.max(minW, this.getAppFrameWidth() - railW - margin);
    }

    return Math.max(minW, this.getAppFrameWidth() - margin);
  },

  shouldStackRail(stageWidth, layout = null) {
    if (!this.panel?.classList.contains('share-stage-user-sized')) return false;
    if (!this.isRailOpen()) return false;

    const maxSideBySideStage = this.getSideBySideMaxStageWidth();
    const widthSized = layout?.widthSized ?? this.read()?.widthSized;

    if (this._stackMode) {
      return stageWidth > maxSideBySideStage - this.STACK_HYSTERESIS;
    }

    // Vertical-only resize keeps the stage at column width — don't stack unless widened horizontally.
    if (!widthSized && stageWidth <= maxSideBySideStage + 1) return false;
    return stageWidth > maxSideBySideStage;
  },

  shouldStackRailColumn(stageWidth) {
    if (!this._stackMode) return false;

    const hasPlaylist = document.body.classList.contains('share-playlist-active');
    const hasShoutbox = document.body.classList.contains('share-shoutbox-open');
    if (!hasPlaylist || !hasShoutbox) return true;

    const frameW = this.getAppFrameWidth();
    const gridLimit = this.GRID_MIN_WIDTH;

    if (this._stackColumn) {
      return frameW < gridLimit + this.STACK_HYSTERESIS;
    }
    return frameW < gridLimit;
  },

  init() {
    this.panel = document.getElementById('share-cinema-stage');
    if (!this.panel) return;
    this.ensureOverlays();
    this.initStageControls();
    window.addEventListener('resize', () => {
      this.syncOverlays();
      this.onWindowResize();
    });
    window.visualViewport?.addEventListener('resize', () => {
      this.syncOverlays();
      this.onWindowResize();
    });
  },

  initStageControls() {
    if (this._controlsBound) return;
    document.getElementById('share-stage-theater')?.addEventListener('click', (ev) => {
      ev.preventDefault();
      this.applyTheaterMode();
    });
    document.getElementById('share-stage-reset')?.addEventListener('click', (ev) => {
      ev.preventDefault();
      this.resetToDefault();
    });
    this._controlsBound = true;
  },

  isTheaterWidth(width = this.panel?.getBoundingClientRect().width ?? 0) {
    if (!this.panel?.classList.contains('share-stage-user-sized')) return false;
    const max = this.getSideBySideMaxStageWidth();
    return Math.abs(width - max) <= 2;
  },

  applyTheaterMode({ persist = true } = {}) {
    if (!this.panel || !this.isActive()) return null;

    const rect = this.panel.getBoundingClientRect();
    const saved = this.read();
    const parent = this.panel.parentElement?.getBoundingClientRect();
    const { margin } = this.getBounds();
    const width = this.getSideBySideMaxStageWidth();
    const height = saved?.height || rect.height;
    const top = saved?.top ?? rect.top;
    const left = parent
      ? parent.left + margin
      : (saved?.left ?? rect.left);

    const layout = this.apply({
      width,
      height,
      left,
      top,
      userSized: true,
      widthSized: false,
      heightSized: saved?.heightSized ?? false,
      theaterMode: true,
    }, { reflow: true });

    if (layout && persist) this.save(layout);
    this.updateStageControls();
    return layout;
  },

  hasResizableMedia() {
    return !!document.querySelector('#share-viewer video, #share-viewer audio, #share-viewer .share-video-el');
  },

  isCustomSized() {
    return !!(
      this.isUserSized()
      || this.panel?.classList.contains('share-stage-user-sized')
      || this.panel?.style.width
    );
  },

  updateStageControls() {
    const wrap = document.getElementById('share-stage-controls');
    const resetBtn = document.getElementById('share-stage-reset');
    const theaterBtn = document.getElementById('share-stage-theater');
    if (!wrap) return;
    const show = this.isActive() && this.hasResizableMedia();
    wrap.classList.toggle('hidden', !show);
    const theaterActive = this.isTheaterWidth() || !!this.read()?.theaterMode;
    if (theaterBtn) {
      theaterBtn.disabled = theaterActive;
      theaterBtn.classList.toggle('is-active', theaterActive);
    }
    if (resetBtn) resetBtn.disabled = !this.isCustomSized();
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
      el.addEventListener('pointerdown', (ev) => this.onOverlayPointerDown(ev, el.dataset.axis));
      if (id === 'se') {
        el.addEventListener('dblclick', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
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

    let maxW = Math.max(minW, viewRight - offsetLeft - margin * 2 - outset);
    if (this.isRailOpen() && layout.userSized !== false && !this.shouldStackRail(width, layout)) {
      maxW = Math.min(maxW, this.getSideBySideMaxStageWidth());
    }
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
      widthSized: layout.widthSized ?? this.read()?.widthSized ?? false,
      heightSized: layout.heightSized ?? this.read()?.heightSized ?? false,
      theaterMode: layout.theaterMode ?? this.read()?.theaterMode ?? false,
    };
  },

  clearRailLayoutClasses() {
    document.body.classList.remove('share-rail-stack', 'share-rail-stack-grid', 'share-rail-stack-column');
    this._stackMode = false;
    this._stackColumn = false;
  },

  updateLayoutMode(clamped) {
    const width = clamped?.width ?? this.panel?.getBoundingClientRect().width ?? 0;
    const userSized = this.panel?.classList.contains('share-stage-user-sized');

    if (!userSized) {
      this.clearRailLayoutClasses();
      document.documentElement.style.removeProperty('--share-user-stage-width');
      return;
    }

    this._stackMode = this.shouldStackRail(width, clamped);
    this._stackColumn = this.shouldStackRailColumn(width);

    document.body.classList.toggle('share-rail-stack', this._stackMode);
    document.body.classList.toggle('share-rail-stack-grid', this._stackMode && !this._stackColumn);
    document.body.classList.toggle('share-rail-stack-column', this._stackMode && this._stackColumn);

    if (width > 0) {
      document.documentElement.style.setProperty('--share-user-stage-width', `${Math.round(width)}px`);
    } else {
      document.documentElement.style.removeProperty('--share-user-stage-width');
    }
  },

  syncLayoutMode() {
    if (!this.isActive() || !this.panel?.classList.contains('share-stage-user-sized')) {
      this.clearRailLayoutClasses();
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
    if (this._reflowFrame || this.activeAxis) return;
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
    this.clearRailLayoutClasses();
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

  cancelDragState() {
    this.activeAxis = null;
    this.activePointerId = null;
    this.panel?.classList.remove('share-stage-resizing');
    document.body.classList.remove('share-stage-resizing-active');
    delete document.body.dataset.shareResizeAxis;
    if (this.overlays) {
      for (const el of Object.values(this.overlays)) {
        el.style.pointerEvents = 'auto';
      }
    }
  },

  resetToDefault() {
    this._resetting = true;
    this.cancelDragState();
    this.resetLayout();
    this.clearRailLayoutClasses();
    document.documentElement.style.removeProperty('--share-user-stage-width');

    if (typeof ShareViewer !== 'undefined') {
      ShareViewer.refitCinemaStage({ force: true });
    }

    requestAnimationFrame(() => {
      this._resetting = false;
      this.syncOverlays();
      this.updateStageControls();
    });
  },

  isActive() {
    const fileView = document.getElementById('share-file-view');
    return document.body.classList.contains('share-cinema-active')
      && fileView && !fileView.classList.contains('hidden');
  },

  hideOverlays() {
    if (!this.overlays) return;
    for (const el of Object.values(this.overlays)) {
      el.style.display = 'none';
      el.style.pointerEvents = 'none';
    }
  },

  placeOverlay(el, left, top, width, height) {
    el.style.display = 'block';
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    el.style.width = `${Math.max(1, Math.round(width))}px`;
    el.style.height = `${Math.max(1, Math.round(height))}px`;
    el.style.pointerEvents = this.activeAxis ? 'none' : 'auto';
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

    const e = this.overlays.e;
    const s = this.overlays.s;
    const se = this.overlays.se;

    e.style.pointerEvents = 'auto';
    s.style.pointerEvents = 'auto';
    se.style.pointerEvents = 'auto';

    this.placeOverlay(e, r.right + gap, r.top, strip, r.height);
    this.placeOverlay(s, r.left, r.bottom + gap, r.width, strip);
    this.placeOverlay(se, r.right + gap, r.bottom + gap, corner, corner);
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
      if (saved.theaterMode) this.applyTheaterMode();
      else this.apply(saved, { reflow: true });
    } else {
      this.clearInlineLayout();
    }

    this.startSyncLoop();
    this.updateStageControls();
  },

  onClose() {
    this.stopSyncLoop();
    this.hideOverlays();
    this.cancelDragState();
    this.updateStageControls();
  },

  applySaved() {
    if (this.isResizing()) return;
    const saved = this.read();
    if (saved?.userSized) {
      if (saved.theaterMode) this.applyTheaterMode();
      else this.apply(saved, { reflow: true });
    } else this.syncOverlays();
  },

  onWindowResize() {
    if (this.activeAxis) return;
    if (!this.isUserSized() || !this.panel?.classList.contains('share-stage-user-sized')) return;
    const saved = this.read();
    if (saved?.theaterMode) {
      this.applyTheaterMode();
      return;
    }
    const next = this.apply(saved, { reflow: true });
    if (next) this.save(next);
  },

  finishDrag(pointerId) {
    if (this.activePointerId != null && pointerId != null && this.activePointerId !== pointerId) return;

    this.cancelDragState();

    const finalLayout = this.captureCurrent();
    if (finalLayout.widthSized || !this.isTheaterWidth(finalLayout.width)) {
      finalLayout.theaterMode = false;
    } else if (this.read()?.theaterMode) {
      finalLayout.theaterMode = true;
    }
    this.save(finalLayout);
    this.syncOverlays();
    this.updateLayoutMode(finalLayout);
    this.updateStageControls();
    this.scheduleReflow();
  },

  onOverlayPointerDown(e, axis) {
    if (this._resetting || this.activeAxis) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const pointerId = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragStarted = false;
    let startW = 0;
    let startH = 0;
    let startL = 0;
    let startT = 0;

    const beginDrag = () => {
      if (dragStarted) return;
      dragStarted = true;
      const saved = this.read();
      let layout = saved?.userSized ? { ...saved } : this.captureCurrent();
      if (!saved?.userSized && (axis === 's' || axis === 'e' || axis === 'se')) {
        layout.widthSized = axis === 'e' || axis === 'se';
        layout.heightSized = axis === 's' || axis === 'se';
      }
      layout = this.apply(layout);
      startW = layout.width;
      startH = layout.height;
      startL = layout.left;
      startT = layout.top;

      this.activeAxis = axis;
      this.activePointerId = pointerId;
      this.panel.classList.add('share-stage-resizing');
      document.body.classList.add('share-stage-resizing-active');
      document.body.dataset.shareResizeAxis = axis;
    };

    const cleanup = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      window.removeEventListener('blur', onBlur);
    };

    const onMove = (ev) => {
      if (ev.pointerId !== pointerId) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!dragStarted) {
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        ev.preventDefault();
        beginDrag();
      } else {
        ev.preventDefault();
      }
      if (!dragStarted) return;
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
        widthSized: axis === 'e' || axis === 'se' || this.read()?.widthSized,
        heightSized: axis === 's' || axis === 'se' || this.read()?.heightSized,
      });
    };

    const onUp = (ev) => {
      if (ev.pointerId !== pointerId) return;
      cleanup();
      if (dragStarted) this.finishDrag(pointerId);
    };

    const onBlur = () => {
      cleanup();
      if (dragStarted) this.finishDrag(pointerId);
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    window.addEventListener('blur', onBlur);
  },
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => ShareStageLayout.init());
} else {
  ShareStageLayout.init();
}
