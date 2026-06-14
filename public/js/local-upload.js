const LocalUpload = {
  _last: null,
  _toastShown: false,
  LOCAL_KEY: 'vault-local-upload-ipv4',

  isPrivateIpv4(ip) {
    const h = String(ip || '').trim();
    if (!h) return false;
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
    if (h === '127.0.0.1') return true;
    return false;
  },

  isLocalHostname(host = window.location.hostname) {
    const h = String(host || '').toLowerCase();
    if (!h || h === 'localhost' || h === '127.0.0.1') return true;
    return this.isPrivateIpv4(h);
  },

  getCachedIpv4() {
    try {
      const ip = localStorage.getItem(this.LOCAL_KEY);
      return ip && this.isPrivateIpv4(ip) ? ip : null;
    } catch {
      return null;
    }
  },

  setCachedIpv4(ip) {
    try {
      if (ip) localStorage.setItem(this.LOCAL_KEY, ip);
      else localStorage.removeItem(this.LOCAL_KEY);
    } catch {
      /* ignore */
    }
  },

  merge(serverStatus) {
    const hostname = window.location.hostname;
    const cached = this.getCachedIpv4();
    const base = serverStatus && typeof serverStatus === 'object'
      ? { ...serverStatus }
      : {
        active: false,
        onLan: false,
        configured: false,
        configuredIpv4: null,
        serverIpv4: [],
        detectedIpv4: [],
        localUrl: null,
        hostname,
      };

    const configuredIpv4 = base.configuredIpv4 || cached || null;
    if (configuredIpv4) {
      base.configuredIpv4 = configuredIpv4;
      base.configured = true;
      if (!base.serverIpv4?.includes(configuredIpv4)) {
        base.serverIpv4 = [configuredIpv4, ...(base.serverIpv4 || [])];
      }
    }

    if (this.isLocalHostname(hostname)) {
      base.active = true;
      base.onLan = true;
    } else if (configuredIpv4 && hostname === configuredIpv4) {
      base.active = true;
      base.onLan = true;
    }

    if (!base.localUrl && configuredIpv4 && !base.active) {
      const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
      const showPort = port && port !== '80' && port !== '443';
      base.localUrl = `${window.location.protocol}//${configuredIpv4}${showPort ? `:${port}` : ''}`;
    }

    if (configuredIpv4) this.setCachedIpv4(configuredIpv4);

    return base;
  },

  apply(serverStatus) {
    this._last = this.merge(serverStatus);
    this.render(this._last);
    this.syncModal(this._last);
    return this._last;
  },

  async refresh() {
    try {
      const status = await API.get('/api/network/local-upload');
      return this.apply(status);
    } catch {
      return this.apply(null);
    }
  },

  async save(serverIpv4) {
    const ip = String(serverIpv4 || '').trim();
    const status = await API.put('/api/network/local-upload', { serverIpv4: ip || null });
    if (ip) this.setCachedIpv4(ip);
    else this.setCachedIpv4(null);
    return this.apply(status);
  },

  openModal() {
    const modal = document.getElementById('local-upload-modal');
    if (!modal) return;
    this.refresh().then((status) => {
      this.syncModal(status);
      modal.classList.remove('hidden');
    }).catch(() => {
      this.syncModal(this._last || this.merge(null));
      modal.classList.remove('hidden');
    });
  },

  syncModal(status) {
    const input = document.getElementById('local-upload-ipv4');
    const statusEl = document.getElementById('local-upload-modal-status');
    const detectedEl = document.getElementById('local-upload-detected');
    const openBtn = document.getElementById('btn-open-local-url');
    if (!input || !statusEl) return;

    const merged = status || this.merge(null);
    input.value = merged.configuredIpv4 || merged.serverIpv4?.[0] || this.getCachedIpv4() || '';

    const detected = merged.detectedIpv4?.length
      ? merged.detectedIpv4
      : (merged.serverIpv4 || []).filter((ip) => ip !== merged.configuredIpv4);

    if (detectedEl) {
      if (!detected.length) {
        detectedEl.innerHTML = '<span class="form-hint">Server did not auto-detect a LAN IP. Enter your server\'s IPv4 manually (ipconfig / ifconfig).</span>';
      } else {
        detectedEl.innerHTML = detected.map((ip) =>
          `<button type="button" class="local-upload-detect-chip" data-ip="${ip}">${ip}</button>`
        ).join('');
        detectedEl.querySelectorAll('.local-upload-detect-chip').forEach((btn) => {
          btn.onclick = () => {
            input.value = btn.dataset.ip || '';
          };
        });
      }
    }

    if (merged.active) {
      statusEl.innerHTML = `<span class="local-upload-modal-on">Local upload is ON — you are using the fast LAN path.</span>`;
    } else if (merged.configuredIpv4 && merged.localUrl) {
      statusEl.innerHTML = `<span class="local-upload-modal-suggest">Saved LAN IP <strong>${merged.configuredIpv4}</strong>. `
        + `Open <a href="${merged.localUrl}">${merged.localUrl.replace(/^https?:\/\//, '')}</a> on this device for faster uploads.</span>`;
    } else if (merged.configuredIpv4) {
      statusEl.innerHTML = `<span class="local-upload-modal-suggest">Saved LAN IP: <strong>${merged.configuredIpv4}</strong></span>`;
    } else {
      statusEl.innerHTML = '<span class="form-hint">Save your server\'s LAN IPv4 to get a one-click link for faster uploads when you use a domain or tunnel.</span>';
    }

    if (openBtn) {
      const url = merged.localUrl || (merged.configuredIpv4 ? this.merge({ ...merged, localUrl: null }).localUrl : null);
      openBtn.disabled = !url;
      openBtn.onclick = url ? () => { window.location.href = url; } : null;
    }
  },

  render(status) {
    const ribbon = document.getElementById('local-upload-ribbon');
    const statusBar = document.getElementById('local-upload-status');
    const lanBtn = document.getElementById('btn-local-upload');
    const merged = status || this.merge(null);

    if (lanBtn) {
      lanBtn.title = merged.configuredIpv4
        ? `LAN upload: ${merged.configuredIpv4} (click to edit)`
        : 'Configure server LAN IPv4 for faster uploads';
      lanBtn.classList.toggle('local-upload-btn-on', !!merged.active);
    }

    const targets = [ribbon, statusBar].filter(Boolean);
    if (!targets.length) return;

    let className = 'local-upload-status hidden';
    let html = '';
    let text = '';
    let title = '';

    if (merged.active) {
      const ip = merged.configuredIpv4 || merged.serverIpv4?.[0];
      className = 'local-upload-status local-upload-on';
      text = ip ? `⚡ Local upload: ON (${ip})` : '⚡ Local upload: ON';
      title = 'Browser → server traffic uses your LAN (fast uploads to server cache).';
      if (typeof App !== 'undefined' && !this._toastShown) {
        this._toastShown = true;
        App.toast('Local upload path is active — LAN speed to server', 'success');
      }
    } else if (merged.configuredIpv4 && merged.localUrl) {
      const label = merged.localUrl.replace(/^https?:\/\//, '');
      className = 'local-upload-status local-upload-suggest';
      html = `⚡ LAN ${merged.configuredIpv4} — <a href="${merged.localUrl}">open ${label}</a>`;
      title = 'You saved the server LAN IP. Open the local URL on this device for faster uploads.';
    } else if (merged.configuredIpv4) {
      className = 'local-upload-status local-upload-suggest';
      text = `⚡ LAN saved: ${merged.configuredIpv4}`;
      title = 'Server LAN IP saved. Click ⚡ LAN to open settings.';
    } else if (merged.onLan && merged.localUrl) {
      const label = merged.localUrl.replace(/^https?:\/\//, '');
      className = 'local-upload-status local-upload-suggest';
      html = `⚡ Faster uploads: <a href="${merged.localUrl}">${label}</a>`;
      title = 'You appear to be on the same network as the server.';
    }

    const show = merged.active
      || (merged.configuredIpv4 && merged.localUrl)
      || merged.configuredIpv4
      || (merged.onLan && merged.localUrl);

    for (const el of targets) {
      if (!show) {
        el.className = el.id === 'local-upload-ribbon'
          ? 'local-upload-ribbon hidden'
          : 'local-upload-status hidden';
        el.textContent = '';
        el.innerHTML = '';
        continue;
      }
      el.className = el.id === 'local-upload-ribbon'
        ? className.replace('local-upload-status', 'local-upload-ribbon')
        : className;
      el.title = title;
      if (html) el.innerHTML = html;
      else el.textContent = text;
    }
  },
};
