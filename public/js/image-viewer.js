/**
 * Premium image viewer — zoom, pan, fit, fullscreen
 */
const ImageViewer = {
  wrap: null,
  img: null,
  toolbar: null,
  scale: 1,
  panX: 0,
  panY: 0,
  dragging: false,
  dragStart: null,
  minScale: 0.25,
  maxScale: 8,

  mount(container, imgEl) {
    this.destroy();
    this.container = container;
    this.img = imgEl;
    this.wrap = document.createElement('div');
    this.wrap.className = 'viewer-image-wrap';
    this.wrap.setAttribute('role', 'img');
    this.wrap.setAttribute('aria-label', 'Image preview');

    this.toolbar = document.createElement('div');
    this.toolbar.className = 'viewer-image-toolbar';
    this.toolbar.innerHTML = `
      <button type="button" data-zoom="out" title="Zoom out (−)">−</button>
      <button type="button" data-zoom="fit" title="Fit to screen">Fit</button>
      <button type="button" data-zoom="in" title="Zoom in (+)">+</button>
      <button type="button" data-zoom="100" title="Actual size">1:1</button>
      <button type="button" data-zoom="fullscreen" title="Fullscreen (F)">⛶</button>
    `;

    imgEl.classList.remove('hidden');
    imgEl.classList.add('viewer-image-el');
    container.appendChild(this.wrap);
    this.wrap.appendChild(imgEl);
    container.appendChild(this.toolbar);

    this.reset();
    this.bind();
  },

  bind() {
    this.toolbar?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-zoom]');
      if (!btn) return;
      const action = btn.dataset.zoom;
      if (action === 'in') this.zoomBy(1.25);
      else if (action === 'out') this.zoomBy(0.8);
      else if (action === 'fit') this.fit();
      else if (action === '100') this.actualSize();
      else if (action === 'fullscreen') this.toggleFullscreen();
    });

    this.wrap?.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      this.zoomBy(delta, e.offsetX, e.offsetY);
    }, { passive: false });

    this.wrap?.addEventListener('dblclick', (e) => {
      if (this.scale > 1.05) this.fit();
      else this.zoomBy(2, e.offsetX, e.offsetY);
    });

    this.wrap?.addEventListener('mousedown', (e) => {
      if (this.scale <= 1) return;
      this.dragging = true;
      this.dragStart = { x: e.clientX - this.panX, y: e.clientY - this.panY };
      this.wrap.classList.add('dragging');
      e.preventDefault();
    });

    document.addEventListener('mousemove', this._onMove = (e) => {
      if (!this.dragging) return;
      this.panX = e.clientX - this.dragStart.x;
      this.panY = e.clientY - this.dragStart.y;
      this.applyTransform();
    });

    document.addEventListener('mouseup', this._onUp = () => {
      this.dragging = false;
      this.wrap?.classList.remove('dragging');
    });

    this._onKey = (e) => {
      if (!this.wrap || document.getElementById('media-viewer')?.classList.contains('hidden')) return;
      if (Viewer?.currentMediaType !== 'image') return;
      if (e.key === '+' || e.key === '=') { e.preventDefault(); this.zoomBy(1.25); }
      if (e.key === '-') { e.preventDefault(); this.zoomBy(0.8); }
      if (e.key === 'f' || e.key === 'F') { e.preventDefault(); this.toggleFullscreen(); }
      if (e.key === '0') { e.preventDefault(); this.fit(); }
    };
    document.addEventListener('keydown', this._onKey);
  },

  reset() {
    this.scale = 1;
    this.panX = 0;
    this.panY = 0;
    this.applyTransform();
    this.wrap?.classList.remove('zoomed');
  },

  fit() {
    this.scale = 1;
    this.panX = 0;
    this.panY = 0;
    this.applyTransform();
    this.wrap?.classList.remove('zoomed');
  },

  actualSize() {
    this.scale = 1;
    this.panX = 0;
    this.panY = 0;
    if (this.img?.naturalWidth) {
      const wrapW = this.wrap?.clientWidth || 1;
      const ratio = this.img.naturalWidth / wrapW;
      this.scale = Math.min(this.maxScale, Math.max(1, ratio));
    }
    this.applyTransform();
    this.wrap?.classList.toggle('zoomed', this.scale > 1.05);
  },

  zoomBy(factor, originX, originY) {
    const prev = this.scale;
    this.scale = Math.min(this.maxScale, Math.max(this.minScale, this.scale * factor));
    if (originX != null && this.wrap) {
      const rect = this.wrap.getBoundingClientRect();
      const ox = originX - rect.width / 2;
      const oy = originY - rect.height / 2;
      this.panX -= ox * (this.scale / prev - 1);
      this.panY -= oy * (this.scale / prev - 1);
    }
    this.applyTransform();
    this.wrap?.classList.toggle('zoomed', this.scale > 1.05);
  },

  applyTransform() {
    if (!this.img) return;
    this.img.style.transform = `translate(${this.panX}px, ${this.panY}px) scale(${this.scale})`;
  },

  toggleFullscreen() {
    const target = this.wrap?.closest('.viewer-media-area') || this.wrap;
    if (!target) return;
    if (!document.fullscreenElement) {
      target.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.();
    }
  },

  destroy() {
    if (this._onMove) document.removeEventListener('mousemove', this._onMove);
    if (this._onUp) document.removeEventListener('mouseup', this._onUp);
    if (this._onKey) document.removeEventListener('keydown', this._onKey);
    this.toolbar?.remove();
    this.toolbar = null;
    if (this.img && this.container) {
      this.img.style.transform = '';
      this.img.classList.remove('viewer-image-el');
      this.container.appendChild(this.img);
    }
    this.wrap?.remove();
    this.wrap = null;
    this.img = null;
    this.container = null;
    this.dragging = false;
  },
};
