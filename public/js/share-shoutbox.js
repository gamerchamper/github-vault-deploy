const ShareShoutbox = {
  token: null,
  fileId: null,
  viewerId: null,
  viewerName: null,
  lastId: 0,
  pollTimer: null,
  open: false,
  sendBtnEl: null,
  inputEl: null,
  messagesEl: null,
  shoutboxEl: null,
  closeBtnEl: null,
  openBtnEl: null,
  videoEl: null,
  userScrolledUp: false,
  isAtBottom: true,
  playlistMode: false,
  viewerProfiles: new Map(),
  atLabelEl: null,
  videoTimeHandler: null,
  videoMetaHandler: null,

  PRESENCE_ADJECTIVES: [
    'Calm', 'Bright', 'Swift', 'Bold', 'Quiet', 'Lucky', 'Happy', 'Cool',
    'Keen', 'Warm', 'Neat', 'Fresh', 'Quick', 'Sunny', 'Clever', 'Gentle',
  ],
  PRESENCE_ANIMALS: [
    'Fox', 'Owl', 'Bear', 'Hawk', 'Lynx', 'Wolf', 'Dove', 'Seal',
    'Crane', 'Panda', 'Tiger', 'Koala', 'Finch', 'Otter', 'Heron', 'Moose',
  ],
  PRESENCE_COLORS: [
    '#5c6bc0', '#26a69a', '#ef5350', '#ab47bc', '#ffa726',
    '#42a5f5', '#66bb6a', '#ec407a', '#8d6e63', '#78909c',
  ],

  hashViewerId(viewerId) {
    const str = String(viewerId || '');
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h) + str.charCodeAt(i);
      h |= 0;
    }
    return Math.abs(h);
  },

  guestProfile(viewerId) {
    const h = this.hashViewerId(viewerId);
    const name = `${this.PRESENCE_ADJECTIVES[h % this.PRESENCE_ADJECTIVES.length]} ${this.PRESENCE_ANIMALS[(h >> 4) % this.PRESENCE_ANIMALS.length]}`;
    const color = this.PRESENCE_COLORS[(h >> 8) % this.PRESENCE_COLORS.length];
    return { name, color };
  },

  syncViewerProfiles(viewers) {
    if (!viewers?.length) return;
    for (const viewer of viewers) {
      this.viewerProfiles.set(viewer.id, { name: viewer.name, color: viewer.color });
    }
    const me = viewers.find((v) => v.id === this.viewerId);
    if (me?.name) this.viewerName = me.name;
  },

  viewerColor(viewerId) {
    const cached = this.viewerProfiles.get(viewerId);
    if (cached?.color) return cached.color;
    return this.guestProfile(viewerId).color;
  },

  apiBase() {
    return this.playlistMode
      ? `/api/public/playlist/${this.token}`
      : `/api/public/share/${this.token}`;
  },

  escape(str) {
    const node = document.createElement('span');
    node.textContent = str || '';
    return node.innerHTML;
  },

  setPanelAccessibility(open) {
    if (!this.shoutboxEl) return;
    const focusable = this.shoutboxEl.querySelectorAll('button, input, textarea, select, a[href]');
    if (open) {
      this.shoutboxEl.removeAttribute('inert');
      this.shoutboxEl.removeAttribute('aria-hidden');
      focusable.forEach((el) => {
        if (!Object.prototype.hasOwnProperty.call(el.dataset, 'shoutboxTabindex')) return;
        const prev = el.dataset.shoutboxTabindex;
        if (prev === '') el.removeAttribute('tabindex');
        else el.setAttribute('tabindex', prev);
        delete el.dataset.shoutboxTabindex;
      });
    } else {
      this.shoutboxEl.setAttribute('inert', '');
      this.shoutboxEl.setAttribute('aria-hidden', 'true');
      focusable.forEach((el) => {
        if (!Object.prototype.hasOwnProperty.call(el.dataset, 'shoutboxTabindex')) {
          el.dataset.shoutboxTabindex = el.getAttribute('tabindex') ?? '';
        }
        el.setAttribute('tabindex', '-1');
      });
    }
  },

  formatPosition(seconds) {
    if (seconds == null || seconds < 0) return '';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  },

  getVideoPosition() {
    if (!this.videoEl) return null;
    const currentTime = this.videoEl.currentTime;
    if (!isFinite(currentTime) || currentTime < 0) return null;
    return currentTime;
  },

  hasActiveVideo() {
    return !!this.videoEl && isFinite(this.videoEl.duration) && this.videoEl.duration > 0;
  },

  updateAtLabel() {
    if (!this.atLabelEl) return;
    if (!this.hasActiveVideo()) {
      this.atLabelEl.classList.add('hidden');
      this.atLabelEl.textContent = '';
      return;
    }
    const pos = this.getVideoPosition();
    if (pos == null) {
      this.atLabelEl.classList.add('hidden');
      this.atLabelEl.textContent = '';
      return;
    }
    this.atLabelEl.classList.remove('hidden');
    this.atLabelEl.textContent = `@ ${this.formatPosition(pos)}`;
  },

  bindVideoPositionTracking() {
    if (this.videoEl) {
      if (this.videoTimeHandler) this.videoEl.removeEventListener('timeupdate', this.videoTimeHandler);
      if (this.videoMetaHandler) {
        this.videoEl.removeEventListener('loadedmetadata', this.videoMetaHandler);
        this.videoEl.removeEventListener('durationchange', this.videoMetaHandler);
      }
    }
    this.videoEl = document.querySelector('#share-viewer .share-video-el')
      || document.querySelector('#share-viewer .share-audio-el');
    this.videoTimeHandler = () => this.updateAtLabel();
    this.videoMetaHandler = () => this.updateAtLabel();
    if (this.videoEl) {
      this.videoEl.addEventListener('timeupdate', this.videoTimeHandler);
      this.videoEl.addEventListener('loadedmetadata', this.videoMetaHandler);
      this.videoEl.addEventListener('durationchange', this.videoMetaHandler);
    }
    this.updateAtLabel();
  },

  checkScroll() {
    const el = this.messagesEl;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    this.isAtBottom = atBottom;
    if (atBottom) this.userScrolledUp = false;
  },

  scrollToBottom() {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
    this.isAtBottom = true;
    this.userScrolledUp = false;
  },

  addMessage(msg, isSelf) {
    const div = document.createElement('div');
    div.className = 'shoutbox-msg' + (isSelf ? ' shoutbox-msg-self' : '');

    const nameSpan = document.createElement('span');
    nameSpan.className = 'shoutbox-name';
    const displayName = msg.viewer_name || this.guestProfile(msg.viewer_id).name;
    nameSpan.textContent = displayName;
    if (msg.viewer_id) nameSpan.style.color = this.viewerColor(msg.viewer_id);
    div.appendChild(nameSpan);

    if (msg.position != null) {
      const posSpan = document.createElement('span');
      posSpan.className = 'shoutbox-pos';
      posSpan.textContent = `@ ${this.formatPosition(msg.position)}`;
      posSpan.title = 'Video timestamp';
      div.appendChild(posSpan);
    }

    const textSpan = document.createElement('span');
    textSpan.className = 'shoutbox-text';
    textSpan.textContent = msg.message || '';
    div.appendChild(textSpan);

    this.messagesEl.appendChild(div);
    if (isSelf || !this.userScrolledUp) {
      this.scrollToBottom();
    }
  },

  async poll() {
    try {
      const res = await fetch(`${this.apiBase()}/shoutbox?file=${encodeURIComponent(this.fileId || '')}&since=${this.lastId}`);
      if (!res.ok) return;
      const data = await res.json();
      if (!data.messages || !data.messages.length) return;
      for (const msg of data.messages) {
        const isSelf = msg.viewer_id === this.viewerId;
        this.addMessage(msg, isSelf);
        if (msg.id > this.lastId) this.lastId = msg.id;
      }
    } catch { /* ignore */ }
  },

  async sendMessage() {
    const text = this.inputEl.value.trim();
    if (!text) return;
    const position = this.hasActiveVideo() ? this.getVideoPosition() : null;
    const msg = {
      id: Date.now(),
      viewer_id: this.viewerId,
      viewer_name: this.viewerName || this.guestProfile(this.viewerId).name,
      message: text,
      position,
    };
    this.addMessage(msg, true);
    this.inputEl.value = '';
    try {
      const res = await fetch(`${this.apiBase()}/shoutbox`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file_id: this.fileId,
          viewer_id: this.viewerId,
          viewer_name: this.viewerName,
          message: text,
          position,
        }),
      });
      if (!res.ok) return;
      const data = await res.json();
      this.lastId = data.id;
    } catch { /* ignore */ }
  },

  startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => this.poll(), 4000);
  },

  stopPolling() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
  },

  openPanel({ focusInput = true } = {}) {
    const scrollY = window.scrollY;
    this.shoutboxEl.classList.remove('hidden', 'shoutbox-closed');
    this.setPanelAccessibility(true);
    this.openBtnEl.classList.add('hidden');
    document.body.classList.add('share-shoutbox-open');
    document.getElementById('share-right-rail')?.classList.add('share-right-rail-open');
    this.open = true;
    sessionStorage.setItem('shoutboxOpen', 'true');
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.shoutboxEl.classList.add('shoutbox-open');
      });
    });
    setTimeout(() => {
      if (focusInput) {
        try {
          this.inputEl?.focus({ preventScroll: true });
        } catch {
          this.inputEl?.focus();
          window.scrollTo(0, scrollY);
        }
      }
      window.scrollTo(0, scrollY);
      ShareStageLayout?.syncLayoutMode?.();
      ShareViewer?.refitCinemaStage?.();
    }, 360);
  },

  closePanel() {
    this.setPanelAccessibility(false);
    this.shoutboxEl.classList.remove('shoutbox-open');
    this.shoutboxEl.classList.add('shoutbox-closed');
    this.openBtnEl.classList.remove('hidden');
    document.body.classList.remove('share-shoutbox-open');
    this.open = false;
    sessionStorage.setItem('shoutboxOpen', 'false');
    if (!document.body.classList.contains('share-playlist-active')) {
      document.getElementById('share-right-rail')?.classList.remove('share-right-rail-open');
    }
    setTimeout(() => {
      if (!this.open) this.shoutboxEl.classList.add('hidden');
      ShareStageLayout?.syncLayoutMode?.();
      ShareViewer?.refitCinemaStage?.();
    }, 320);
  },

  updateFile(fileId) {
    this.fileId = fileId;
    this.bindVideoPositionTracking();
  },

  showOpenButton() {
    this.openBtnEl?.classList.remove('hidden');
  },

  init(token, fileId) {
    this.token = token;
    this.fileId = fileId;
    this.viewerId = SharePresence.getViewerId();
    this.viewerProfiles = new Map();
    const localProfile = this.guestProfile(this.viewerId);
    this.viewerName = localProfile.name;
    this.viewerProfiles.set(this.viewerId, localProfile);
    this.lastId = 0;
    this.userScrolledUp = false;
    this.isAtBottom = true;
    this.shoutboxEl = document.getElementById('share-shoutbox');
    this.messagesEl = document.getElementById('shoutbox-messages');
    this.inputEl = document.getElementById('shoutbox-input');
    this.sendBtnEl = document.getElementById('shoutbox-send');
    this.closeBtnEl = document.getElementById('shoutbox-close');
    this.openBtnEl = document.getElementById('shoutbox-open-btn');
    this.atLabelEl = document.getElementById('shoutbox-at');

    if (!this.shoutboxEl) return;

    this.messagesEl.innerHTML = '';
    this.inputEl.value = '';

    this.shoutboxEl.classList.add('hidden', 'shoutbox-closed');
    this.shoutboxEl.classList.remove('shoutbox-open');
    this.setPanelAccessibility(false);
    this.showOpenButton();
    document.body.classList.remove('share-shoutbox-open');

    const storedOpen = sessionStorage.getItem('shoutboxOpen') === 'true';
    const isMobile = typeof matchMedia !== 'undefined' && matchMedia('(max-width: 768px)').matches;
    if (storedOpen && !isMobile) this.openPanel({ focusInput: true });

    this.messagesEl.addEventListener('scroll', () => ShareShoutbox.checkScroll());

    if (!this.playlistMode) {
      fetch(`/api/public/share/${token}/presence`)
        .then(r => r.ok ? r.json() : null)
        .then(data => this.syncViewerProfiles(data?.viewers))
        .catch(() => {});
    }

    this.bindVideoPositionTracking();
    this.poll();
    this.startPolling();
  },

  destroy() {
    this.stopPolling();
    if (this.videoEl) {
      if (this.videoTimeHandler) this.videoEl.removeEventListener('timeupdate', this.videoTimeHandler);
      if (this.videoMetaHandler) {
        this.videoEl.removeEventListener('loadedmetadata', this.videoMetaHandler);
        this.videoEl.removeEventListener('durationchange', this.videoMetaHandler);
      }
    }
    this.videoTimeHandler = null;
    this.videoMetaHandler = null;
    this.videoEl = null;
    this.viewerProfiles = new Map();
    this.token = null;
    this.fileId = null;
    this.lastId = 0;
    const el = document.getElementById('share-shoutbox');
    if (el) {
      el.classList.add('hidden');
      el.classList.remove('shoutbox-open', 'shoutbox-closed');
      el.setAttribute('inert', '');
      el.setAttribute('aria-hidden', 'true');
    }
    const btn = document.getElementById('shoutbox-open-btn');
    if (btn) btn.classList.add('hidden');
    document.body.classList.remove('share-shoutbox-open', 'share-cinema-active');
  },

  bindEvents() {
    document.addEventListener('click', (e) => {
      if (e.target.id === 'shoutbox-open-btn') { ShareShoutbox.openPanel({ focusInput: true }); }
      if (e.target.id === 'shoutbox-close') { ShareShoutbox.closePanel(); }
      if (e.target.id === 'shoutbox-send') { ShareShoutbox.sendMessage(); }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.id === 'shoutbox-input') {
        e.preventDefault();
        ShareShoutbox.sendMessage();
      }
    });
  },
};

ShareShoutbox.bindEvents();
