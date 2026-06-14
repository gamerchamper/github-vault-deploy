const LocalUpload = {
  _last: null,
  _toastShown: false,

  isLocalHostname(host = window.location.hostname) {
    const h = String(host || '').toLowerCase();
    if (!h || h === 'localhost' || h === '127.0.0.1') return true;
    if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
    if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(h)) return true;
    return false;
  },

  merge(serverStatus) {
    const hostname = window.location.hostname;
    const clientLocal = this.isLocalHostname(hostname);
    const base = serverStatus && typeof serverStatus === 'object' ? { ...serverStatus } : {
      active: false,
      onLan: false,
      serverIpv4: [],
      localUrl: null,
      hostname,
    };

    if (clientLocal) {
      base.active = true;
      base.onLan = true;
      base.hostname = hostname;
      if (!base.serverIpv4?.length && this.isLocalHostname(hostname) && hostname !== 'localhost' && hostname !== '127.0.0.1') {
        base.serverIpv4 = [hostname];
      }
    }

    if (!base.localUrl && !base.active && base.onLan && base.serverIpv4?.length) {
      const port = window.location.port || (window.location.protocol === 'https:' ? '443' : '80');
      const showPort = port && port !== '80' && port !== '443';
      base.localUrl = `${window.location.protocol}//${base.serverIpv4[0]}${showPort ? `:${port}` : ''}`;
    }

    return base;
  },

  apply(serverStatus) {
    this._last = this.merge(serverStatus);
    this.render(this._last);
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

  render(status) {
    const targets = [
      document.getElementById('local-upload-status'),
      document.getElementById('local-upload-ribbon'),
    ].filter(Boolean);

    if (!targets.length) return;

    if (!status || (!status.active && !(status.onLan && status.localUrl))) {
      for (const el of targets) {
        el.className = el.id === 'local-upload-ribbon'
          ? 'local-upload-ribbon hidden'
          : 'local-upload-status hidden';
        el.textContent = '';
        el.innerHTML = '';
      }
      return;
    }

    let className = 'local-upload-status hidden';
    let html = '';
    let text = '';
    let title = '';

    if (status.active) {
      const ip = status.serverIpv4?.[0];
      className = 'local-upload-status local-upload-on';
      text = ip ? `⚡ Local upload: ON (${ip})` : '⚡ Local upload: ON';
      title = 'Browser → server traffic is on your local network (fast uploads to server cache).';
      if (typeof App !== 'undefined' && !this._toastShown) {
        this._toastShown = true;
        App.toast('Local upload path is active — LAN speed to server', 'success');
      }
    } else if (status.onLan && status.localUrl) {
      const label = status.localUrl.replace(/^https?:\/\//, '');
      className = 'local-upload-status local-upload-suggest';
      html = `⚡ Faster uploads: <a href="${status.localUrl}">${label}</a>`;
      title = 'You are on the same network as the server. Open the local address for faster uploads.';
    }

    for (const el of targets) {
      el.className = el.id === 'local-upload-ribbon' ? className.replace('local-upload-status', 'local-upload-ribbon') : className;
      el.title = title;
      if (html) {
        el.innerHTML = html;
      } else {
        el.textContent = text;
      }
    }
  },
};
