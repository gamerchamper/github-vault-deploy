/**
 * Lightweight PDF.js wrapper for embedded preview.
 */
const PdfViewer = {
  libUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  workerUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  loadPromise: null,
  instances: new Map(),

  async ensureLib() {
    if (typeof pdfjsLib !== 'undefined') {
      pdfjsLib.GlobalWorkerOptions.workerSrc = this.workerUrl;
      return pdfjsLib;
    }
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = this.libUrl;
      s.onload = () => {
        if (typeof pdfjsLib !== 'undefined') {
          pdfjsLib.GlobalWorkerOptions.workerSrc = this.workerUrl;
          resolve(pdfjsLib);
        } else reject(new Error('PDF.js failed to load'));
      };
      s.onerror = () => reject(new Error('PDF.js failed to load'));
      document.head.appendChild(s);
    });
    return this.loadPromise;
  },

  async mount(container, url, { credentials = 'same-origin', compact = false } = {}) {
    if (!container) return null;
    const id = container.id || `pdf-${Date.now()}`;
    this.destroy(id);

    const wrap = document.createElement('div');
    wrap.className = compact ? 'pdf-viewer-wrap pdf-viewer-compact' : 'pdf-viewer-wrap';
    wrap.innerHTML = `
      <div class="pdf-toolbar">
        <button type="button" class="btn-secondary pdf-prev" title="Previous page">◀</button>
        <button type="button" class="btn-secondary pdf-next" title="Next page">▶</button>
        <button type="button" class="btn-secondary pdf-zoom-out" title="Zoom out">−</button>
        <button type="button" class="btn-secondary pdf-zoom-in" title="Zoom in">+</button>
        <input type="text" class="pdf-search-input form-input" placeholder="Search…" aria-label="Search PDF">
        <span class="pdf-page-info">—</span>
      </div>
      <div class="pdf-canvas-container vault-scroll"></div>
    `;
    container.replaceChildren(wrap);

    const canvasWrap = wrap.querySelector('.pdf-canvas-container');
    const pageInfo = wrap.querySelector('.pdf-page-info');
    const state = { pdf: null, page: 1, scale: compact ? 0.85 : 1.2, rendering: false, id };

    try {
      const pdfjs = await this.ensureLib();
      const loadingTask = pdfjs.getDocument({ url, withCredentials: credentials === 'same-origin' });
      state.pdf = await loadingTask.promise;
      state.page = 1;
      pageInfo.textContent = `1 / ${state.pdf.numPages}`;

      const renderPage = async () => {
        if (state.rendering) return;
        state.rendering = true;
        const pg = await state.pdf.getPage(state.page);
        const viewport = pg.getViewport({ scale: state.scale });
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        canvas.height = viewport.height;
        canvas.width = viewport.width;
        canvasWrap.replaceChildren(canvas);
        await pg.render({ canvasContext: ctx, viewport }).promise;
        pageInfo.textContent = `${state.page} / ${state.pdf.numPages}`;
        state.rendering = false;
      };

      wrap.querySelector('.pdf-prev').onclick = () => {
        if (state.page > 1) { state.page--; renderPage(); }
      };
      wrap.querySelector('.pdf-next').onclick = () => {
        if (state.page < state.pdf.numPages) { state.page++; renderPage(); }
      };
      wrap.querySelector('.pdf-zoom-in').onclick = () => {
        state.scale = Math.min(3, state.scale + 0.2);
        renderPage();
      };
      wrap.querySelector('.pdf-zoom-out').onclick = () => {
        state.scale = Math.max(0.5, state.scale - 0.2);
        renderPage();
      };

      const searchInput = wrap.querySelector('.pdf-search-input');
      searchInput?.addEventListener('keydown', async (e) => {
        if (e.key !== 'Enter') return;
        const q = searchInput.value.trim().toLowerCase();
        if (!q) return;
        for (let p = 1; p <= state.pdf.numPages; p++) {
          const pg = await state.pdf.getPage(p);
          const content = await pg.getTextContent();
          const text = content.items.map((i) => i.str).join(' ').toLowerCase();
          if (text.includes(q)) {
            state.page = p;
            await renderPage();
            return;
          }
        }
      });

      await renderPage();
      this.instances.set(id, state);
      return state;
    } catch (err) {
      canvasWrap.innerHTML = `<p class="share-no-preview">PDF preview unavailable — ${err.message || 'use Download'}</p>`;
      return null;
    }
  },

  destroy(id) {
    const state = this.instances.get(id);
    if (state?.pdf?.destroy) state.pdf.destroy().catch(() => {});
    this.instances.delete(id);
  },
};
