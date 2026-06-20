const LiveViewers = {
  active: false,
  eventSource: null,
  pollTimer: null,
  rafId: null,
  pendingData: null,

  formatDuration(ms) {
    if (!ms || ms < 0) return '0s';
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  },

  formatLocation(geo) {
    if (!geo) return '—';
    const parts = [geo.city, geo.region, geo.country].filter(Boolean);
    return parts.length ? parts.join(', ') : 'Unknown';
  },

  formatCoords(geo) {
    if (!geo || geo.lat == null || geo.lon == null) return '';
    return `${geo.lat.toFixed(2)}, ${geo.lon.toFixed(2)}`;
  },

  parseUserAgent(ua) {
    if (!ua) return '—';
    if (/Edg\//.test(ua)) return 'Edge';
    if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) return 'Chrome';
    if (/Firefox\//.test(ua)) return 'Firefox';
    if (/Safari\//.test(ua) && !/Chrome/.test(ua)) return 'Safari';
    if (/OPR\//.test(ua)) return 'Opera';
    return ua.slice(0, 48) + (ua.length > 48 ? '…' : '');
  },

  escape(str) {
    const node = document.createElement('span');
    node.textContent = str || '';
    return node.innerHTML;
  },

  render(data) {
    if (document.hidden) {
      this.pendingData = data;
      if (!this.rafId) {
        this.rafId = requestAnimationFrame(() => {
          this.rafId = null;
          if (this.pendingData) {
            this.renderNow(this.pendingData);
            this.pendingData = null;
          }
        });
      }
      return;
    }
    this.renderNow(data);
  },

  renderNow(data) {
    const total = data?.totalViewers || 0;
    const shares = data?.activeShares || 0;

    const totalEl = document.getElementById('viewers-total');
    const sharesEl = document.getElementById('viewers-shares');
    if (totalEl) totalEl.textContent = total;
    if (sharesEl) sharesEl.textContent = shares;

    const badge = document.getElementById('viewers-badge');
    if (badge) {
      badge.textContent = String(total);
      badge.classList.toggle('hidden', total === 0);
    }

    const empty = document.getElementById('viewers-empty');
    const list = document.getElementById('viewers-list');

    if (!data?.sessions?.length) {
      empty.classList.remove('hidden');
      list.innerHTML = '';
      return;
    }

    empty.classList.add('hidden');
    this.diffSessions(list, data.sessions);
  },

  diffSessions(container, sessions) {
    const existing = container.querySelectorAll('.viewers-session');
    const lenDiff = sessions.length - existing.length;

    if (lenDiff > 0) {
      for (let i = existing.length; i < sessions.length; i++) {
        const wrapper = document.createElement('div');
        wrapper.innerHTML = this.sessionHtml(sessions[i]);
        const section = wrapper.firstElementChild;
        applyDynamicStyles(section);
        container.appendChild(section);
      }
    } else if (lenDiff < 0) {
      for (let i = existing.length - 1; i >= sessions.length; i--) {
        existing[i].remove();
      }
    }

    const current = container.querySelectorAll('.viewers-session');
    for (let i = 0; i < sessions.length; i++) {
      this.diffSessionRows(current[i], sessions[i]);
    }
  },

  diffSessionRows(sessionEl, session) {
    const countEl = sessionEl.querySelector('.viewers-session-count');
    if (countEl) countEl.textContent = `${session.viewerCount} viewer${session.viewerCount === 1 ? '' : 's'}`;

    const tbody = sessionEl.querySelector('tbody');
    if (!tbody) return;

    const existing = tbody.querySelectorAll('tr');
    const viewers = session.viewers || [];
    const lenDiff = viewers.length - existing.length;

    if (lenDiff > 0) {
      for (let i = existing.length; i < viewers.length; i++) {
        tbody.appendChild(this.viewerRowEl(viewers[i]));
      }
    } else if (lenDiff < 0) {
      for (let i = existing.length - 1; i >= viewers.length; i--) {
        existing[i].remove();
      }
    }

    const rows = tbody.querySelectorAll('tr');
    for (let i = 0; i < viewers.length; i++) {
      this.updateViewerRow(rows[i], viewers[i]);
    }
  },

  sessionHtml(session) {
    const shareLabel = session.isFolder ? '📁' : '📄';
    const shareLink = session.shareUrl
      ? `<a href="${this.escape(session.shareUrl)}" target="_blank" rel="noopener">${this.escape(session.fileName)}</a>`
      : this.escape(session.fileName);

    const rows = (session.viewers || []).map((v) => {
      const location = this.formatLocation(v.geo);
      const coords = this.formatCoords(v.geo);
      const ip = v.ip || '—';
      const isp = v.geo?.isp || '—';
      const browser = this.parseUserAgent(v.userAgent);
      const active = this.formatDuration(v.activeMs);
      const idle = v.idleMs < 5000 ? 'now' : `${Math.round(v.idleMs / 1000)}s ago`;

      return `<tr>
        <td><div class="viewer-cell-name"><span class="viewer-avatar" data-avatar-color="${v.color}">${this.escape(v.initials)}</span><span>${this.escape(v.name)}</span></div></td>
        <td><code class="viewer-ip">${this.escape(ip)}</code></td>
        <td><div class="viewer-location">${this.escape(location)}</div>${coords ? `<div class="viewer-coords">${this.escape(coords)}</div>` : ''}</td>
        <td>${this.escape(isp)}</td>
        <td><span class="viewer-active">${active}</span></td>
        <td>${idle}</td>
        <td title="${this.escape(v.userAgent || '')}">${this.escape(browser)}</td>
      </tr>`;
    }).join('');

    return `<section class="viewers-session">
      <div class="viewers-session-header">
        <div class="viewers-session-title">${shareLabel} ${shareLink}</div>
        <span class="viewers-session-count">${session.viewerCount} viewer${session.viewerCount === 1 ? '' : 's'}</span>
      </div>
      <div class="viewers-table-wrap">
        <table class="viewers-table"><thead><tr>
          <th>Viewer</th><th>IP</th><th>Location</th><th>ISP</th><th>Active</th><th>Last seen</th><th>Browser</th>
        </tr></thead><tbody>${rows}</tbody></table>
      </div>
    </section>`;
  },

  viewerRowEl(viewer) {
    const tr = document.createElement('tr');
    const location = this.formatLocation(viewer.geo);
    const coords = this.formatCoords(viewer.geo);
    const ip = viewer.ip || '—';
    const isp = viewer.geo?.isp || '—';
    const browser = this.parseUserAgent(viewer.userAgent);
    const active = this.formatDuration(viewer.activeMs);
    const idle = viewer.idleMs < 5000 ? 'now' : `${Math.round(viewer.idleMs / 1000)}s ago`;

    tr.innerHTML = `
      <td><div class="viewer-cell-name"><span class="viewer-avatar" data-avatar-color="${viewer.color}">${this.escape(viewer.initials)}</span><span>${this.escape(viewer.name)}</span></div></td>
      <td><code class="viewer-ip">${this.escape(ip)}</code></td>
      <td><div class="viewer-location">${this.escape(location)}</div>${coords ? `<div class="viewer-coords">${this.escape(coords)}</div>` : ''}</td>
      <td>${this.escape(isp)}</td>
      <td><span class="viewer-active">${active}</span></td>
      <td>${idle}</td>
      <td title="${this.escape(viewer.userAgent || '')}">${this.escape(browser)}</td>`;
    applyDynamicStyles(tr);
    return tr;
  },

  updateViewerRow(tr, viewer) {
    const cells = tr.querySelectorAll('td');
    if (cells.length < 7) return;

    const location = this.formatLocation(viewer.geo);
    const ip = viewer.ip || '—';
    const isp = viewer.geo?.isp || '—';
    const browser = this.parseUserAgent(viewer.userAgent);
    const active = this.formatDuration(viewer.activeMs);
    const idle = viewer.idleMs < 5000 ? 'now' : `${Math.round(viewer.idleMs / 1000)}s ago`;

    const nameSpan = cells[0]?.querySelector('span:last-child');
    if (nameSpan) nameSpan.textContent = viewer.name;

    const ipEl = cells[1]?.querySelector('code');
    if (ipEl) ipEl.textContent = ip;

    const locEl = cells[2]?.querySelector('.viewer-location');
    if (locEl) locEl.textContent = location;

    const coordsEl = cells[2]?.querySelector('.viewer-coords');
    if (coordsEl) coordsEl.textContent = this.formatCoords(viewer.geo);

    if (cells[3]) cells[3].textContent = isp;

    const activeEl = cells[4]?.querySelector('.viewer-active');
    if (activeEl) activeEl.textContent = active;

    if (cells[5]) cells[5].textContent = idle;

    if (cells[6]) cells[6].textContent = browser;
  },

  scheduleRender(data) {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = requestAnimationFrame(() => {
      this.rafId = null;
      this.render(data);
    });
  },

  async refresh() {
    try {
      const data = await API.viewers.live();
      this.scheduleRender(data);
    } catch (err) {
      console.error('Failed to load viewers', err);
    }
  },

  startStream() {
    this.stopStream();
    if (typeof EventSource === 'undefined') {
      this.pollTimer = setInterval(() => this.refresh(), 5000);
      this.refresh();
      return;
    }

    this.eventSource = new EventSource('/api/viewers/live/stream');
    this.eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.scheduleRender(data);
      } catch { /* ignore */ }
    };
    this.eventSource.onerror = () => {
      this.stopStream();
      this.pollTimer = setInterval(() => this.refresh(), 5000);
      this.refresh();
    };
  },

  stopStream() {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.pendingData = null;
  },

  show() {
    this.active = true;
    App.activeUtilityView = 'viewers';
    document.getElementById('file-view')?.classList.add('hidden');
    App.hideUtilityPanels?.();
    document.getElementById('viewers-panel')?.classList.remove('hidden');
    document.querySelectorAll('.sidebar-item[data-view]').forEach((el) => {
      el.classList.toggle('active', el.dataset.view === 'viewers');
    });
    document.getElementById('btn-viewers')?.classList.add('active');
    this.startStream();
  },

  hide() {
    this.active = false;
    document.getElementById('viewers-panel')?.classList.add('hidden');
    document.getElementById('btn-viewers')?.classList.remove('active');
    if (!App.activeUtilityView) {
      document.getElementById('file-view')?.classList.remove('hidden');
    }
    this.stopStream();
  },
};
