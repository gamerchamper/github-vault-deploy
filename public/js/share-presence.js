const SharePresence = {
  token: null,
  viewerId: null,
  heartbeatTimer: null,
  eventSource: null,
  maxVisible: 5,

  getViewerId() {
    const key = 'shareViewerId';
    let id = sessionStorage.getItem(key);
    if (!id) {
      id = crypto.randomUUID?.() || `v-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      sessionStorage.setItem(key, id);
    }
    return id;
  },

  async post(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    });
    if (!res.ok) throw new Error('Presence request failed');
    return res.json();
  },

  render(viewers) {
    const el = document.getElementById('share-presence');
    if (!el) return;

    const selfId = this.viewerId;
    const others = viewers.filter((v) => v.id !== selfId);
    const total = viewers.length;

    if (total === 0) {
      el.classList.add('hidden');
      el.innerHTML = '';
      return;
    }

    el.classList.remove('hidden');
    const visible = viewers.slice(0, this.maxVisible);
    const overflow = total > this.maxVisible ? total - this.maxVisible : 0;

    const avatars = visible.map((v) => {
      const isSelf = v.id === selfId;
      return `
        <span
          class="share-presence-avatar${isSelf ? ' is-self' : ''}"
          style="background:${v.color}"
          title="${this.escape(isSelf ? `${v.name} (you)` : v.name)}"
        >${this.escape(v.initials)}</span>
      `;
    }).join('');

    const overflowHtml = overflow
      ? `<span class="share-presence-overflow" title="${overflow} more viewer${overflow === 1 ? '' : 's'}">+${overflow}</span>`
      : '';

    const label = total === 1
      ? '1 viewer'
      : `${total} viewers`;

    el.innerHTML = `
      <div class="share-presence-inner">
        <span class="share-presence-label">${label}</span>
        <div class="share-presence-avatars">${avatars}${overflowHtml}</div>
      </div>
    `;
  },

  escape(str) {
    const node = document.createElement('span');
    node.textContent = str || '';
    return node.innerHTML;
  },

  async join(token) {
    this.token = token;
    this.viewerId = this.getViewerId();
    const base = `/api/public/share/${token}/presence`;

    const { viewers } = await this.post(`${base}/join`, { viewer_id: this.viewerId });
    this.render(viewers);

    this.eventSource = new EventSource(`${base}/stream`);
    this.eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.viewers) this.render(data.viewers);
      } catch { /* ignore */ }
    };

    this.heartbeatTimer = setInterval(async () => {
      try {
        const { viewers } = await this.post(`${base}/heartbeat`, { viewer_id: this.viewerId });
        this.render(viewers);
      } catch {
        // stream will catch up on reconnect; ignore transient errors
      }
    }, 15000);

    window.addEventListener('beforeunload', this.onLeave);
    window.addEventListener('pagehide', this.onLeave);
  },

  onLeave() {
    if (!SharePresence.token || !SharePresence.viewerId) return;
    const url = `/api/public/share/${SharePresence.token}/presence/leave`;
    const body = JSON.stringify({ viewer_id: SharePresence.viewerId });
    navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
    if (typeof ShareViewer !== 'undefined') {
      ShareViewer.destroy({ useBeacon: true });
    }
  },

  stop() {
    window.removeEventListener('beforeunload', this.onLeave);
    window.removeEventListener('pagehide', this.onLeave);
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    if (this.token && this.viewerId) {
      this.post(`/api/public/share/${this.token}/presence/leave`, { viewer_id: this.viewerId }).catch(() => {});
    }
  },
};
