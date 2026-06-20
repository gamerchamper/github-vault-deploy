const SiteAccess = {
  status: null,

  async loadStatus() {
    try {
      const res = await fetch('/api/access/status', { credentials: 'same-origin', cache: 'no-store' });
      this.status = await res.json();
    } catch {
      this.status = { required: false, unlocked: true };
    }
    return this.status;
  },

  isBlocking() {
    return !!(this.status?.required && !this.status?.unlocked);
  },

  applyStatusFromAuth(auth) {
    if (auth?.site_access) this.status = auth.site_access;
  },

  async verify(key) {
    const res = await fetch('/api/access/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ key: String(key || '').trim() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Invalid access key');
    this.status = { required: true, unlocked: true };
    return data;
  },

  gateMarkup(subtitle) {
    const sub = subtitle || 'Enter the 6-digit site access key to continue.';
    return `
      <div class="site-access-logo" aria-hidden="true">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <path d="M12 2L2 7l10 5 10-5-10-5z"/>
          <path d="M2 17l10 5 10-5"/>
          <path d="M2 12l10 5 10-5"/>
        </svg>
      </div>
      <p class="site-access-sub">${sub}</p>
      <div class="site-access-row">
        <input class="site-access-input" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" placeholder="6-digit key" aria-label="Site access key">
        <button type="button" class="site-access-unlock-btn btn-primary">Unlock</button>
      </div>
      <p class="site-access-error hidden" role="alert"></p>`;
  },

  bindGate(rootEl, { authPanelEl = null, onUnlocked = null, subtitle = null } = {}) {
    if (!rootEl) return;
    if (!rootEl.querySelector('.site-access-input')) {
      rootEl.innerHTML = this.gateMarkup(subtitle);
      rootEl.classList.add('site-access-panel');
    }

    const input = rootEl.querySelector('.site-access-input');
    const btn = rootEl.querySelector('.site-access-unlock-btn');
    const errEl = rootEl.querySelector('.site-access-error');

    const syncVisibility = () => {
      const blocking = this.isBlocking();
      rootEl.classList.toggle('hidden', !blocking);
      if (authPanelEl) authPanelEl.classList.toggle('hidden', blocking);
    };
    syncVisibility();

    const submit = async () => {
      errEl?.classList.add('hidden');
      btn?.classList.add('loading');
      try {
        await this.verify(input?.value);
        syncVisibility();
        if (onUnlocked) await onUnlocked();
      } catch (err) {
        if (errEl) {
          errEl.textContent = err.message || 'Invalid access key';
          errEl.classList.remove('hidden');
        }
        input?.focus();
        input?.select();
      } finally {
        btn?.classList.remove('loading');
      }
    };

    btn?.addEventListener('click', submit);
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
    if (this.isBlocking()) input?.focus();
  },

  ensureShareGate(onUnlocked, subtitle) {
    return this.loadStatus().then(() => {
      if (!this.isBlocking()) return onUnlocked();
      let overlay = document.getElementById('site-access-overlay');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'site-access-overlay';
        overlay.className = 'site-access-overlay';
        overlay.innerHTML = `<div class="site-access-card"><h1>GitHub Vault</h1></div>`;
        const card = overlay.querySelector('.site-access-card');
        card.insertAdjacentHTML('beforeend', this.gateMarkup(
          subtitle || 'Enter the site access key to view shared content.',
        ));
        document.body.prepend(overlay);
      }
      overlay.classList.remove('hidden');
      this.bindGate(overlay.querySelector('.site-access-card'), {
        subtitle,
        onUnlocked: async () => {
          overlay.classList.add('hidden');
          await onUnlocked();
        },
      });
    });
  },
};
