/** Lazy-load heavy share-page libraries (HLS, Plyr, PDF) after first paint. */
const ShareLazyLibs = {
  _promises: new Map(),

  loadScript(src) {
    if (this._promises.has(src)) return this._promises.get(src);
    const p = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error(`Failed to load ${src}`));
      document.head.appendChild(s);
    });
    this._promises.set(src, p);
    return p;
  },

  loadStylesheet(href, id) {
    if (id && document.getElementById(id)) return Promise.resolve();
    const key = id || href;
    if (this._promises.has(key)) return this._promises.get(key);
    const p = new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = href;
      if (id) link.id = id;
      link.onload = () => resolve();
      link.onerror = () => reject(new Error(`Failed to load ${href}`));
      document.head.appendChild(link);
    });
    this._promises.set(key, p);
    return p;
  },

  loadHls() {
    if (typeof Hls !== 'undefined') return Promise.resolve(window.Hls);
    return this.loadScript('/js/hls.min.js?v=1.0.0').then(() => window.Hls);
  },

  loadPlyr() {
    if (typeof Plyr !== 'undefined') return Promise.resolve(window.Plyr);
    return this.loadStylesheet('/css/plyr.css?v=1.0.0', 'share-plyr-css')
      .then(() => this.loadScript('/js/plyr.polyfilled.min.js?v=1.0.0'))
      .then(() => window.Plyr);
  },

  loadPdfViewer() {
    if (typeof PdfViewer !== 'undefined') return Promise.resolve(window.PdfViewer);
    return this.loadScript('/js/pdf-viewer.js?v=1.0.0').then(() => window.PdfViewer);
  },

  loadExplorerCss() {
    return this.loadStylesheet('/css/explorer.css?v=1.0.17', 'share-explorer-css');
  },

  loadPlaylistsCss() {
    return this.loadStylesheet('/css/playlists.css?v=1.0.2', 'share-playlists-css');
  },

  loadStreamLog() {
    if (typeof ShareStreamLog !== 'undefined') {
      ShareStreamLog.init?.();
      return Promise.resolve();
    }
    return this.loadScript('/js/share-stream-log.js?v=1.0.2').then(() => {
      ShareStreamLog?.init?.();
    });
  },

  needsStreamLog() {
    try {
      const qs = new URLSearchParams(location.search);
      const stored = localStorage.getItem('shareStreamLog');
      return qs.has('streamlog')
        || qs.get('streamlog') === '1'
        || stored === '1'
        || stored === 'true';
    } catch {
      return false;
    }
  },
};
