const ShareStreamLog = Object.assign(globalThis.ShareStreamLog || {}, {
  MAX: 600,
  entries: [],
  enabled: false,
  panel: null,
  listEl: null,

  init() {
    const qs = new URLSearchParams(location.search);
    const href = location.href;
    const stored = localStorage.getItem('shareStreamLog');
    this.enabled = qs.has('streamlog')
      || qs.get('streamlog') === '1'
      || /[?&]streamlog=1(?:&|$)/.test(href)
      || href.includes('streamlog=1')
      || stored === '1'
      || stored === 'true';
    if (this.enabled) this.mountPanel();
    window.addEventListener('error', (ev) => this.onWindowError(ev), true);
    window.addEventListener('unhandledrejection', (ev) => {
      this.error('promise:rejected', {
        reason: ev.reason?.message || String(ev.reason),
      });
    });
    this.info('log:init', {
      enabled: this.enabled,
      href: location.href,
      ua: navigator.userAgent.slice(0, 120),
    });
  },

  onWindowError(ev) {
    const tag = ev.target?.tagName;
    if (tag !== 'VIDEO' && tag !== 'AUDIO' && !String(ev.message || '').includes('blob:')) return;
    this.error('window:media-error', {
      message: ev.message || 'unknown',
      tag,
      src: ev.target?.src?.slice(0, 80) || null,
    });
  },

  log(level, event, data) {
    const entry = {
      id: this.entries.length + 1,
      ts: Date.now(),
      level,
      event,
      data: data ?? null,
    };
    this.entries.push(entry);
    if (this.entries.length > this.MAX) this.entries.shift();

    const prefix = `[ShareStream:${level}] ${event}`;
    if (level === 'error') console.error(prefix, data ?? '');
    else if (level === 'warn') console.warn(prefix, data ?? '');
    else console.log(prefix, data ?? '');

    if (this.enabled) this.renderEntry(entry);
  },

  debug(event, data) { this.log('debug', event, data); },
  info(event, data) { this.log('info', event, data); },
  warn(event, data) { this.log('warn', event, data); },
  error(event, data) {
    this.log('error', event, data);
    if (!this.panel) {
      this.enabled = true;
      this.mountPanel();
      this.renderEntry(this.entries[this.entries.length - 1]);
    }
  },

  fmtTs(ts) {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  },

  formatError(err) {
    if (!err) return 'Unknown error';
    if (typeof err === 'string') return err || 'Unknown error';
    const parts = [err.message, err.name, err.code].filter(Boolean);
    if (parts.length) return parts.join(' — ');
    return String(err) || 'Unknown error';
  },

  streamSnapshot() {
    const s = typeof ShareClientStream !== 'undefined' ? ShareClientStream : null;
    if (!s) return { error: 'ShareClientStream missing' };
    return {
      token: s.token ? `${s.token.slice(0, 8)}…` : null,
      fileId: s.fileId,
      completed: s.completed,
      total: s.manifest?.chunks?.length ?? 0,
      cacheHit: s.cacheHit,
      offline: s.offline,
      pool: !!s.pool,
      abort: !!s.abortController && !s.abortController.signal.aborted,
      streamProtected: !!s._streamProtected,
      stream: s.stream ? {
        appendIndex: s.stream.appendIndex,
        fetchHorizon: s.stream.fetchHorizon,
        startedPlay: s.stream.startedPlay,
        error: s.stream.error?.message || null,
        mseUrl: s.stream.mseUrl?.slice(0, 64) || null,
        mediaSrc: s.stream.mediaEl?.src?.slice(0, 64) || null,
        inFlight: s.stream.inFlight?.size ?? 0,
      } : null,
      blobUrl: s.blobUrl?.slice(0, 64) || null,
    };
  },

  exportText() {
    const header = `# Share stream log ${new Date().toISOString()}\n# snapshot: ${JSON.stringify(this.streamSnapshot())}\n\n`;
    return header + this.entries.map((e) => {
      const data = e.data ? ` ${JSON.stringify(e.data)}` : '';
      return `${this.fmtTs(e.ts)} [${e.level}] ${e.event}${data}`;
    }).join('\n');
  },

  mountPanel() {
    if (this.panel) return;
    const panel = document.createElement('div');
    panel.id = 'share-stream-log';
    panel.className = 'share-stream-log';
    panel.innerHTML = `
      <div class="share-stream-log-header">
        <strong>Stream log</strong>
        <span class="share-stream-log-hint">?streamlog=1</span>
        <div class="share-stream-log-actions">
          <button type="button" data-log-action="snapshot">Snapshot</button>
          <button type="button" data-log-action="copy">Copy</button>
          <button type="button" data-log-action="clear">Clear</button>
          <button type="button" data-log-action="hide">Hide</button>
        </div>
      </div>
      <pre class="share-stream-log-list" aria-live="polite"></pre>
    `;
    document.body.appendChild(panel);
    this.panel = panel;
    this.listEl = panel.querySelector('.share-stream-log-list');
    panel.addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-log-action]');
      if (!btn) return;
      const action = btn.dataset.logAction;
      if (action === 'snapshot') this.info('manual:snapshot', this.streamSnapshot());
      if (action === 'copy') navigator.clipboard?.writeText(this.exportText());
      if (action === 'clear') {
        this.entries = [];
        if (this.listEl) this.listEl.textContent = '';
      }
      if (action === 'hide') panel.classList.add('hidden');
    });
  },

  renderEntry(entry) {
    if (!this.listEl) return;
    const line = `${this.fmtTs(entry.ts)} [${entry.level}] ${entry.event}${entry.data ? ` ${JSON.stringify(entry.data)}` : ''}\n`;
    this.listEl.textContent += line;
    this.listEl.scrollTop = this.listEl.scrollHeight;
  },
});

globalThis.ShareStreamLog = ShareStreamLog;

