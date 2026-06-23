const SiteAccess = {
  status: null,

  VAULT_LOGO_SVG: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
    <path d="M12 2L2 7l10 5 10-5-10-5z"/>
    <path d="M2 17l10 5 10-5"/>
    <path d="M2 12l10 5 10-5"/>
  </svg>`,

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
    if (typeof window !== 'undefined') window.__shareBootPrefetch = null;
    return data;
  },

  formFieldsMarkup(subtitle) {
    const sub = subtitle || 'Enter the 6-digit site access key to continue.';
    return `
      <p class="site-access-desc">${sub}</p>
      <div class="site-access-field">
        <label class="site-access-label" for="site-access-key-input">6-digit access key</label>
        <input id="site-access-key-input" class="site-access-input" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" placeholder="••••••" aria-label="Site access key">
      </div>
      <p class="site-access-error hidden" role="alert"></p>`;
  },

  inlineGateMarkup(subtitle) {
    return `
      <div class="site-access-inline">
        <div class="site-access-inline-badge">${this.VAULT_LOGO_SVG}</div>
        <h2 class="site-access-inline-title">Site access required</h2>
        ${this.formFieldsMarkup(subtitle)}
        <button type="button" class="site-access-unlock-btn btn-primary">Continue</button>
      </div>`;
  },

  shareModalMarkup(subtitle) {
    const sub = subtitle || 'Enter the site access key to view shared content.';
    return `
      <div class="site-access-modal-backdrop" aria-hidden="true"></div>
      <div class="site-access-modal-content" role="document">
        <div class="site-access-modal-header">
          <div class="site-access-modal-icon">${this.VAULT_LOGO_SVG}</div>
          <div class="site-access-modal-titles">
            <h2 id="site-access-modal-title">Protected content</h2>
            <p class="site-access-modal-brand">GitHub Vault</p>
          </div>
        </div>
        <div class="site-access-modal-body">
          ${this.formFieldsMarkup(sub)}
        </div>
        <div class="site-access-modal-footer">
          <button type="button" class="site-access-unlock-btn btn-primary">Unlock</button>
        </div>
      </div>`;
  },

  setModalOpen(open) {
    document.body.classList.toggle('site-access-modal-open', !!open);
  },

  bindGate(rootEl, { authPanelEl = null, onUnlocked = null, subtitle = null, mode = 'inline' } = {}) {
    if (!rootEl) return;

    if (!rootEl.querySelector('.site-access-input')) {
      rootEl.innerHTML = mode === 'modal'
        ? this.shareModalMarkup(subtitle)
        : this.inlineGateMarkup(subtitle);
      if (mode === 'inline') rootEl.classList.add('site-access-panel');
    }

    if (rootEl.dataset.siteAccessBound === '1') {
      const blocking = this.isBlocking();
      if (mode === 'inline') {
        rootEl.classList.toggle('hidden', !blocking);
        if (authPanelEl) authPanelEl.classList.toggle('hidden', blocking);
      } else {
        const modalRoot = rootEl.classList.contains('site-access-modal') ? rootEl : rootEl.closest('.site-access-modal');
        if (modalRoot) {
          modalRoot.classList.toggle('hidden', !blocking);
          this.setModalOpen(blocking);
        }
      }
      return;
    }
    rootEl.dataset.siteAccessBound = '1';

    const input = rootEl.querySelector('.site-access-input');
    const btn = rootEl.querySelector('.site-access-unlock-btn');
    const errEl = rootEl.querySelector('.site-access-error');
    const modalRoot = rootEl.classList.contains('site-access-modal') ? rootEl : rootEl.closest('.site-access-modal');

    const syncVisibility = () => {
      const blocking = this.isBlocking();
      if (mode === 'inline') {
        rootEl.classList.toggle('hidden', !blocking);
        if (authPanelEl) authPanelEl.classList.toggle('hidden', blocking);
      } else if (modalRoot) {
        modalRoot.classList.toggle('hidden', !blocking);
        this.setModalOpen(blocking);
      }
    };
    syncVisibility();

    const submit = async () => {
      errEl?.classList.add('hidden');
      btn?.classList.add('loading');
      try {
        await this.verify(input?.value);
        syncVisibility();
        if (modalRoot) this.setModalOpen(false);
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
    if (this.isBlocking()) {
      setTimeout(() => input?.focus(), 0);
    }
  },

  ensureShareGate(onUnlocked, subtitle) {
    return this.loadStatus().then(() => {
      if (!this.isBlocking()) return onUnlocked();
      let modal = document.getElementById('site-access-modal');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'site-access-modal';
        modal.className = 'site-access-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'site-access-modal-title');
        document.body.appendChild(modal);
      }
      modal.classList.remove('hidden');
      this.setModalOpen(true);
      this.bindGate(modal, {
        mode: 'modal',
        subtitle: subtitle || 'Enter the site access key to view shared content.',
        onUnlocked: async () => {
          modal.classList.add('hidden');
          this.setModalOpen(false);
          if (typeof window !== 'undefined') window.__shareBootPrefetch = null;
          await onUnlocked();
        },
      });
    });
  },
};
