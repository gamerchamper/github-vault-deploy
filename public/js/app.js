(function patchThumbCache() {
  if (typeof ThumbCache === 'undefined') return;
  if (typeof ThumbCache.isFailed !== 'function') {
    ThumbCache.failed = ThumbCache.failed || new Set();
    ThumbCache.isFailed = (id, version) => ThumbCache.failed.has(`${id}:${version || 0}`);
  }
  if (typeof ThumbCache.markFailed !== 'function') {
    ThumbCache.markFailed = (id, version) => {
      ThumbCache.failed = ThumbCache.failed || new Set();
      ThumbCache.failed.add(`${id}:${version || 0}`);
      ThumbCache.pending?.delete?.(`${id}:${version || 0}`);
    };
  }
})();

function isStorageAccountRole(role) {
  return role === 'storage' || role === 'both';
}

function isBackupAccountRole(role) {
  return role === 'backup' || role === 'both';
}

function linkedAccountRoleLabel(role) {
  if (role === 'both') return 'Storage + backup';
  if (role === 'backup') return 'Backup / redundancy';
  return 'Additional storage';
}

const explorer = new Explorer();
let toastTimer = null;

const PROVIDER_LABELS = {
  github: 'GitHub',
  bitbucket: 'Bitbucket',
  codeberg: 'Codeberg',
  pastebin: 'Pastebin',
};

function providerLabelFor(id) {
  return PROVIDER_LABELS[id] || 'GitHub';
}

const App = {
  backupPollTimer: null,
  rateLimitPollTimer: null,
  viewersBadgeTimer: null,
  softReloadTimer: null,
  SOFT_RELOAD_MS: 45 * 60 * 1000,
  lastBackupSync: null,
  lastCapacity: null,
  lastCacheStats: null,
  storageReposExpanded: false,
  metadataReposExpanded: false,
  apiKeysLoaded: false,
  lastLocalUpload: null,
  pendingUploadMode: null,
  activeUtilityView: null,
  _sidebarNavBound: false,

  toast(message, type = '') {
    if (type === 'error') {
      console.error('[GitHub Vault]', message);
    }
    const el = document.getElementById('toast');
    el.textContent = message;
    el.className = 'toast' + (type ? ` ${type}` : '');
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
  },

  clearLegacyShareServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.getRegistrations().then((regs) => {
      regs.forEach((reg) => {
        const url = reg.active?.scriptURL || reg.installing?.scriptURL || reg.waiting?.scriptURL || '';
        if (url.includes('/sw-share.js')) {
          reg.unregister().catch(() => {});
        }
      });
    }).catch(() => {});
  },

  setButtonLoading(btn, loading) {
    if (!btn) return;
    btn.classList.toggle('loading', loading);
    if (loading) {
      btn.dataset.prevDisabled = btn.disabled;
      btn.disabled = true;
    } else {
      btn.disabled = btn.dataset.prevDisabled === 'true';
      delete btn.dataset.prevDisabled;
    }
  },

  _uploadActivity: 0,

  beginUploadActivity() {
    this._uploadActivity += 1;
    if (this._uploadActivity === 1) {
      App.setButtonLoading(document.getElementById('btn-upload'), true);
    }
  },

  endUploadActivity() {
    this._uploadActivity = Math.max(0, this._uploadActivity - 1);
    if (this._uploadActivity === 0) {
      App.setButtonLoading(document.getElementById('btn-upload'), false);
    }
  },

  async withButton(btn, fn) {
    App.setButtonLoading(btn, true);
    try {
      await fn();
    } finally {
      App.setButtonLoading(btn, false);
    }
  },

  async refreshAll() {
    await explorer.refresh();
    await Promise.all([this.loadStats(), this.loadAccountViews()]);
  },

  hasActiveTransfers() {
    if (this._uploadActivity > 0) return true;
    if (typeof UploadManager !== 'undefined' && UploadManager.active?.size > 0) return true;
    if (typeof DownloadManager !== 'undefined') {
      for (const job of DownloadManager.jobs.values()) {
        if (!job.done) return true;
      }
    }
    return false;
  },

  teardownRuntime() {
    Viewer?.close?.();
    if (typeof LiveViewers !== 'undefined') LiveViewers.hide?.();
    if (typeof BandwidthPanel !== 'undefined') BandwidthPanel.hide?.();
    if (typeof GlobalSearch !== 'undefined') GlobalSearch.hide?.();
    DetailsPreview?.clear?.();
    ThumbCache?.clear?.();
    VirtualGrid?.teardown?.();

    this.stopBackupPoll();
    this.stopRateLimitPoll();
    if (this.viewersBadgeTimer) {
      clearInterval(this.viewersBadgeTimer);
      this.viewersBadgeTimer = null;
    }

    if (typeof DownloadManager !== 'undefined') {
      for (const [id, job] of DownloadManager.jobs) {
        if (job.done) DownloadManager.jobs.delete(id);
      }
    }

    explorer.files = [];
    explorer.listOffset = 0;
    explorer.listHasMore = false;
  },

  async rehydrateAfterSoftReload(saved) {
    VirtualGrid.init(explorer);
    try {
      const { tasks } = await API.tasks.list({ resumable: true });
      TaskPanel.tasks.clear();
      for (const task of tasks) TaskPanel.tasks.set(task.id, task);
      TaskPanel.scheduleRender();
      TaskPanel.ensurePoll();
    } catch {
      /* tasks rehydrate is best-effort */
    }
    await explorer.navigate(saved.path || '/', {
      viewMode: saved.viewMode || 'files',
      type: saved.type ?? null,
      search: saved.search ?? '',
      playlistId: saved.playlistId ?? null,
      collectionId: saved.collectionId ?? null,
    });
    await Promise.all([this.loadStats(), this.loadAccountViews()]);
    this.startBackupPoll();
    this.startRateLimitPoll();
    this.startViewersBadgePoll();
  },

  scheduleSoftReload() {
    if (this.softReloadTimer) clearTimeout(this.softReloadTimer);
    this.softReloadTimer = setTimeout(() => {
      this.softReload().catch(() => {});
    }, this.SOFT_RELOAD_MS);
  },

  async softReload() {
    if (this.hasActiveTransfers()) {
      this.scheduleSoftReload();
      return false;
    }
    const saved = {
      path: explorer.currentPath,
      viewMode: explorer.viewMode,
      type: explorer.filterType,
      search: explorer.searchQuery,
      playlistId: explorer.playlistId,
      collectionId: explorer.collectionId,
    };
    this.teardownRuntime();
    await this.rehydrateAfterSoftReload(saved);
    this.scheduleSoftReload();
    return true;
  },

  async checkAuth(retries = 3) {
    let last = { authenticated: false };
    for (let i = 0; i < retries; i++) {
      try {
        const auth = await API.auth.me();
        if (auth.authenticated) return auth;
        last = auth;
      } catch { /* retry */ }
      if (i < retries - 1) await new Promise(r => setTimeout(r, 300));
    }
    return last;
  },

  async init() {
    this.clearLegacyShareServiceWorker();
    const params = new URLSearchParams(window.location.search);
    const auth = await this.checkAuth();
    SiteAccess.applyStatusFromAuth(auth);

    if (SiteAccess.isBlocking()) {
      document.getElementById('login-screen').classList.remove('hidden');
      document.getElementById('app').classList.add('hidden');
      SiteAccess.bindGate(document.getElementById('site-access-panel'), {
        authPanelEl: document.getElementById('login-auth-panel'),
        subtitle: 'Enter the site access key before signing in.',
        onUnlocked: () => this.initAfterSiteAccess(params, auth),
      });
      this.updateSetupUrls();
      this.bindEvents();
      return;
    }

    await this.initAfterSiteAccess(params, auth);
  },

  async initAfterSiteAccess(params, auth) {
    if (!auth) auth = await this.checkAuth();
    SiteAccess.applyStatusFromAuth(auth);

    if (SiteAccess.isBlocking()) {
      document.getElementById('login-screen').classList.remove('hidden');
      document.getElementById('app').classList.add('hidden');
      SiteAccess.bindGate(document.getElementById('site-access-panel'), {
        authPanelEl: document.getElementById('login-auth-panel'),
        subtitle: 'Enter the site access key to use GitHub Vault.',
        onUnlocked: () => this.initAfterSiteAccess(params, auth),
      });
      return;
    }

    if (auth.authenticated) {
      this.showApp(auth.user);
      if (params.get('linked') === '1') {
        this.toast('GitHub account linked successfully — backup sync started', 'success');
        window.history.replaceState({}, '', '/');
        setTimeout(() => this.loadAccountViews(), 1500);
      }
      if (params.get('error') === 'link_failed') {
        const reason = params.get('reason');
        this.toast(reason ? `Link failed: ${decodeURIComponent(reason)}` : 'Failed to link GitHub account', 'error');
        window.history.replaceState({}, '', '/');
      }
      if (params.has('error') && params.get('error') !== 'link_failed') {
        window.history.replaceState({}, '', '/');
      }
    } else {
      this.showLogin(auth);
      if (params.get('site_access') === '1') {
        this.toast('Enter the site access key before signing in', 'error');
        window.history.replaceState({}, '', '/');
      }
      if (params.get('error')) {
        const reason = params.get('reason');
        const msg = reason
          ? `Sign-in failed: ${decodeURIComponent(reason)}`
          : `GitHub authentication failed. Use ${window.location.origin} and try again.`;
        this.toast(msg, 'error');
        window.history.replaceState({}, '', '/');
      }
    }

    this.updateSetupUrls();
    this.fetchProviderConfig().then((config) => {
      if (config) this.updateSetupUrls(config);
    });
    this.bindEvents();
    Viewer.bindEvents();
    DownloadManager.bindEvents();
  },

  showLogin(auth = {}) {
    if (this.softReloadTimer) {
      clearTimeout(this.softReloadTimer);
      this.softReloadTimer = null;
    }
    this.teardownRuntime();
    document.getElementById('login-screen').classList.remove('hidden');
    document.getElementById('app').classList.add('hidden');

    const sitePanel = document.getElementById('site-access-panel');
    const authPanel = document.getElementById('login-auth-panel');
    if (SiteAccess.isBlocking()) {
      sitePanel?.classList.remove('hidden');
      authPanel?.classList.add('hidden');
    } else {
      sitePanel?.classList.add('hidden');
      authPanel?.classList.remove('hidden');
    }

    const hint = document.getElementById('login-local-hint');
    if (hint) {
      const local = auth.local_auth;
      const onLocal = typeof LocalUpload !== 'undefined' && LocalUpload.isLocalHostname();
      if (onLocal && local?.needs_setup) {
        hint.textContent = 'Sign in with GitHub once to finish setup. After that, local visits skip login.';
        hint.classList.remove('hidden');
      } else if (onLocal && local?.eligible && local?.enabled === false) {
        hint.textContent = 'Local auto-login is disabled on this server (LOCAL_AUTH=false).';
        hint.classList.remove('hidden');
      } else {
        hint.textContent = '';
        hint.classList.add('hidden');
      }
    }
  },

  showApp(user) {
    this.currentUser = user;
    document.getElementById('login-screen').classList.add('hidden');
    document.getElementById('app').classList.remove('hidden');
    document.getElementById('user-name').textContent = user.username;
    document.getElementById('user-avatar').src = user.avatar || '';
    explorer.navigate('/', { viewMode: 'files', type: null, search: '' });
    VirtualGrid.init(explorer);
    this.loadStats();
    explorer.buildFolderTree();
    TaskPanel.init();
    UploadCenter.init();
    GlobalSearch.init();
    ExplorerKeyboard.init();
    DetailsPreview.init();
    Playlists.bindEvents();
    PlaylistPlayer.init();
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js?v=3').catch(() => {});
    }
    BandwidthPanel.init();
    this.initSortSelect();
    this.bindRepoSidebar();
    this.loadAccountViews();
    this.startBackupPoll();
    this.startRateLimitPoll();
    this.startViewersBadgePoll();
    this.scheduleSoftReload();
    const uploadMode = document.getElementById('upload-mode');
    if (uploadMode) uploadMode.value = UploadPrefs.get();
    LocalUpload.apply(null);
    LocalUpload.refresh().then((status) => {
      this.lastLocalUpload = status;
    }).catch(() => {});
  },

  async loadAccountViews() {
    const select = document.getElementById('account-view');
    if (!select) return;

    try {
      const { views, backup_sync: backupSync } = await API.accounts.views();
      const current = explorer.accountView || 'primary';
      select.innerHTML = views.map((view) => (
        `<option value="${view.id}"${view.id === current ? ' selected' : ''}>${view.label}</option>`
      )).join('');

      this.lastBackupSync = backupSync;
      this.renderBackupWidget(backupSync);
      this.ensureBackupPoll();
    } catch {
      select.innerHTML = '<option value="primary">Primary</option>';
    }
  },

  renderBackupWidget(backupSync) {
    const widget = document.getElementById('backup-sync-widget');
    const label = document.getElementById('backup-sync-label');
    const pct = document.getElementById('backup-sync-pct');
    const fill = document.getElementById('backup-sync-fill');
    if (!widget || !label || !pct || !fill) return;

    if (!backupSync?.length) {
      widget.classList.add('hidden');
      return;
    }

    const syncing = backupSync.some((s) => s.syncing);
    const pending = backupSync.filter((s) => !s.up_to_date);
    const totalMissing = pending.reduce((sum, s) => sum + s.missing_chunks, 0);
    const totalChunks = backupSync.reduce((sum, s) => sum + s.total_chunks, 0) || 1;
    const synced = totalChunks - totalMissing;
    const percent = syncing
      ? Math.max(...backupSync.map((s) => s.percent || 0))
      : Math.round((synced / totalChunks) * 100);

    widget.classList.remove('hidden', 'syncing', 'done', 'rate-limited');
    fill.style.width = `${Math.min(100, Math.max(0, percent))}%`;

    const paused = backupSync.some((s) => s.paused);
    if (paused) {
      widget.classList.add('paused');
      const active = backupSync.find((s) => s.paused);
      label.textContent = active?.pause_reason || 'Paused';
      pct.textContent = `${percent}%`;
    } else if (syncing) {
      widget.classList.add('syncing');
      const active = backupSync.find((s) => s.syncing) || backupSync.find((s) => !s.up_to_date);
      const phase = active?.phase === 'rate-limit'
        ? (active.rate_limit_seconds
          ? `Rate limited (${active.rate_limit_seconds}s)`
          : 'Rate limited — waiting')
        : active?.phase === 'backoff'
          ? `Backoff (${active.backoff_chunks || 0})${active.next_retry_seconds ? ` · ${active.next_retry_seconds}s` : ''}`
          : active?.phase === 'fork-sync' ? 'Syncing forks'
            : active?.phase === 'reconcile' ? 'Reconciling'
              : active?.phase === 'chunk-fallback' ? 'Syncing chunks'
                : 'Syncing backup';
      label.textContent = phase;
      if (active?.phase === 'rate-limit') widget.classList.add('rate-limited');
      pct.textContent = `${percent}%`;
    } else if (totalMissing > 0) {
      label.textContent = `${totalMissing} chunk${totalMissing === 1 ? '' : 's'} pending`;
      pct.textContent = `${percent}%`;
    } else {
      widget.classList.add('done');
      label.textContent = 'Backup up to date';
      pct.textContent = '100%';
    }

    const statsEl = document.getElementById('backup-sync-stats');
    const active = backupSync.find((s) => s.syncing || !s.up_to_date) || backupSync[0];
    if (statsEl && active?.queue) {
      const q = active.queue;
      statsEl.classList.remove('hidden');
      statsEl.innerHTML = `
        <span>Done ${q.synced}</span>
        <span>Proc ${q.processing}</span>
        <span>Backoff ${q.backoff}</span>
        <span>Failed ${q.failed}</span>
      `;
    } else if (statsEl) {
      statsEl.classList.add('hidden');
      statsEl.innerHTML = '';
    }
  },

  async forceBackupSync(accountId = null) {
    try {
      await API.accounts.startBackupSync(accountId, { force: true });
      App.toast('Backup sync force-started', 'success');
      await this.pollBackupStatus();
      TaskPanel.ensurePoll();
    } catch (err) {
      App.toast(err.message || 'Failed to start backup sync', 'error');
    }
  },

  ensureBackupPoll() {
    const needsPoll = this.lastBackupSync?.some(
      (s) => !s.up_to_date || s.syncing || s.paused || s.phase === 'rate-limit' || s.phase === 'backoff'
    );
    if (needsPoll) this.startBackupPoll();
    else this.stopBackupPoll();
  },

  startBackupPoll() {
    if (this.backupPollTimer) return;
    this.backupPollTimer = setInterval(() => this.pollBackupStatus(), 2500);
    this.pollBackupStatus();
  },

  stopBackupPoll() {
    if (!this.backupPollTimer) return;
    clearInterval(this.backupPollTimer);
    this.backupPollTimer = null;
  },

  startRateLimitPoll() {
    if (this.rateLimitPollTimer) return;
    this.loadRateLimits().catch(() => {});
    this.rateLimitPollTimer = setInterval(() => {
      this.loadRateLimits().catch(() => {});
    }, 60000);
  },

  stopRateLimitPoll() {
    if (!this.rateLimitPollTimer) return;
    clearInterval(this.rateLimitPollTimer);
    this.rateLimitPollTimer = null;
  },

  async pollBackupStatus() {
    try {
      const { backup_sync: backupSync } = await API.accounts.backupStatus();
      this.lastBackupSync = backupSync;
      this.renderBackupWidget(backupSync);
      if (!backupSync?.some((s) => !s.up_to_date || s.syncing || s.paused)) {
        this.stopBackupPoll();
        this.loadStats();
      }
    } catch {
      // keep polling through transient errors
    }
  },

  formatDuration(seconds) {
    if (!seconds || seconds <= 0) return 'now';
    if (seconds < 60) return `${seconds}s`;
    const mins = Math.ceil(seconds / 60);
    if (mins < 60) return `${mins} min`;
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    return rem ? `${hrs}h ${rem}m` : `${hrs}h`;
  },

  renderRateLimitAccount(account) {
    const usedPct = account.known ? (account.percent_used ?? 0) : 0;
    const cls = driveBarClass(usedPct);
    const remaining = account.known ? account.remaining : '?';
    const used = account.known ? account.used : '?';
    const limit = account.limit ?? 5000;
    const resetLabel = account.reset_in_seconds
      ? `resets in ${this.formatDuration(account.reset_in_seconds)}`
      : 'reset time unknown';
    const pauseBadge = account.paused
      ? `<span class="rate-limit-pause">${account.exhausted ? 'Exhausted' : 'Paused'} ${this.formatDuration(account.pause_seconds_left)}</span>`
      : '';
    const concurrency = account.thresholds?.current ?? account.recommended_concurrency ?? '—';

    return `
      <div class="rate-limit-item ${account.paused ? 'rate-limit-paused' : ''}" title="${account.label}">
        <div class="rate-limit-header">
          <span class="rate-limit-role">${account.role_label}</span>
          <span class="rate-limit-user">@${account.username}</span>
          ${pauseBadge}
        </div>
          <div class="drive-bar ${cls}">
          <div class="drive-bar-vault" data-bar="${Math.min(100, usedPct)}"></div>
        </div>
        <div class="rate-limit-detail">
          <span>${used} / ${limit} used</span>
          <span>${remaining} left</span>
        </div>
        <div class="rate-limit-meta">${resetLabel} · concurrency ${concurrency}</div>
      </div>
    `;
  },

  renderRateLimitPanel(accounts, targetId = 'rate-limit-panel') {
    const el = document.getElementById(targetId);
    if (!el) return;

    if (!accounts?.length) {
      el.innerHTML = '<div class="rate-limit-empty">No active accounts</div>';
      return;
    }

    const header = targetId === 'rate-limit-modal-panel'
      ? `<h4 class="rate-limit-modal-title">GitHub API quotas</h4>
         <p class="rate-limit-modal-hint">Each account has its own hourly request pool (typically 5,000/hr). Backup and primary are tracked separately.</p>
         <div id="rate-limit-dashboard">${this.renderApiDashboard(this.lastApiDashboard)}</div>`
      : '';
    el.innerHTML = header + accounts.map((a) => this.renderRateLimitAccount(a)).join('');
    applyDynamicStyles(el);
  },

  renderApiDashboard(dashboard) {
    if (!dashboard) return '';
    const subs = dashboard.recent_by_subsystem || {};
    const subRows = Object.entries(subs)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `<span class="rate-limit-sub">${name}: ${count}/min</span>`)
      .join('');
    const cache = dashboard.chunk_lookup_cache;
    return `
      <div class="rate-limit-dashboard">
        <div class="rate-limit-dashboard-title">API usage</div>
        <div class="rate-limit-dashboard-row">
          <span>${dashboard.requests_per_minute ?? dashboard.recent ?? 0} req/min</span>
          <span>${dashboard.total ?? 0} total</span>
          <span>${dashboard.rate_limited ?? 0} throttled</span>
        </div>
        ${subRows ? `<div class="rate-limit-subsystems">${subRows}</div>` : ''}
        ${cache ? `<div class="rate-limit-cache">404 cache: ${cache.missing_blob_cache} · backoff: ${cache.sync_failure_rows}</div>` : ''}
      </div>
    `;
  },

  async loadRateLimits() {
    try {
      const { accounts, api_dashboard: dashboard } = await API.accounts.rateLimits();
      this.lastRateLimits = accounts;
      this.lastApiDashboard = dashboard;
      this.renderRateLimitPanel(accounts, 'rate-limit-panel');
      this.renderRateLimitPanel(accounts, 'rate-limit-modal-panel');
      const dashEl = document.getElementById('rate-limit-dashboard');
      if (dashEl && dashboard) dashEl.innerHTML = this.renderApiDashboard(dashboard);
      return accounts;
    } catch {
      const el = document.getElementById('rate-limit-panel');
      if (el) el.innerHTML = '<div class="rate-limit-empty">Quota unavailable</div>';
      return [];
    }
  },

  initSortSelect() {
    const sel = document.getElementById('sort-select');
    if (!sel) return;
    const val = `${explorer.sort}:${explorer.sortOrder}`;
    if ([...sel.options].some((o) => o.value === val)) sel.value = val;
    sel.addEventListener('change', () => {
      const [sort, order] = sel.value.split(':');
      explorer.setSort(sort, order);
    });
  },

  async loadSidebarCounts() {
    try {
      const [fav, trash] = await Promise.all([
        API.files.favorites().catch(() => ({ files: [] })),
        API.files.trashList().catch(() => ({ files: [] })),
      ]);
      const favBadge = document.getElementById('favorites-badge');
      const trashBadge = document.getElementById('trash-badge');
      const favCount = fav.files?.length || 0;
      const trashCount = trash.files?.length || 0;
      if (favBadge) {
        favBadge.textContent = String(favCount);
        favBadge.classList.toggle('hidden', favCount === 0);
      }
      if (trashBadge) {
        trashBadge.textContent = String(trashCount);
        trashBadge.classList.toggle('hidden', trashCount === 0);
      }
    } catch { /* optional */ }
  },

  async loadStats() {
    try {
      const [stats, capacity, cacheStats] = await Promise.all([
        API.files.stats(),
        API.repos.capacity().catch(() => null),
        API.cache.stats().catch(() => null),
      ]);
      this.loadSidebarCounts();

      const el = document.getElementById('storage-info');
      const activeRepos = stats.repos.filter(r => r.is_active && !r.is_metadata);
      el.innerHTML = `
        <div>${stats.fileCount} file${stats.fileCount !== 1 ? 's' : ''}</div>
        <div>${formatSize(stats.totalSize)} in vault</div>
        <div>${activeRepos.length} storage repo${activeRepos.length !== 1 ? 's' : ''}</div>
        <div>🔒 AES-256 encrypted</div>
        ${stats.metadata_repo ? `<div class="meta-repo-label" title="Metadata & thumbnails">📋 ${stats.metadata_repo}</div>` : ''}
        ${stats.poolFull ? '<div class="pool-full-warning">⚠️ All repos full — add more repos or delete files</div>' : ''}
      `;

      if (capacity) {
        this.renderDrives(capacity);
        document.getElementById('status-size').textContent =
          capacity.total.available > 0
            ? `${formatSize(capacity.total.available)} free across pool`
            : 'Pool is full — no space available';
      }

      if (cacheStats) {
        this.lastCacheStats = cacheStats;
        this.renderCacheDisk(cacheStats);
      }

      this.gitAvailable = !!stats.gitAvailable;
      this.lastLocalUpload = LocalUpload.apply(stats.localUpload || null);
      const uploadMode = document.getElementById('upload-mode');
      const gitOption = uploadMode?.querySelector('option[value="git"]');
      if (gitOption) {
        gitOption.disabled = !this.gitAvailable;
        if (!this.gitAvailable && uploadMode.value === 'git') {
          uploadMode.value = 'api';
          UploadPrefs.set('api');
        }
      }
    } catch {
      LocalUpload.apply(null);
    }
  },

  hideCacheContextMenu() {
    document.getElementById('cache-context-menu')?.classList.add('hidden');
  },

  hidePoolContextMenu() {
    document.getElementById('pool-context-menu')?.classList.add('hidden');
  },

  showCacheContextMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    explorer.hideContextMenu();
    this.hidePoolContextMenu();
    const menu = document.getElementById('cache-context-menu');
    menu.classList.remove('hidden');
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
  },

  showPoolContextMenu(e) {
    e.preventDefault();
    e.stopPropagation();
    explorer.hideContextMenu();
    this.hideCacheContextMenu();
    const menu = document.getElementById('pool-context-menu');
    menu.classList.remove('hidden');
    menu.style.left = `${e.clientX}px`;
    menu.style.top = `${e.clientY}px`;
  },

  getRepoCapacityGb() {
    const cap = this.lastCapacity?.repos?.[0]?.capacity;
    if (cap) return Math.max(1, Math.round(cap / (1024 ** 3)));
    return 1;
  },

  updateStorageIncreaseHint() {
    const input = document.getElementById('storage-increase-gb');
    const hint = document.getElementById('storage-increase-hint');
    const capLabel = document.getElementById('storage-repo-capacity-label');
    if (!input || !hint) return;
    const capGb = this.getRepoCapacityGb();
    if (capLabel) capLabel.textContent = String(capGb);
    const gb = Math.max(1, parseInt(input.value, 10) || 1);
    const repos = Math.ceil(gb / capGb);
    hint.textContent = `Will create ${repos} new repo${repos === 1 ? '' : 's'} (~${repos * capGb} GB total). Progress appears in the task panel.`;
  },

  async populateStorageAccountSelect() {
    const select = document.getElementById('storage-increase-account');
    if (!select) return;
    select.innerHTML = '<option value="">Loading accounts…</option>';
    select.disabled = true;

    try {
      const [accountsRes, orgRes] = await Promise.all([
        API.accounts.list(),
        API.repos.org().catch(() => ({ org: null })),
      ]);
      const username = this.currentUser?.username || 'primary';
      const vaultOrg = orgRes.org;
      const primaryLabel = vaultOrg
        ? `Primary (@${username} · org ${vaultOrg})`
        : `Primary (@${username})`;

      const storageAccounts = (accountsRes.accounts || []).filter(
        (a) => isStorageAccountRole(a.role) && a.is_active,
      );

      select.innerHTML = '';
      const primaryOpt = document.createElement('option');
      primaryOpt.value = '';
      primaryOpt.textContent = primaryLabel;
      select.appendChild(primaryOpt);

      for (const account of storageAccounts) {
        const opt = document.createElement('option');
        opt.value = String(account.id);
        opt.textContent = `Linked storage · @${account.username}`;
        select.appendChild(opt);
      }

      select.disabled = false;
    } catch (err) {
      select.innerHTML = '<option value="">Failed to load accounts</option>';
      select.disabled = true;
      throw err;
    }
  },

  async openStorageIncreaseModal() {
    const modal = document.getElementById('storage-increase-modal');
    const input = document.getElementById('storage-increase-gb');
    if (!modal || !input) return;
    input.value = '5';
    try {
      await this.populateStorageAccountSelect();
    } catch (err) {
      this.toast(err.message, 'error');
    }
    this.updateStorageIncreaseHint();
    modal.classList.remove('hidden');
    input.focus();
    input.select();
  },

  async confirmStorageIncrease() {
    const input = document.getElementById('storage-increase-gb');
    const accountSelect = document.getElementById('storage-increase-account');
    const btn = document.getElementById('btn-confirm-storage-increase');
    const gb = parseFloat(input?.value);
    if (!Number.isFinite(gb) || gb <= 0) {
      this.toast('Enter a positive storage amount in GB', 'error');
      return;
    }
    if (accountSelect?.disabled) {
      this.toast('Could not load linked accounts — try again', 'error');
      return;
    }
    const linkedAccountId = accountSelect?.value
      ? parseInt(accountSelect.value, 10)
      : null;
    btn.disabled = true;
    try {
      const result = await API.repos.createBatch({ gb, linked_account_id: linkedAccountId });
      if (result.taskId) {
        TaskPanel.track(result.taskId);
        TaskPanel.setExpanded(true);
        this.toast(`Creating ${result.requested} storage repo${result.requested === 1 ? '' : 's'}…`, 'success');
      } else {
        this.toast('Repo batch started', 'success');
      }
      document.getElementById('storage-increase-modal')?.classList.add('hidden');
    } catch (err) {
      this.toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  },

  async clearCacheDisk() {
    if (!confirm('Clear the cache disk? Cached downloads will be removed; thumbnails are kept.')) return;
    try {
      const result = await API.cache.clear();
      this.toast(`Cache cleared — freed ${formatSize(result.freed)}`, 'success');
      this.loadStats();
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  renderCacheDisk(cache) {
    const el = document.getElementById('cache-drive');
    if (!el) return;

    const free = Math.max(0, cache.max - cache.used);
    const maxGb = cache.maxGb || Math.round((cache.max / (1024 ** 3)) * 10) / 10;
    el.title = 'Right-click for cache options (view files, settings, clear)';
    el.innerHTML = `
      <div class="drive-header">
        <span class="drive-icon">💿</span>
        <span class="drive-label">Cache Disk</span>
        <button type="button" class="drive-cache-settings" title="Cache settings" aria-label="Cache settings">⚙</button>
      </div>
      ${renderDriveBar(cache.percent, cache.percent)}
      <div class="drive-detail">
        ${formatSize(cache.used)} used · ${formatSize(free)} free of ${formatSize(cache.max)} (${maxGb} GB max)
      </div>
      <div class="drive-breakdown">
        <span class="drive-legend cache">${cache.entries} cached file${cache.entries !== 1 ? 's' : ''}</span>
      </div>
    `;

    applyDynamicStyles(el);

    el.querySelector('.drive-cache-settings')?.addEventListener('click', (e) => {
      e.stopPropagation();
      this.openCacheSettings(cache);
    });
  },

  openCacheSettings(cache) {
    const modal = document.getElementById('cache-settings-modal');
    const input = document.getElementById('cache-max-gb');
    const idleInput = document.getElementById('cache-idle-days');
    const usage = document.getElementById('cache-settings-usage');
    const maxGb = cache?.maxGb || Math.round(((cache?.max || 0) / (1024 ** 3)) * 10) / 10;
    if (input) input.value = maxGb || 10;
    if (idleInput) idleInput.value = String(cache?.idleRetentionDays || 30);
    if (usage && cache) {
      usage.textContent = `Currently using ${formatSize(cache.used)} of ${formatSize(cache.max)}. Unused files older than ${cache.idleRetentionDays || 30} days are removed automatically.`;
    }
    modal?.classList.remove('hidden');
  },

  cacheTypeLabel(type) {
    const labels = {
      decrypted: 'Decrypted file',
      faststart: 'Fast-start stream',
      encrypted_chunk: 'Encrypted chunk',
      thumbnail: 'Thumbnail',
      manifest: 'HLS manifest',
      lookup: 'Lookup',
    };
    return labels[type] || type;
  },

  formatCacheLastUsed(ts) {
    if (!ts) return '—';
    try {
      const date = new Date(ts);
      const diffMs = Date.now() - date.getTime();
      const mins = Math.floor(diffMs / 60000);
      if (mins < 1) return 'Just now';
      if (mins < 60) return `${mins}m ago`;
      const hours = Math.floor(mins / 60);
      if (hours < 48) return `${hours}h ago`;
      const days = Math.floor(hours / 24);
      if (days < 14) return `${days}d ago`;
      return date.toLocaleString();
    } catch {
      return '—';
    }
  },

  async openCacheFilesModal() {
    const modal = document.getElementById('cache-files-modal');
    const summary = document.getElementById('cache-files-summary');
    const list = document.getElementById('cache-files-list');
    const empty = document.getElementById('cache-files-empty');
    const table = document.getElementById('cache-files-table');
    if (!modal || !list) return;

    modal.classList.remove('hidden');
    summary.textContent = 'Loading cached files…';
    list.innerHTML = '';
    empty?.classList.add('hidden');
    table?.classList.remove('hidden');

    try {
      const data = await API.cache.listEntries();
      this.lastCacheEntries = data.entries || [];
      summary.textContent = `${data.count || 0} cached item${data.count === 1 ? '' : 's'} · ${formatSize(data.used || 0)} on disk`;
      this.renderCacheFilesList();
    } catch (err) {
      summary.textContent = 'Could not load cached files';
      this.toast(err.message, 'error');
    }
  },

  renderCacheFilesList() {
    const list = document.getElementById('cache-files-list');
    const empty = document.getElementById('cache-files-empty');
    const table = document.getElementById('cache-files-table');
    if (!list) return;

    const entries = this.lastCacheEntries || [];
    if (!entries.length) {
      list.innerHTML = '';
      empty?.classList.remove('hidden');
      table?.classList.add('hidden');
      return;
    }

    empty?.classList.add('hidden');
    table?.classList.remove('hidden');
    list.innerHTML = entries.map((entry) => `
      <tr data-cache-id="${this.escapeHtml(entry.id)}">
        <td class="cache-files-name" title="${this.escapeHtml(entry.name)}">${this.escapeHtml(entry.name)}</td>
        <td>${this.escapeHtml(this.cacheTypeLabel(entry.type))}</td>
        <td>${formatSize(entry.size)}</td>
        <td title="${entry.last_accessed ? new Date(entry.last_accessed).toLocaleString() : ''}">${this.formatCacheLastUsed(entry.last_accessed)}</td>
        <td class="cache-files-actions">
          <button type="button" class="btn-secondary btn-compact" data-remove-cache="${this.escapeHtml(entry.id)}">Remove</button>
        </td>
      </tr>
    `).join('');
  },

  async removeCacheEntry(entryId, btn) {
    if (!confirm('Remove this item from the cache disk?')) return;
    if (btn) App.setButtonLoading(btn, true);
    try {
      const result = await API.cache.removeEntry(entryId);
      this.lastCacheEntries = (this.lastCacheEntries || []).filter((e) => e.id !== entryId);
      this.renderCacheFilesList();
      const summary = document.getElementById('cache-files-summary');
      const used = (this.lastCacheEntries || []).reduce((sum, e) => sum + (e.size || 0), 0);
      if (summary) {
        summary.textContent = `${this.lastCacheEntries.length} cached item${this.lastCacheEntries.length === 1 ? '' : 's'} · ${formatSize(used)} on disk`;
      }
      this.toast(`Removed ${result.name || 'cache entry'} (${formatSize(result.freed)})`, 'success');
      await this.loadStats();
    } catch (err) {
      this.toast(err.message, 'error');
    } finally {
      if (btn) App.setButtonLoading(btn, false);
    }
  },

  async saveCacheSettings() {
    const input = document.getElementById('cache-max-gb');
    const idleInput = document.getElementById('cache-idle-days');
    const btn = document.getElementById('btn-save-cache-settings');
    const maxGb = parseFloat(input?.value);
    const idleRetentionDays = parseInt(idleInput?.value, 10);
    if (!Number.isFinite(maxGb)) {
      this.toast('Enter a valid cache size', 'error');
      return;
    }
    if (!Number.isFinite(idleRetentionDays) || idleRetentionDays < 1) {
      this.toast('Enter a valid idle retention period', 'error');
      return;
    }

    await App.withButton(btn, async () => {
      try {
        await API.cache.setConfig({ maxGb, idleRetentionDays });
        document.getElementById('cache-settings-modal')?.classList.add('hidden');
        this.toast(`Cache settings saved (${maxGb} GB max, ${idleRetentionDays} day idle cleanup)`, 'success');
        await this.loadStats();
      } catch (err) {
        this.toast(err.message, 'error');
      }
    });
  },

  async populateSettingsAccountSelect() {
    const select = document.getElementById('settings-auto-repo-account');
    if (!select) return;
    select.innerHTML = '<option value="">Loading accounts…</option>';
    select.disabled = true;

    try {
      const [accountsRes, orgRes] = await Promise.all([
        API.accounts.list(),
        API.repos.org().catch(() => ({ org: null })),
      ]);
      const username = this.currentUser?.username || 'primary';
      const vaultOrg = orgRes.org;
      const primaryLabel = vaultOrg
        ? `Primary (@${username} · org ${vaultOrg})`
        : `Primary (@${username})`;

      const storageAccounts = (accountsRes.accounts || []).filter(
        (a) => isStorageAccountRole(a.role) && a.is_active,
      );

      select.innerHTML = '';
      const primaryOpt = document.createElement('option');
      primaryOpt.value = '';
      primaryOpt.textContent = primaryLabel;
      select.appendChild(primaryOpt);

      for (const account of storageAccounts) {
        const opt = document.createElement('option');
        opt.value = String(account.id);
        opt.textContent = `Linked storage · @${account.username}`;
        select.appendChild(opt);
      }

      select.disabled = false;
    } catch (err) {
      select.innerHTML = '<option value="">Failed to load accounts</option>';
      select.disabled = true;
      throw err;
    }
  },

  updateAutoRepoHint(settings) {
    const hint = document.getElementById('settings-auto-repo-hint');
    const capGb = settings?.repo_capacity_gb || this.getRepoCapacityGb();
    const gbInput = document.getElementById('settings-auto-repo-gb');
    const intervalInput = document.getElementById('settings-auto-repo-interval');
    if (!hint) return;
    const gb = Math.max(1, parseInt(gbInput?.value, 10) || 1);
    const minutes = Math.max(1, parseInt(intervalInput?.value, 10) || 60);
    const repos = Math.ceil(gb / capGb);
    hint.textContent = `Every ${minutes} minute${minutes === 1 ? '' : 's'}, create ${repos} repo${repos === 1 ? '' : 's'} (~${repos * capGb} GB) while enabled. Runs on the server even when this tab is closed.`;
  },

  async openSettingsModal() {
    const modal = document.getElementById('settings-modal');
    if (!modal) return;
    try {
      await this.populateSettingsAccountSelect();
      const { settings } = await API.settings.get();
      this.lastSettings = settings;
      document.getElementById('settings-auto-repo-enabled').checked = !!settings.auto_repo_enabled;
      document.getElementById('settings-auto-repo-interval').value = String(settings.auto_repo_interval_minutes || 60);
      document.getElementById('settings-auto-repo-gb').value = String(settings.auto_repo_gb || 5);
      const accountSelect = document.getElementById('settings-auto-repo-account');
      if (accountSelect && settings.auto_repo_linked_account_id != null) {
        accountSelect.value = String(settings.auto_repo_linked_account_id);
      } else if (accountSelect) {
        accountSelect.value = '';
      }
      const lastRun = document.getElementById('settings-auto-repo-last-run');
      if (lastRun) {
        lastRun.textContent = settings.auto_repo_last_run_at
          ? `Last auto run: ${new Date(settings.auto_repo_last_run_at).toLocaleString()}`
          : 'Last auto run: never';
      }
      this.updateAutoRepoHint(settings);
      this.applyPlexSettingsToForm(settings);
      await this.refreshPlexIntegrationStatus();
      modal.classList.remove('hidden');
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  applyPlexSettingsToForm(settings) {
    document.getElementById('settings-plex-sync-enabled').checked = !!settings?.plex_sync_enabled;
    document.getElementById('settings-plex-library-path').value = settings?.plex_library_path || '';
    document.getElementById('settings-plex-server-url').value = settings?.plex_server_url || 'http://127.0.0.1:32400';
    const tokenField = document.getElementById('settings-plex-token');
    if (tokenField) {
      tokenField.value = '';
      tokenField.placeholder = settings?.plex_token_set
        ? `Saved (${settings.plex_token_preview}) — leave blank to keep`
        : 'Paste Plex token from View XML in Plex Web';
    }
    document.getElementById('settings-plex-sync-interval').value = String(settings?.plex_sync_interval_minutes || 30);
    const tokenHint = document.getElementById('settings-plex-token-hint');
    if (tokenHint) {
      tokenHint.textContent = settings?.plex_token_set
        ? `Token is saved (${settings.plex_token_preview}). The field stays empty for security — only paste again to replace it.`
        : 'Get your token from Plex Web → any item → View XML → X-Plex-Token in the URL';
    }
    const status = document.getElementById('settings-plex-sync-status');
    if (status) {
      let line = settings?.plex_last_sync_at
        ? `Last sync: ${new Date(settings.plex_last_sync_at).toLocaleString()}`
        : 'Last sync: never';
      if (settings?.plex_last_sync_error) line += ` · Error: ${settings.plex_last_sync_error}`;
      status.textContent = line;
    }
    this.populatePlexSectionSelect(settings?.plex_section_key || '');
  },

  populatePlexSectionSelect(selectedKey = '') {
    const select = document.getElementById('settings-plex-section-key');
    if (!select) return;
    const keep = select.value;
    select.innerHTML = '<option value="">Auto-detect on sync</option>';
    if (selectedKey) {
      const opt = document.createElement('option');
      opt.value = selectedKey;
      opt.textContent = `Library #${selectedKey}`;
      opt.selected = true;
      select.appendChild(opt);
    } else if (keep) {
      select.value = keep;
    }
  },

  readPlexSettingsPatch() {
    const tokenInput = document.getElementById('settings-plex-token')?.value?.trim();
    const patch = {
      plex_sync_enabled: document.getElementById('settings-plex-sync-enabled')?.checked,
      plex_library_path: document.getElementById('settings-plex-library-path')?.value?.trim() || null,
      plex_server_url: document.getElementById('settings-plex-server-url')?.value?.trim() || 'http://127.0.0.1:32400',
      plex_sync_interval_minutes: parseInt(document.getElementById('settings-plex-sync-interval')?.value, 10),
      plex_section_key: document.getElementById('settings-plex-section-key')?.value || null,
    };
    if (tokenInput) patch.plex_token = tokenInput;
    return patch;
  },

  async testPlexConnection() {
    const btn = document.getElementById('btn-test-plex');
    await App.withButton(btn, async () => {
      try {
        const body = {
          plex_server_url: document.getElementById('settings-plex-server-url')?.value?.trim(),
        };
        const tokenInput = document.getElementById('settings-plex-token')?.value?.trim();
        if (tokenInput) body.plex_token = tokenInput;
        const result = await API.plex.test(body);
        const select = document.getElementById('settings-plex-section-key');
        if (select && result.libraries?.length) {
          select.innerHTML = '<option value="">Auto-detect on sync</option>';
          for (const lib of result.libraries) {
            const opt = document.createElement('option');
            opt.value = lib.key;
            opt.textContent = `${lib.title} (${lib.type || 'library'})`;
            select.appendChild(opt);
          }
        }
        this.toast(`Connected to ${result.identity?.name || 'Plex'}`, 'success');
      } catch (err) {
        this.toast(err.message, 'error');
      }
    });
  },

  async syncPlexNow() {
    const btn = document.getElementById('btn-sync-plex-now');
    await App.withButton(btn, async () => {
      try {
        await this.saveSettings({ silent: true });
        const result = await API.plex.sync();
        if (result.local_sync_required) {
          this.toast(result.message || 'Use "Write to folder on this PC" — server cannot write to your C:\\ path', 'info');
          return;
        }
        const stats = result.stats || {};
        this.toast(
          `Plex synced — ${stats.files || 0} files, ${stats.playlists || 0} playlists${result.refresh ? ', library refresh started' : ''}`,
          'success',
        );
        const { settings } = await API.settings.get();
        this.applyPlexSettingsToForm(settings);
      } catch (err) {
        this.toast(err.message, 'error');
      }
    });
  },

  async continuePlexLocalSync(folderPromise, btn) {
    await App.withButton(btn, async () => {
      try {
        const folder = await folderPromise;
        App.toast('Writing STRM files to selected folder…', 'info');
        await this.saveSettings({ silent: true });
        const syncData = await API.plex.sync({ local_only: true });
        const manifest = syncData.manifest || (await API.plex.manifest()).manifest;
        const stats = syncData.stats || manifest.stats || {};
        if (!manifest?.entries?.length) {
          this.toast('Nothing to sync — add playlists in GitHub Vault first', 'info');
          return;
        }
        const written = await PlexLocalSync.applyManifest(manifest, folder);
        App.toast('Preparing streams for Plex (faststart cache)…', 'info');
        try {
          await API.plex.prewarm({});
        } catch (prewarmErr) {
          this.toast(`STRM files written; stream prewarm failed: ${prewarmErr.message}`, 'info');
        }
        try {
          await API.plex.refresh();
        } catch (refreshErr) {
          this.toast(`Wrote ${written} files. Plex refresh failed: ${refreshErr.message}`, 'info');
          return;
        }
        this.toast(`Wrote ${stats.files || written} STRM files — Plex library refresh started`, 'success');
      } catch (err) {
        if (err?.name === 'AbortError') return;
        this.toast(err.message, 'error');
      }
    });
  },

  async syncPlexToLocalFolder() {
    if (!window.PlexLocalSync?.supported()) {
      this.toast('Use Chrome or Edge on desktop to write files to a local folder', 'error');
      return;
    }
    const btn = document.getElementById('btn-sync-plex-local');
    let folderPromise;
    try {
      folderPromise = PlexLocalSync.requestFolderPicker();
    } catch (err) {
      this.toast(err.message, 'error');
      return;
    }
    await this.continuePlexLocalSync(folderPromise, btn);
  },

  async integratePlexNow() {
    const btn = document.getElementById('btn-integrate-plex');
    await App.withButton(btn, async () => {
      try {
        const tokenInput = document.getElementById('settings-plex-token')?.value?.trim();
        const libraryPath = document.getElementById('settings-plex-library-path')?.value?.trim();
        if (!libraryPath) {
          this.toast('Set the library folder path on your Plex machine first', 'error');
          return;
        }
        await this.saveSettings({ silent: true });
        const body = {
          plex_server_url: document.getElementById('settings-plex-server-url')?.value?.trim(),
          plex_library_path: libraryPath,
        };
        if (tokenInput) body.plex_token = tokenInput;
        const result = await API.plex.integrate(body);
        try {
          const localInstall = await API.plex.installAgent(body);
          if (localInstall?.success) {
            this.toast('GitHub Vault agent installed — restart Plex Media Server', 'success');
          }
        } catch (installErr) {
          if (result.remote_plex) {
            setTimeout(
              () => this.toast('On this PC run: npm run plex:install-agent', 'info'),
              600,
            );
          }
        }
        const stats = result.sync?.stats || {};
        const remoteNote = result.remote_plex ? ' Use "Write to folder on this PC" next.' : '';
        this.toast(
          `Plex integrated${stats.files ? ` — ${stats.files} files synced` : remoteNote}`,
          'success',
        );
        if (result.sync?.local_sync_required) {
          setTimeout(() => this.toast('Click "Write to folder on this PC" and select your GitHub Vault folder', 'info'), 800);
        }
        const { settings } = await API.settings.get();
        this.applyPlexSettingsToForm(settings);
        await this.refreshPlexIntegrationStatus();
      } catch (err) {
        this.toast(err.message, 'error');
      }
    });
  },

  async refreshPlexIntegrationStatus() {
    const el = document.getElementById('settings-plex-integrate-status');
    if (!el) return;
    try {
      const status = await API.plex.integrationStatus();
      const parts = [];
      if (status.plugins_installed) parts.push('Plugins installed');
      if (status.manifest?.integrated_at) {
        parts.push(`Integrated ${new Date(status.manifest.integrated_at).toLocaleString()}`);
      }
      if (status.paths?.libraryPath) parts.push(`Library: ${status.paths.libraryPath}`);
      if (status.paths?.bundledPluginsDir) parts.push('Bundled plugins patched');
      else if (status.paths?.resourcesDir) parts.push('Bundled patch path not found — set PLEX_RESOURCES_DIR');
      el.textContent = parts.length ? parts.join(' · ') : 'Not integrated yet';
    } catch {
      el.textContent = '';
    }
  },

  async saveSettings(opts = {}) {
    const btn = document.getElementById('btn-save-settings');
    const enabled = document.getElementById('settings-auto-repo-enabled')?.checked;
    const intervalMinutes = parseInt(document.getElementById('settings-auto-repo-interval')?.value, 10);
    const gb = parseInt(document.getElementById('settings-auto-repo-gb')?.value, 10);
    const linkedRaw = document.getElementById('settings-auto-repo-account')?.value;
    const linkedAccountId = linkedRaw ? parseInt(linkedRaw, 10) : null;
    const plexPatch = this.readPlexSettingsPatch();

    const run = async () => {
      try {
        const { settings, autoRepoTaskId } = await API.settings.update({
          auto_repo_enabled: enabled,
          auto_repo_interval_minutes: intervalMinutes,
          auto_repo_gb: gb,
          auto_repo_linked_account_id: linkedAccountId,
          ...plexPatch,
        });
        this.lastSettings = settings;
        this.updateAutoRepoHint(settings);
        this.applyPlexSettingsToForm(settings);
        const lastRun = document.getElementById('settings-auto-repo-last-run');
        if (lastRun) {
          lastRun.textContent = settings.auto_repo_last_run_at
            ? `Last auto run: ${new Date(settings.auto_repo_last_run_at).toLocaleString()}`
            : 'Last auto run: never';
        }
        if (settings.auto_repo_enabled && autoRepoTaskId) {
          TaskPanel.track(autoRepoTaskId);
          TaskPanel.setExpanded(true);
        } else if (!settings.auto_repo_enabled && this.currentUser?.id) {
          TaskPanel.removeLocal(`auto-repo-${this.currentUser.id}`);
          TaskPanel.stopCountdownTick();
        }
        if (!opts.silent) this.toast('Settings saved', 'success');
      } catch (err) {
        this.toast(err.message, 'error');
        throw err;
      }
    };

    if (opts.silent) return run();
    return App.withButton(btn, run);
  },

  handleSettingsQuickAction(action) {
    document.getElementById('settings-modal')?.classList.add('hidden');
    if (action === 'cache') {
      if (this.lastCacheStats) this.openCacheSettings(this.lastCacheStats);
      else this.toast('Cache stats not loaded yet — try again', 'error');
      return;
    }
    if (action === 'local-upload') {
      document.getElementById('local-upload-modal')?.classList.remove('hidden');
      return;
    }
    if (action === 'repos') {
      this.showRepoModal();
      return;
    }
    if (action === 'increase-storage') {
      void this.openStorageIncreaseModal();
    }
  },

  renderRepoDriveItem(repo) {
    const isFull = repo.is_full || repo.available <= 0;
    return `
      <div class="drive-item ${repo.is_active ? '' : 'drive-inactive'} ${repo.is_metadata ? 'drive-metadata' : ''} ${isFull ? 'drive-full' : ''}">
        <div class="drive-header">
          <span class="drive-icon">${repo.is_metadata ? '📋' : '📀'}</span>
          <span class="drive-label" title="${repo.full_name}">${repo.is_metadata ? 'Metadata' : repo.name}${isFull ? ' <span class="full-badge">Full</span>' : ''}</span>
        </div>
        ${repo.is_metadata
          ? '<div class="drive-detail">Manifests, keys & thumbnails</div>'
          : `${renderDriveBar(repo.vault_percent, repo.used_percent)}
             <div class="drive-detail">${formatSize(repo.vault_used || 0)} used · ${formatSize(repo.available)} free of ${formatSize(repo.capacity)}${isFull ? ' — FULL' : ''}</div>`}
      </div>
    `;
  },

  renderStorageRepos() {
    const el = document.getElementById('repo-drives-storage');
    if (!el || !this.lastCapacity) return;
    const repos = this.lastCapacity.repos.filter((r) => !r.is_metadata);
    el.innerHTML = repos.length
      ? repos.map((repo) => this.renderRepoDriveItem(repo)).join('')
      : '<div class="drive-empty">No storage repos</div>';
    applyDynamicStyles(el);
    el.dataset.loaded = '1';
  },

  renderMetadataRepos() {
    const el = document.getElementById('repo-drives-metadata');
    if (!el || !this.lastCapacity) return;
    const repos = this.lastCapacity.repos.filter((r) => r.is_metadata);
    el.innerHTML = repos.length
      ? repos.map((repo) => this.renderRepoDriveItem(repo)).join('')
      : '<div class="drive-empty">No metadata repo</div>';
    applyDynamicStyles(el);
    el.dataset.loaded = '1';
  },

  updateRepoSidebarCounts() {
    const storageCount = document.getElementById('storage-repos-count');
    const metadataCount = document.getElementById('metadata-repos-count');
    if (!this.lastCapacity) return;
    const storage = this.lastCapacity.repos.filter((r) => !r.is_metadata);
    const metadata = this.lastCapacity.repos.filter((r) => r.is_metadata);
    if (storageCount) storageCount.textContent = storage.length ? `(${storage.length})` : '';
    if (metadataCount) metadataCount.textContent = metadata.length ? `(${metadata.length})` : '';
  },

  setRepoSectionExpanded(kind, expanded) {
    const isStorage = kind === 'storage';
    const toggle = document.getElementById(isStorage ? 'storage-repos-toggle' : 'metadata-repos-toggle');
    const body = document.getElementById(isStorage ? 'repo-drives-storage' : 'repo-drives-metadata');
    if (!toggle || !body) return;

    if (isStorage) this.storageReposExpanded = expanded;
    else this.metadataReposExpanded = expanded;

    toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    toggle.classList.toggle('expanded', expanded);
    body.classList.toggle('hidden', !expanded);
    body.hidden = !expanded;

    if (expanded) {
      if (isStorage) this.renderStorageRepos();
      else this.renderMetadataRepos();
    }
  },

  bindRepoSidebar() {
    const storageToggle = document.getElementById('storage-repos-toggle');
    const metadataToggle = document.getElementById('metadata-repos-toggle');
    if (!storageToggle || storageToggle.dataset.bound) return;
    storageToggle.dataset.bound = '1';

    storageToggle.addEventListener('click', () => {
      this.setRepoSectionExpanded('storage', !this.storageReposExpanded);
    });
    metadataToggle.addEventListener('click', () => {
      this.setRepoSectionExpanded('metadata', !this.metadataReposExpanded);
    });
  },

  renderDrives(capacity) {
    const totalEl = document.getElementById('total-drive');
    const t = capacity.total;
    this.lastCapacity = capacity;

    totalEl.title = 'Right-click to increase storage';
    totalEl.innerHTML = `
      <div class="drive-header">
        <span class="drive-icon">💾</span>
        <span class="drive-label">GitHub Vault Pool</span>
      </div>
      ${renderDriveBar(t.vault_percent, t.used_percent)}
      <div class="drive-detail">
        ${formatSize(t.available)} free of ${formatSize(t.capacity)}
      </div>
      <div class="drive-breakdown">
        <span class="drive-legend vault">Vault ${formatSize(t.vault_used)}</span>
        <span class="drive-legend other">Other ${formatSize(t.other_used)}</span>
      </div>
    `;

    applyDynamicStyles(totalEl);

    this.updateRepoSidebarCounts();

    const storageEl = document.getElementById('repo-drives-storage');
    const metadataEl = document.getElementById('repo-drives-metadata');
    if (storageEl?.dataset.loaded === '1' && this.storageReposExpanded) this.renderStorageRepos();
    if (metadataEl?.dataset.loaded === '1' && this.metadataReposExpanded) this.renderMetadataRepos();
  },

  bindEvents() {
    document.getElementById('btn-logout').addEventListener('click', async () => {
      await API.auth.logout();
      this.showLogin();
    });

    document.getElementById('btn-upload').addEventListener('click', () => {
      this.openUploadPicker();
    });

    document.getElementById('btn-seamless-upload')?.addEventListener('click', () => {
      this.openUploadPicker('seamless');
    });

    document.getElementById('file-input').addEventListener('change', (e) => {
      const mode = this.pendingUploadMode;
      this.pendingUploadMode = null;
      this.uploadFiles(e.target.files, mode);
      e.target.value = '';
    });

    document.getElementById('verify-file-input')?.addEventListener('change', (e) => {
      VerifyRepair.onFileSelected(e.target);
    });

    document.getElementById('btn-new-folder').addEventListener('click', () => this.openFolderModal());

    document.getElementById('upload-mode')?.addEventListener('change', (e) => {
      UploadPrefs.set(e.target.value);
    });

    document.getElementById('btn-create-folder').addEventListener('click', () => this.createFolder());
    document.getElementById('folder-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.createFolder();
    });

    document.getElementById('btn-download').addEventListener('click', () => {
      App.withButton(document.getElementById('btn-download'), () => explorer.downloadSelected());
    });
    document.getElementById('btn-move').addEventListener('click', () => {
      explorer.showMoveDialog([...explorer.selected]);
    });
    document.getElementById('btn-share')?.addEventListener('click', () => {
      const id = [...explorer.selected][0];
      if (!id) return;
      const file = explorer.files.find((f) => f.id === id)
        || explorer.contextTarget
        || explorer.treeFoldersById?.get(id);
      if (!file) return;
      App.shareFile(file);
    });
    document.getElementById('btn-confirm-move').addEventListener('click', () => explorer.confirmMove());
    document.getElementById('btn-delete').addEventListener('click', () => explorer.deleteSelected());
    document.getElementById('btn-selection-actions')?.addEventListener('click', (e) => {
      e.stopPropagation();
      explorer.toggleSelectionActionsMenu();
    });
    document.getElementById('selection-actions-wrap')?.addEventListener('click', (e) => {
      e.stopPropagation();
    });
    document.getElementById('selection-actions-menu')?.addEventListener('click', (e) => {
      const action = e.target?.closest('[data-bulk-action]')?.dataset?.bulkAction;
      if (!action) return;
      const item = e.target.closest('[data-bulk-action]');
      if (!item || item.disabled) return;
      e.stopPropagation();
      explorer.runBulkAction(action);
    });
    document.addEventListener('click', (e) => {
      if (e.target.closest('#selection-actions-wrap')) return;
      explorer.hideSelectionActionsMenu();
    });
    document.getElementById('btn-restore')?.addEventListener('click', () => explorer.restoreSelected());
    document.getElementById('btn-permanent-delete')?.addEventListener('click', () => explorer.permanentDeleteSelected());
    document.getElementById('btn-refresh').addEventListener('click', () => {
      App.withButton(document.getElementById('btn-refresh'), () => App.refreshAll());
    });

    // Search
    const searchToggle = document.getElementById('btn-search');
    const searchInput = document.getElementById('search-input');
    let searchTimeout;
    if (searchToggle && searchInput) {
      searchToggle.addEventListener('click', () => {
        const hidden = searchInput.classList.toggle('hidden');
        searchToggle.textContent = hidden ? '🔍' : '✕';
        if (hidden) { searchInput.value = ''; explorer.navigate(explorer.currentPath, { search: '', viewMode: explorer.viewMode }); }
        else searchInput.focus();
      });
      searchInput.addEventListener('input', () => {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => {
          explorer.navigate(explorer.currentPath, { search: searchInput.value || '', viewMode: 'files', type: explorer.filterType });
        }, 200);
      });
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          searchInput.value = '';
          searchInput.classList.add('hidden');
          searchToggle.textContent = '🔍';
          explorer.navigate(explorer.currentPath, { search: '', viewMode: explorer.viewMode });
        }
      });
    }

    // View toggle (grid/list)
    const viewToggle = document.getElementById('btn-view-toggle');
    if (viewToggle) {
      function applyViewMode(mode) {
        const grid = document.getElementById('file-grid');
        const isList = mode === 'list';
        if (grid) grid.classList.toggle('file-grid-list', isList);
        viewToggle.textContent = isList ? '☰' : '⊞';
        localStorage.setItem('vault-view-mode', mode);
      }
      viewToggle.addEventListener('click', () => {
        const current = localStorage.getItem('vault-view-mode') || 'grid';
        applyViewMode(current === 'list' ? 'grid' : 'list');
        VirtualGrid?.reset?.();
        explorer.render();
        VirtualGrid?.scheduleUpdate?.();
      });
      // Restore on load
      const saved = localStorage.getItem('vault-view-mode');
      if (saved) applyViewMode(saved);
    }

    document.getElementById('btn-back').addEventListener('click', () => explorer.goBack());
    document.getElementById('btn-up').addEventListener('click', () => explorer.goUp());

    document.getElementById('btn-viewers')?.addEventListener('click', () => this.showViewersPanel());
    document.getElementById('btn-repos').addEventListener('click', () => this.showRepoModal());
    document.getElementById('btn-settings')?.addEventListener('click', () => this.openSettingsModal());
    document.getElementById('btn-save-settings')?.addEventListener('click', () => this.saveSettings());
    document.getElementById('btn-test-plex')?.addEventListener('click', () => this.testPlexConnection());
    document.getElementById('btn-integrate-plex')?.addEventListener('click', () => this.integratePlexNow());
    document.getElementById('btn-sync-plex-now')?.addEventListener('click', () => this.syncPlexNow());
    document.getElementById('settings-modal')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-settings-action]');
      if (!btn) return;
      this.handleSettingsQuickAction(btn.dataset.settingsAction);
    });
    document.getElementById('settings-auto-repo-gb')?.addEventListener('input', () => {
      this.updateAutoRepoHint(this.lastSettings);
    });
    document.getElementById('settings-auto-repo-interval')?.addEventListener('input', () => {
      this.updateAutoRepoHint(this.lastSettings);
    });
    document.getElementById('backup-sync-force')?.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const accountId = this.lastBackupSync?.find((s) => !s.up_to_date || s.paused)?.account_id || null;
      await App.withButton(e.currentTarget, () => App.forceBackupSync(accountId));
    });

    document.getElementById('account-view')?.addEventListener('change', async (e) => {
      explorer.accountView = e.target.value || 'primary';
      const isPrimary = explorer.accountView === 'primary';
      document.getElementById('btn-upload')?.toggleAttribute('disabled', !isPrimary);
      document.getElementById('btn-seamless-upload')?.toggleAttribute('disabled', !isPrimary);
      document.getElementById('file-input')?.toggleAttribute('disabled', !isPrimary);
      await explorer.navigate(explorer.currentPath);
      this.loadAccountViews();
    });
    document.getElementById('btn-regenerate-bitbucket-links')?.addEventListener('click', () => {
      this.updateBitbucketLinkUrls();
    });
    document.getElementById('btn-regenerate-codeberg-links')?.addEventListener('click', () => {
      this.updateCodebergLinkUrls();
    });
    document.getElementById('btn-regenerate-pastebin-links')?.addEventListener('click', () => {
      this.updatePastebinLinkUrls();
    });
    document.querySelectorAll('[data-copy-target]').forEach((btn) => {
      btn.addEventListener('click', () => this.copyTextFromElement(btn.dataset.copyTarget));
    });
    document.getElementById('btn-setup-vault-org')?.addEventListener('click', () => this.setupVaultOrg());
    document.getElementById('btn-clear-vault-org')?.addEventListener('click', () => this.clearVaultOrg());
    document.getElementById('vault-org-select')?.addEventListener('change', (e) => {
      const nameInput = document.getElementById('vault-org-name');
      if (nameInput && e.target.value) nameInput.value = e.target.value;
    });

    document.querySelectorAll('[data-close]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.getElementById(btn.dataset.close).classList.add('hidden');
      });
    });

    document.querySelectorAll('.modal').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.classList.add('hidden');
      });
    });

    FileHistory?.init?.();

    document.getElementById('cache-drive')?.addEventListener('contextmenu', (e) => {
      this.showCacheContextMenu(e);
    });

    document.getElementById('total-drive')?.addEventListener('contextmenu', (e) => {
      this.showPoolContextMenu(e);
    });

    document.getElementById('pool-context-menu')?.addEventListener('click', (e) => {
      const action = e.target.dataset.action;
      if (!action) return;
      this.hidePoolContextMenu();
      if (action === 'increase-storage') this.openStorageIncreaseModal();
    });

    document.getElementById('storage-increase-gb')?.addEventListener('input', () => {
      this.updateStorageIncreaseHint();
    });

    document.getElementById('btn-confirm-storage-increase')?.addEventListener('click', () => {
      this.confirmStorageIncrease();
    });

    document.getElementById('cache-context-menu')?.addEventListener('click', (e) => {
      const action = e.target.dataset.action;
      if (!action) return;
      this.hideCacheContextMenu();
      if (action === 'cache-files') this.openCacheFilesModal();
      if (action === 'clear-cache') this.clearCacheDisk();
      if (action === 'cache-settings') this.openCacheSettings(this.lastCacheStats);
    });

    document.getElementById('cache-files-list')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-remove-cache]');
      if (!btn) return;
      this.removeCacheEntry(btn.dataset.removeCache, btn);
    });

    document.getElementById('btn-save-cache-settings')?.addEventListener('click', () => {
      this.saveCacheSettings();
    });

    document.getElementById('btn-local-upload')?.addEventListener('click', () => {
      LocalUpload.openModal();
    });
    document.getElementById('local-upload-ribbon')?.addEventListener('click', () => {
      LocalUpload.openModal();
    });
    document.getElementById('local-upload-status')?.addEventListener('click', () => {
      LocalUpload.openModal();
    });
    document.getElementById('btn-save-local-upload')?.addEventListener('click', async () => {
      const input = document.getElementById('local-upload-ipv4');
      const btn = document.getElementById('btn-save-local-upload');
      if (btn) App.setButtonLoading(btn, true);
      try {
        const status = await LocalUpload.save(input?.value?.trim() || '');
        this.lastLocalUpload = status;
        App.toast(status.configuredIpv4 ? `LAN IP saved: ${status.configuredIpv4}` : 'LAN IP cleared', 'success');
        document.getElementById('local-upload-modal')?.classList.add('hidden');
      } catch (err) {
        App.toast(err.message || 'Save failed', 'error');
      } finally {
        if (btn) App.setButtonLoading(btn, false);
      }
    });
    document.getElementById('btn-clear-local-upload')?.addEventListener('click', async () => {
      const input = document.getElementById('local-upload-ipv4');
      if (input) input.value = '';
      try {
        const status = await LocalUpload.save('');
        this.lastLocalUpload = status;
        App.toast('LAN IP cleared', 'success');
      } catch (err) {
        App.toast(err.message || 'Clear failed', 'error');
      }
    });

    document.getElementById('btn-create-api-key')?.addEventListener('click', () => this.createApiKey());

    document.getElementById('api-key-name')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.createApiKey();
    });

    document.getElementById('api-keys-list')?.addEventListener('click', (e) => {
      const revokeId = e.target.closest('[data-revoke-api-key]')?.dataset.revokeApiKey;
      if (revokeId) this.revokeApiKey(revokeId);
      const copyVal = e.target.closest('[data-copy-value]')?.dataset.copyValue;
      if (copyVal) this.copyText(copyVal);
    });

    document.getElementById('btn-refresh-agents')?.addEventListener('click', () => this.loadAgents());
    document.getElementById('btn-save-site-access-key')?.addEventListener('click', () => this.saveSiteAccessKey());
    document.getElementById('btn-disable-site-access-key')?.addEventListener('click', () => this.disableSiteAccessKey());
    document.getElementById('btn-use-env-site-access-key')?.addEventListener('click', () => this.useEnvSiteAccessKey());
    document.getElementById('agents-list')?.addEventListener('click', (e) => {
      const saveBtn = e.target.closest('.agent-save-config');
      if (saveBtn) {
        this.saveAgentConfig(saveBtn.dataset.agent);
        return;
      }
      const removeBtn = e.target.closest('.agent-remove');
      if (removeBtn) {
        this.removeAgent(removeBtn.dataset.agent);
        return;
      }
      const addBtn = e.target.closest('.agent-add-folder');
      if (addBtn) {
        const container = document.querySelector(`[data-agent-folders="${addBtn.dataset.agent}"]`);
        const empty = container?.querySelector('.agent-folder-empty');
        if (empty) empty.remove();
        const row = document.createElement('div');
        row.className = 'agent-folder-row';
        row.dataset.agent = addBtn.dataset.agent;
        row.innerHTML = `
          <input class="agent-folder-name" type="text" placeholder="Name">
          <input class="agent-folder-path" type="text" placeholder="Local folder path">
          <button type="button" class="btn-secondary agent-remove-folder">Remove</button>
        `;
        container?.appendChild(row);
        return;
      }
      const removeFolderBtn = e.target.closest('.agent-remove-folder');
      if (removeFolderBtn) {
        removeFolderBtn.closest('.agent-folder-row')?.remove();
      }
    });

    document.getElementById('context-menu').addEventListener('click', (e) => {
      e.stopPropagation();
      const item = e.target.closest('[data-action]');
      const action = item?.dataset?.action;
      if (!action) return;
      const mode = explorer.contextMode;
      explorer.hideContextMenu();

      if (mode === 'blank') {
        if (action === 'new-folder') this.openFolderModal();
        if (action === 'new-playlist') Playlists.openCreatePlaylistModal();
        if (action === 'new-collection') Playlists.openCreateCollectionModal();
        if (action === 'upload') this.openUploadPicker();
        if (action === 'upload-seamless') this.openUploadPicker('seamless');
        if (action === 'refresh-view') App.refreshAll();
        return;
      }

      const file = explorer.contextTarget;
      if (!file) return;

      if (action === 'open' && file.is_folder) explorer.openItem(file);
      if (action === 'preview' && !file.is_folder) {
        API.files.accessed(file.id).catch(() => {});
        if (explorer.viewMode === 'playlist-detail' && file._inPlaylist) {
          explorer.openItem(file);
        } else {
          Viewer.open(file);
        }
      }
      if (action === 'rename') explorer.startRename(file);
      if (action === 'details') App.showDetails(file);
      if (action === 'view-history') App.showFileHistory(file);
      if (action === 'share') App.shareFile(file);
      if (action === 'download' && !file.is_folder) explorer.downloadFile(file);
      if (action === 'move') explorer.showMoveDialog([...explorer.selected]);
      if (action === 'refresh-thumb') {
        const targets = explorer.getActionTargets(file).filter((f) => !f.is_folder);
        if (targets.length > 1) explorer.refreshThumbnailsSelected();
        else if (!file.is_folder) explorer.refreshThumbnail(file);
      }
      if (action === 'upload-thumb') {
        const targets = explorer.getActionTargets(file).filter((f) => !f.is_folder);
        if (targets.length > 1) explorer.uploadThumbnailSelected();
        else if (!file.is_folder) ThumbUpload.runForFile(file);
      }
      if (action === 'verify-file' && !file.is_folder) explorer.verifyFileSelected();
      if (action === 'verify-hls') explorer.verifyHlsSelected();
      if (action === 'hls-convert') explorer.hlsConvertSelected();
      if (action === 'favorite') explorer.toggleFavorite(file);
      if (action === 'add-to-playlist' && !file.is_folder) {
        const ids = explorer.selected.size ? [...explorer.selected] : [file.id];
        Playlists.promptAddToPlaylist(ids);
      }
      if (action === 'link-folder-to-playlist' && file.is_folder) {
        const folderId = file.id;
        Playlists.promptLinkFolderToPlaylist(folderId);
      }
      if (action === 'restore') explorer.restoreFile(file);
      if (action === 'permanent-delete') {
        explorer.selected.clear();
        explorer.selected.add(file.id);
        explorer.permanentDeleteSelected();
      }
      if (action === 'delete') {
        explorer.selected.clear();
        explorer.selected.add(file.id);
        explorer.deleteSelected();
      }
    });

    document.getElementById('filter-chips')?.addEventListener('click', (e) => {
      const chip = e.target.closest('.filter-chip');
      if (!chip) return;
      if (chip.dataset.all) {
        explorer.applyFilter('all');
        return;
      }
      if (chip.dataset.view) {
        explorer.applyFilter(chip.dataset.view);
        return;
      }
      if (chip.dataset.type) {
        explorer.applyFilter(chip.dataset.type);
      }
    });

    document.addEventListener('click', () => {
      explorer.hideContextMenu();
      this.hideCacheContextMenu();
      this.hidePoolContextMenu();
    });

    const fileView = document.getElementById('file-view');
    const dropOverlay = document.getElementById('drop-overlay');

    fileView.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.file-item')) return;
      explorer.showBlankContextMenu(e);
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'F2' || explorer.selected.size !== 1) return;
      const id = [...explorer.selected][0];
      const file = explorer.files.find((entry) => entry.id === id);
      if (file && !file.pending) {
        e.preventDefault();
        explorer.startRename(file);
      }
    });

    fileView.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('application/x-vault-move')) return;
      e.preventDefault();
      dropOverlay.classList.remove('hidden');
    });

    fileView.addEventListener('dragleave', (e) => {
      if (!fileView.contains(e.relatedTarget)) dropOverlay.classList.add('hidden');
    });

    async function traverseEntry(entry, files, basePath = '') {
      if (entry.isFile) {
        return new Promise((resolve) => {
          entry.file((f) => {
            f._relativePath = basePath ? basePath + '/' + f.name : f.name;
            files.push(f);
            resolve();
          });
        });
      }
      if (entry.isDirectory) {
        const reader = entry.createReader();
        const readAll = () => new Promise((res) => {
          const all = [];
          const read = () => reader.readEntries((entries) => {
            if (entries.length === 0) return res(all);
            all.push(...entries);
            read();
          });
          read();
        });
        const entries = await readAll();
        for (const child of entries) {
          await traverseEntry(child, files, basePath ? basePath + '/' + entry.name : entry.name);
        }
      }
    }

    fileView.addEventListener('drop', async (e) => {
      if (e.dataTransfer.types.includes('application/x-vault-move')) return;
      e.preventDefault();
      dropOverlay.classList.add('hidden');

      const items = e.dataTransfer.items;
      if (items?.[0]?.webkitGetAsEntry) {
        const files = [];
        for (let i = 0; i < items.length; i++) {
          const entry = items[i].webkitGetAsEntry();
          if (entry) await traverseEntry(entry, files);
        }
        if (files.length) {
          this.uploadFiles(files);
          return;
        }
      }

      if (e.dataTransfer.files.length) this.uploadFiles(e.dataTransfer.files);
    });

    document.addEventListener('paste', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (document.getElementById('app')?.classList.contains('hidden')) return;
      const items = e.clipboardData?.items;
      if (!items?.length) return;
      const files = [];
      for (const item of items) {
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) {
        e.preventDefault();
        this.uploadFiles(files);
      }
    });

    this.bindSidebarNav();

    document.getElementById('share-copy').addEventListener('click', () => {
      const input = document.getElementById('share-url');
      input.select();
      navigator.clipboard.writeText(input.value).then(() => App.toast('Link copied', 'success'));
    });

    const shareClientToggle = document.getElementById('share-client-stream');
    if (shareClientToggle) {
      shareClientToggle.addEventListener('change', async (e) => {
        try {
          await API.files.setShareSettings(e.target.checked);
          this.toast(
            e.target.checked ? 'Share links will decrypt in the browser' : 'Share links will stream via server',
            'success'
          );
        } catch (err) {
          e.target.checked = !e.target.checked;
          this.toast(err.message, 'error');
        }
      });
    }
  },

  startViewersBadgePoll() {
    const update = async () => {
      if (LiveViewers.active) return;
      try {
        const data = await API.viewers.live();
        const badge = document.getElementById('viewers-badge');
        const total = data?.totalViewers || 0;
        if (badge) {
          badge.textContent = String(total);
          badge.classList.toggle('hidden', total === 0);
        }
      } catch { /* ignore */ }
    };
    update();
    if (this.viewersBadgeTimer) clearInterval(this.viewersBadgeTimer);
    this.viewersBadgeTimer = setInterval(update, 30000);
  },

  bindSidebarNav() {
    if (this._sidebarNavBound) return;
    const sidebar = document.querySelector('.main-content .sidebar');
    if (!sidebar) return;
    this._sidebarNavBound = true;
    sidebar.addEventListener('click', (e) => {
      const item = e.target.closest('.sidebar-item[data-view]');
      if (!item) return;
      this.onSidebarViewClick(item);
    });
  },

  onSidebarViewClick(item) {
    const view = item.dataset.view;
    if (view === 'viewers') {
      this.showViewersPanel();
      return;
    }
    if (view === 'bandwidth') {
      this.showBandwidthPanel();
      return;
    }
    if (view === 'api-keys') {
      this.showApiKeysPanel();
      return;
    }
    if (view === 'agents') {
      this.showAgentsPanel();
      return;
    }
    if (view === 'site-access') {
      this.showSiteAccessPanel();
      return;
    }
    this.activeUtilityView = null;
    if (view === 'favorites') {
      this.showFavoritesPanel();
      return;
    }
    if (view === 'recent') {
      this.showRecentPanel();
      return;
    }
    if (view === 'discover') {
      explorer.navigate('/', { viewMode: 'discover', type: null, search: '', playlistId: null, collectionId: null });
      return;
    }
    if (view === 'playlists') {
      explorer.navigate('/', { viewMode: 'playlists', type: null, search: '', playlistId: null, collectionId: null });
      return;
    }
    if (view === 'collections') {
      explorer.navigate('/', { viewMode: 'collections', type: null, search: '', playlistId: null, collectionId: null });
      return;
    }
    if (view === 'trash') {
      this.showTrashPanel();
      return;
    }
    this.showFilesPanel('files');
    if (item.dataset.path) {
      explorer.pushHistory(item.dataset.path);
      explorer.navigate(item.dataset.path, { viewMode: 'files', type: null, search: '' });
    } else {
      explorer.navigate('/', { viewMode: 'files', type: null, search: '' });
    }
  },

  hideUtilityPanels() {
    document.getElementById('viewers-panel')?.classList.add('hidden');
    document.getElementById('bandwidth-tab')?.classList.add('hidden');
    document.getElementById('api-keys-tab')?.classList.add('hidden');
    document.getElementById('agents-tab')?.classList.add('hidden');
    document.getElementById('site-access-tab')?.classList.add('hidden');
  },

  showViewersPanel() {
    LiveViewers.show();
  },

  showBandwidthPanel() {
    this.activeUtilityView = 'bandwidth';
    LiveViewers.hide();
    document.getElementById('file-view')?.classList.add('hidden');
    this.hideUtilityPanels();
    document.getElementById('bandwidth-tab')?.classList.remove('hidden');
    document.querySelectorAll('.sidebar-item[data-view]').forEach((el) => {
      el.classList.toggle('active', el.dataset.view === 'bandwidth');
    });
    BandwidthPanel.show();
  },

  showApiKeysPanel: function () {
    this.activeUtilityView = 'api-keys';
    LiveViewers.hide();
    BandwidthPanel.hide();
    document.getElementById('file-view')?.classList.add('hidden');
    this.hideUtilityPanels();
    document.getElementById('api-keys-tab')?.classList.remove('hidden');
    document.querySelectorAll('.sidebar-item[data-view]').forEach((el) => {
      el.classList.toggle('active', el.dataset.view === 'api-keys');
    });
    this.loadApiKeys();
  },

  showAgentsPanel() {
    this.activeUtilityView = 'agents';
    LiveViewers.hide();
    BandwidthPanel.hide();
    document.getElementById('file-view')?.classList.add('hidden');
    this.hideUtilityPanels();
    document.getElementById('agents-tab')?.classList.remove('hidden');
    document.querySelectorAll('.sidebar-item[data-view]').forEach((el) => {
      el.classList.toggle('active', el.dataset.view === 'agents');
    });
    this.loadAgents();
  },

  showSiteAccessPanel() {
    this.activeUtilityView = 'site-access';
    LiveViewers.hide();
    BandwidthPanel.hide();
    document.getElementById('file-view')?.classList.add('hidden');
    this.hideUtilityPanels();
    document.getElementById('site-access-tab')?.classList.remove('hidden');
    document.querySelectorAll('.sidebar-item[data-view]').forEach((el) => {
      el.classList.toggle('active', el.dataset.view === 'site-access');
    });
    this.loadSiteAccessSettings();
  },

  showFavoritesPanel() {
    explorer.navigate('/', { viewMode: 'favorites', type: null, search: '', playlistId: null, collectionId: null });
  },

  showRecentPanel() {
    explorer.navigate('/', { viewMode: 'recent', type: null, search: '', playlistId: null, collectionId: null });
  },

  showTrashPanel() {
    explorer.navigate('/', { viewMode: 'trash', type: null, search: '', playlistId: null, collectionId: null });
  },

  showFilesPanel(activeView = 'files') {
    this.activeUtilityView = null;
    LiveViewers.hide();
    BandwidthPanel.hide();
    document.getElementById('file-view')?.classList.remove('hidden');
    this.hideUtilityPanels();
    document.querySelectorAll('.sidebar-item[data-view]').forEach((el) => {
      el.classList.toggle('active', el.dataset.view === activeView);
    });
    this.updateCuratedRibbon();
  },

  updateCuratedRibbon() {
    const vm = explorer?.viewMode;
    const plBtn = document.getElementById('btn-new-playlist');
    const colBtn = document.getElementById('btn-new-collection');
    const sortSel = document.getElementById('sort-select');
    if (plBtn) plBtn.classList.toggle('hidden', vm !== 'playlists' && vm !== 'playlist-detail');
    if (colBtn) colBtn.classList.toggle('hidden', vm !== 'collections' && vm !== 'collection-detail');
    if (sortSel) {
      const playlistOrder = vm === 'playlist-detail';
      sortSel.disabled = playlistOrder;
      sortSel.title = playlistOrder ? 'Playlist uses custom episode order' : 'Sort files';
      sortSel.classList.toggle('sort-select-disabled', playlistOrder);
    }
  },

  escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  },

  async loadApiKeys() {
    const list = document.getElementById('api-keys-list');
    if (!list) return;
    list.innerHTML = '<div class="api-key-empty">Loading API keys...</div>';
    try {
      const { keys } = await API.auth.apiKeys();
      this.apiKeysLoaded = true;
      list.innerHTML = keys.length ? keys.map((key) => this.renderApiKeyRow(key)).join('') : '<div class="api-key-empty">No API keys yet. Create one for the desktop client.</div>';
    } catch (err) {
      list.innerHTML = `<div class="api-key-empty error">${this.escapeHtml(err.message)}</div>`;
    }
  },

  renderApiKeyRow(key) {
    const revoked = !!key.revoked_at;
    const created = key.created_at ? new Date(key.created_at).toLocaleString() : 'Unknown';
    const lastUsed = key.last_used_at ? new Date(key.last_used_at).toLocaleString() : 'Never';
    const fullKey = key.key_secret || key.key || '';
    const keyDisplay = fullKey
      ? `<div class="api-key-copy-row"><input class="api-key-value" type="text" readonly value="${this.escapeHtml(fullKey)}" spellcheck="false"><button type="button" class="btn-secondary" data-copy-value="${this.escapeHtml(fullKey)}">Copy</button></div>`
      : `<span class="api-key-missing">Key not stored — create a new key to see the full value</span>`;
    return `
      <div class="api-key-row ${revoked ? 'revoked' : ''}">
        <div class="api-key-main">
          <strong>${this.escapeHtml(key.name)}</strong>
          ${keyDisplay}
          <span>created ${this.escapeHtml(created)} · last used ${this.escapeHtml(lastUsed)}</span>
          ${revoked ? '<span class="api-key-revoked">Revoked</span>' : ''}
        </div>
        <button type="button" class="btn-secondary" data-revoke-api-key="${key.id}" ${revoked ? 'disabled' : ''}>Revoke</button>
      </div>
    `;
  },

  async createApiKey() {
    const input = document.getElementById('api-key-name');
    const btn = document.getElementById('btn-create-api-key');
    const name = input?.value?.trim() || 'Vault Upload Client';
    await App.withButton(btn, async () => {
      try {
        const { key } = await API.auth.createApiKey(name);
        const newBox = document.getElementById('api-key-new');
        const value = document.getElementById('api-key-new-value');
        const command = document.getElementById('api-key-client-command');
        const serverUrl = window.location.origin;
        value.value = key.key;
        command.textContent = `npm run client -- auth --url ${serverUrl} --api-key ${key.key}`;
        newBox.classList.remove('hidden');
        input.value = '';
        this.toast('API key created.', 'success');
        await this.loadApiKeys();
      } catch (err) {
        this.toast(err.message, 'error');
      }
    });
  },

  async revokeApiKey(id) {
    if (!confirm('Revoke this API key? Clients using it will stop working.')) return;
    try {
      await API.auth.revokeApiKey(id);
      this.toast('API key revoked', 'success');
      await this.loadApiKeys();
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  async loadSiteAccessSettings() {
    const statusEl = document.getElementById('site-access-admin-status');
    const hintEl = document.getElementById('site-access-admin-hint');
    const envBtn = document.getElementById('btn-use-env-site-access-key');
    const input = document.getElementById('site-access-admin-key');
    if (!statusEl) return;
    statusEl.innerHTML = '<div class="api-key-empty">Loading site access settings...</div>';
    try {
      const { site_access: sa } = await API.settings.siteAccess();
      const active = sa.required;
      const statusClass = active ? 'site-access-status-on' : 'site-access-status-off';
      const statusLabel = active ? 'Protection enabled' : 'Protection disabled';
      const hint = sa.key_hint ? `Current key ends in ${this.escapeHtml(sa.key_hint.slice(-2))}` : 'No key configured';
      let sourceNote = '';
      if (sa.source === 'environment') {
        sourceNote = 'Using SITE_ACCESS_KEY from environment.';
      } else if (sa.source === 'database') {
        sourceNote = 'Key saved in vault settings.';
      } else if (sa.explicitly_disabled) {
        sourceNote = 'Protection disabled in vault settings.';
      }
      statusEl.innerHTML = `
        <div class="site-access-status-card ${statusClass}">
          <strong>${this.escapeHtml(statusLabel)}</strong>
          <span>${this.escapeHtml(hint)}</span>
          ${sourceNote ? `<span class="site-access-source-note">${this.escapeHtml(sourceNote)}</span>` : ''}
        </div>
      `;
      if (hintEl) {
        hintEl.textContent = 'Enter a new 6-digit key and save. Disable turns off protection even if SITE_ACCESS_KEY is set in .env.';
      }
      if (envBtn) {
        envBtn.classList.toggle('hidden', !(sa.explicitly_disabled && sa.env_fallback_available));
      }
      if (input) input.value = '';
    } catch (err) {
      statusEl.innerHTML = `<div class="api-key-empty error">${this.escapeHtml(err.message)}</div>`;
    }
  },

  async saveSiteAccessKey() {
    const input = document.getElementById('site-access-admin-key');
    const btn = document.getElementById('btn-save-site-access-key');
    const key = input?.value?.trim() || '';
    if (!/^\d{6}$/.test(key)) {
      this.toast('Access key must be exactly 6 digits', 'error');
      return;
    }
    await App.withButton(btn, async () => {
      try {
        await API.settings.setSiteAccess({ key });
        this.toast('Site access key saved', 'success');
        await this.loadSiteAccessSettings();
      } catch (err) {
        this.toast(err.message, 'error');
      }
    });
  },

  async disableSiteAccessKey() {
    if (!confirm('Disable site access protection? Login and share links will not require a key.')) return;
    const btn = document.getElementById('btn-disable-site-access-key');
    await App.withButton(btn, async () => {
      try {
        await API.settings.setSiteAccess({ enabled: false });
        this.toast('Site access protection disabled', 'success');
        await this.loadSiteAccessSettings();
      } catch (err) {
        this.toast(err.message, 'error');
      }
    });
  },

  async useEnvSiteAccessKey() {
    const btn = document.getElementById('btn-use-env-site-access-key');
    await App.withButton(btn, async () => {
      try {
        await API.settings.setSiteAccess({ use_environment: true });
        this.toast('Using SITE_ACCESS_KEY from environment', 'success');
        await this.loadSiteAccessSettings();
      } catch (err) {
        this.toast(err.message, 'error');
      }
    });
  },

  async loadAgents() {
    const list = document.getElementById('agents-list');
    if (!list) return;
    list.innerHTML = '<div class="api-key-empty">Loading agents...</div>';
    try {
      const { agents } = await API.agents.list();
      if (!agents.length) {
        list.innerHTML = '<div class="api-key-empty">No sync clients connected yet. Start Vault Sync with an API key to register an agent.</div>';
        return;
      }
      list.innerHTML = agents.map((agent) => this.renderAgentCard(agent)).join('');
    } catch (err) {
      list.innerHTML = `<div class="api-key-empty error">${this.escapeHtml(err.message)}</div>`;
    }
  },

  renderAgentCard(agent) {
    const cfg = agent.desired_config || agent.reported_config || {};
    const syncRoot = cfg.syncRootPath || '';
    const convertHls = cfg.convertHlsEnabled !== false;
    const extra = Array.isArray(cfg.additionalSyncFolders) ? cfg.additionalSyncFolders : [];
    const lastSeen = agent.last_seen_at ? new Date(agent.last_seen_at).toLocaleString() : 'Never';
    const statusClass = agent.status === 'online' ? 'agent-online' : 'agent-offline';
    const extraRows = extra.map((f, i) => `
      <div class="agent-folder-row" data-agent="${agent.id}" data-folder-id="${this.escapeHtml(f.id || '')}" data-folder-index="${i}">
        <input class="agent-folder-name" type="text" value="${this.escapeHtml(f.name || '')}" placeholder="Name">
        <input class="agent-folder-path" type="text" value="${this.escapeHtml(f.localPath || '')}" placeholder="Local folder path">
        <button type="button" class="btn-secondary agent-remove-folder" data-agent="${agent.id}" data-folder-index="${i}">Remove</button>
      </div>
    `).join('');
    return `
      <div class="agent-card" data-agent-id="${agent.id}">
        <div class="agent-card-header">
          <div>
            <strong>${this.escapeHtml(agent.name || 'Sync client')}</strong>
            <span class="agent-meta">${this.escapeHtml(agent.hostname || '')} · ${this.escapeHtml(agent.platform || '')} · ${this.escapeHtml(agent.version || '')}</span>
          </div>
          <span class="agent-status ${statusClass}">${this.escapeHtml(agent.status)}</span>
        </div>
        <div class="agent-meta">Last seen: ${this.escapeHtml(lastSeen)}</div>
        <label class="agent-field-label">Main sync folder</label>
        <input class="agent-sync-root" type="text" value="${this.escapeHtml(syncRoot)}" placeholder="C:\\Users\\you\\GitHub Vault">
        <label class="plan-checkbox agent-hls-toggle">
          <input type="checkbox" class="agent-convert-hls" ${convertHls ? 'checked' : ''}>
          Convert uploaded videos to HLS (mp4, mkv, mov, etc.)
        </label>
        <div class="agent-folders-header">
          <span>Additional sync folders</span>
          <button type="button" class="btn-secondary agent-add-folder" data-agent="${agent.id}">Add folder</button>
        </div>
        <div class="agent-folders" data-agent-folders="${agent.id}">
          ${extraRows || '<div class="agent-folder-empty">No additional folders</div>'}
        </div>
        <div class="agent-actions">
          <button type="button" class="btn-primary agent-save-config" data-agent="${agent.id}">Save & push to client</button>
          <button type="button" class="btn-secondary agent-remove" data-agent="${agent.id}">Remove agent</button>
        </div>
      </div>
    `;
  },

  collectAgentConfig(agentId) {
    const card = document.querySelector(`.agent-card[data-agent-id="${agentId}"]`);
    if (!card) return null;
    const syncRootPath = card.querySelector('.agent-sync-root')?.value?.trim() || '';
    const folders = [];
    card.querySelectorAll('.agent-folder-row').forEach((row) => {
      const localPath = row.querySelector('.agent-folder-path')?.value?.trim();
      if (!localPath) return;
      const name = row.querySelector('.agent-folder-name')?.value?.trim() || localPath.split(/[/\\]/).pop();
      folders.push({
        id: row.dataset.folderId || crypto.randomUUID(),
        name,
        localPath,
        enabled: true,
      });
    });
    return { syncRootPath, convertHlsEnabled: !!card.querySelector('.agent-convert-hls')?.checked, additionalSyncFolders: folders };
  },

  async saveAgentConfig(agentId) {
    const config = this.collectAgentConfig(agentId);
    if (!config) return;
    try {
      await API.agents.saveConfig(agentId, config);
      this.toast('Agent config saved — client will apply on next heartbeat', 'success');
      await this.loadAgents();
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  async removeAgent(agentId) {
    if (!confirm('Remove this agent from the list? The client can register again later.')) return;
    try {
      await API.agents.remove(agentId);
      this.toast('Agent removed', 'success');
      await this.loadAgents();
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  openFolderModal() {
    document.getElementById('folder-modal').classList.remove('hidden');
    document.getElementById('folder-name').value = '';
    document.getElementById('folder-name').focus();
  },

  async runWithConcurrency(tasks, limit) {
    const results = new Array(tasks.length);
    let idx = 0;
    const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (true) {
        const i = idx++;
        if (i >= tasks.length) break;
        try {
          results[i] = { ok: true, value: await tasks[i]() };
        } catch (err) {
          results[i] = { ok: false, error: err };
        }
      }
    });
    await Promise.all(workers);
    return results;
  },

  openUploadPicker(mode = null) {
    this.pendingUploadMode = mode === 'seamless' ? 'seamless' : null;
    document.getElementById('file-input')?.click();
  },

  async uploadFiles(fileList, modeOverride = null) {
    const files = [...fileList];
    if (!files.length) return;

    const forcedMode = modeOverride === 'seamless' ? 'seamless' : null;
    const uploadMode = forcedMode || UploadPrefs.get();
    const specs = [];

    for (const file of files) {
      let chunkSize = 921600;
      let mode = uploadMode;
      let convertHls = false;
      let uploadAccountIds = null;
      const isVideo = API.isVideoFile(file.name, file.type);
      if (file.size > 100 * 1024 * 1024 || isVideo) {
        const confirmed = await this.showUploadPlan(file, { defaultMode: uploadMode });
        if (!confirmed) continue;
        chunkSize = confirmed.chunkSize;
        mode = confirmed.uploadMode || uploadMode;
        convertHls = confirmed.convertHls || false;
        uploadAccountIds = confirmed.uploadAccountIds || null;
      }
      specs.push({ file, chunkSize, mode, convertHls, uploadAccountIds });
    }

    if (!specs.length) return;

    const results = await this.runWithConcurrency(
      specs.map((s) => () => this.uploadSingleFile(s.file, s.chunkSize, s.mode, s.convertHls, s.uploadAccountIds)),
      2
    );
    const failed = results.filter((r) => r && !r.ok);
    if (failed.length) {
      this.toast(`${failed.length} of ${specs.length} upload(s) failed`, 'error');
    }
    await this.loadStats();
  },

  chunkSizeFromMbInput(input) {
    const MB = 1024 * 1024;
    const maxMb = parseFloat(input.max) || 95;
    const minMb = parseFloat(input.min) || 0.064;
    const mb = parseFloat(input.value);
    const clamped = Math.min(maxMb, Math.max(minMb, Number.isFinite(mb) ? mb : 0.9));
    return Math.round(clamped * MB);
  },

  defaultUploadAccountSelection(targets) {
    const view = explorer?.accountView || 'primary';
    if (view.startsWith('storage:')) {
      const id = view.split(':')[1];
      if (targets.some((t) => t.id === id)) return [id];
    }
    return targets.map((t) => t.id);
  },

  getSelectedUploadAccountIds() {
    const checked = [...document.querySelectorAll('#plan-upload-accounts-list input[type="checkbox"]:checked')]
      .map((el) => el.value);
    return checked.length ? checked : null;
  },

  renderUploadAccountChoices(targets, onChange) {
    const wrap = document.getElementById('plan-upload-accounts');
    const list = document.getElementById('plan-upload-accounts-list');
    if (!wrap || !list) return;
    if (!targets || targets.length <= 1) {
      wrap.classList.add('hidden');
      list.innerHTML = '';
      return;
    }
    wrap.classList.remove('hidden');
    const selected = new Set(this.defaultUploadAccountSelection(targets));
    list.innerHTML = targets.map((t) => `
      <label class="plan-account-choice">
        <input type="checkbox" value="${this.escapeHtml(t.id)}" ${selected.has(t.id) ? 'checked' : ''}>
        <span>${this.escapeHtml(t.label)}</span>
        <span class="plan-account-meta">${t.repoCount} repo${t.repoCount === 1 ? '' : 's'}</span>
      </label>
    `).join('');
    list.querySelectorAll('input[type="checkbox"]').forEach((input) => {
      input.addEventListener('change', () => {
        if (!list.querySelector('input[type="checkbox"]:checked')) input.checked = true;
        onChange?.();
      });
    });
  },

  async showUploadPlan(file, { defaultMode = UploadPrefs.get() } = {}) {
    const self = this;
    return new Promise((resolve) => {
      const modal = document.getElementById('upload-plan-modal');
      const chunkInput = document.getElementById('plan-chunk-size');
      const body = document.getElementById('plan-body');
      const GB = 1024 * 1024 * 1024;

      const modeSelect = document.getElementById('plan-upload-mode');
      const gitAvailable = App.gitAvailable !== false;
      const initialMode = defaultMode === 'seamless'
        ? 'seamless'
        : (defaultMode === 'git' && gitAvailable ? 'git' : UploadPrefs.get());

      const isVideo = API.isVideoFile(file.name, file.type);
      const hlsCheck = document.getElementById('plan-hls-convert');
      const hlsLabel = document.getElementById('plan-hls-label');
      const hlsHint = document.getElementById('plan-hls-hint');
      if (hlsLabel) hlsLabel.classList.toggle('hidden', !isVideo);
      if (hlsCheck) hlsCheck.checked = false;
      if (hlsHint) hlsHint.classList.add('hidden');

      let uploadTargets = [];

      const render = async () => {
        const cs = self.chunkSizeFromMbInput(chunkInput);
        const selectedMode = modeSelect?.value || initialMode;
        const convertHls = !!(hlsCheck?.checked && isVideo);
        const uploadAccountIds = self.getSelectedUploadAccountIds();
        try {
          const plan = await API.files.plan(file.size, cs, {
            convertHls,
            mimeType: file.type || null,
            fileName: file.name,
            uploadAccountIds,
          });
          if (plan.maxChunkMb) {
            chunkInput.max = String(plan.maxChunkMb);
          }
          const storageBlocked = plan.insufficientSpace || plan.allFull;
          const confirmBtn = document.getElementById('plan-confirm');
          if (confirmBtn) {
            confirmBtn.disabled = storageBlocked;
            confirmBtn.title = storageBlocked
              ? 'Not enough storage for this upload'
              : '';
          }
          body.innerHTML = `
            <p><strong>${file.name}</strong> — ${formatSize(file.size)}</p>
            ${storageBlocked
              ? `<p class="plan-error">⚠️ ${plan.insufficientSpace && plan.convertHls
                ? `Not enough storage for the encrypted file and HLS segments `
                  + `(~${formatSize(plan.totalStorageBytes)} needed, `
                  + `${formatSize(plan.storageAvailableBytes)} free).`
                : 'All storage repositories are full (reached 1 GB limit). Add more repos or delete files before uploading.'}</p>`
              : ''}
            <div class="plan-grid">
              <div><span class="plan-label">Chunks</span><span>${plan.totalChunks}</span></div>
              <div><span class="plan-label">Chunk size</span><span>${plan.chunkSizeMb} MB</span></div>
              <div><span class="plan-label">Repos</span><span>${plan.repoCount}</span></div>
              <div><span class="plan-label">Est. time</span><span>${plan.estimatedTime}</span></div>
            </div>
            ${plan.convertHls ? `<div class="plan-grid">
              <div><span class="plan-label">Encrypted file</span><span>${formatSize(plan.uploadBytesEstimate)}</span></div>
              <div><span class="plan-label">HLS segments</span><span>~${formatSize(plan.hlsBytesEstimate)}</span></div>
              <div><span class="plan-label">Total storage</span><span>~${formatSize(plan.totalStorageBytes)}</span></div>
              <div><span class="plan-label">Pool free</span><span>${formatSize(plan.storageAvailableBytes)}</span></div>
            </div>` : ''}
            <p class="plan-note">GitHub Contents API limit: ${plan.githubMaxMb} MB per stored file.</p>
            ${App.lastLocalUpload?.active
              ? '<p class="plan-note plan-local-on">⚡ Local upload is ON — this file will stream to the server over your LAN.</p>'
              : App.lastLocalUpload?.configuredIpv4 && App.lastLocalUpload?.localUrl
                ? `<p class="plan-note">⚡ Faster uploads on this network: open <a href="${App.lastLocalUpload.localUrl}">${App.lastLocalUpload.localUrl.replace(/^https?:\/\//, '')}</a> (saved LAN IP ${App.lastLocalUpload.configuredIpv4}).</p>`
                : App.lastLocalUpload?.onLan && App.lastLocalUpload?.localUrl
                  ? `<p class="plan-note">⚡ For faster uploads, open <a href="${App.lastLocalUpload.localUrl}">${App.lastLocalUpload.localUrl.replace(/^https?:\/\//, '')}</a> on this device.</p>`
                  : '<p class="plan-note">⚡ Using a domain? Click <strong>LAN</strong> in the ribbon to save your server IPv4 for faster uploads.</p>'}
            <p class="plan-note">Upload method: <strong>${selectedMode === 'seamless'
              ? 'Seamless Upload — stream to server cache, auto encrypt/upload/HLS with retry'
              : selectedMode === 'git' ? 'Git clone & push' : 'API chunks (resumable)'}</strong></p>
            ${selectedMode === 'seamless'
              ? '<p class="plan-note">Seamless uses 16 MB parallel parts to the server; encryption chunk size above applies to GitHub storage.</p>'
              : ''}
            ${plan.repoCount > 0 ? `<h4>Distribution</h4>
            <div class="plan-repos">${Object.entries(plan.perRepo).map(([r, n]) =>
              `<div class="plan-repo-row"><span>${r}</span><span>${n} chunks</span></div>`
            ).join('')}</div>
            ${plan.distributionTruncated ? '<p class="plan-note">Showing summary — chunks round-robin across repos.</p>' : ''}` : ''}
          `;
        } catch (e) {
          body.innerHTML = `<p class="plan-error">${e.message}</p>`;
        }
      };

      API.files.uploadTargets()
        .then((data) => {
          uploadTargets = data.targets || [];
          self.renderUploadAccountChoices(uploadTargets, render);
          render();
        })
        .catch(() => {
          self.renderUploadAccountChoices([], render);
        });

      if (hlsCheck) {
        hlsCheck.onchange = () => {
          if (hlsHint) hlsHint.classList.toggle('hidden', !hlsCheck.checked);
          render();
        };
      }

      if (modeSelect) {
        modeSelect.value = initialMode;
        const gitOption = modeSelect.querySelector('option[value="git"]');
        if (gitOption) gitOption.disabled = !gitAvailable;
        modeSelect.onchange = render;
      }

      chunkInput.value = file.size > 2 * GB ? '4' : '0.9';
      modal.classList.remove('hidden');
      render();
      chunkInput.oninput = render;

      const cleanup = () => {
        modal.classList.add('hidden');
        document.getElementById('plan-cancel').onclick = null;
        document.getElementById('plan-confirm').onclick = null;
      };

      document.getElementById('plan-cancel').onclick = () => { cleanup(); resolve(null); };
      document.getElementById('plan-confirm').onclick = () => {
        const cs = self.chunkSizeFromMbInput(chunkInput);
        const uploadMode = modeSelect?.value || initialMode;
        const convertHls = !!(hlsCheck?.checked && isVideo);
        const uploadAccountIds = self.getSelectedUploadAccountIds();
        if (uploadMode !== 'seamless') UploadPrefs.set(uploadMode);
        cleanup();
        resolve({ chunkSize: cs, uploadMode, convertHls, uploadAccountIds });
      };
    });
  },

  async uploadSingleFile(file, chunkSize, uploadMode = 'api', convertHls = false, uploadAccountIds = null) {
    const pendingId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    App.beginUploadActivity();

    const placeholder = {
      id: pendingId, name: file.name, is_folder: 0, size: file.size,
      pending: true, uploadPercent: 0, uploadStatus: 'Starting...',
    };
    explorer.files.push(placeholder);
    explorer.render();

    try {
      console.log('[uploadSingleFile] calling upload with convertHls=', convertHls);
      await API.files.upload(
        file, explorer.currentPath, chunkSize, convertHls, (job) => {
        const pct = job.percent || 0;
        let status = 'Processing...';
        if (job.uploadMode === 'seamless') {
          if (job.phase === 'receiving' && job.seamlessPartsTotal) {
            status = `Caching ${job.seamlessPartsDone || 0}/${job.seamlessPartsTotal} on server`;
          } else if (job.phase === 'processing') {
            status = 'Server processing (encrypt & upload)...';
          } else if (job.phase === 'upload' && job.chunksTotal) {
            status = `Server uploading ${job.chunksDone || 0}/${job.chunksTotal}`;
          } else if (job.phase === 'hls-convert') {
            status = 'Converting to HLS on server...';
          } else if (job.phase === 'metadata' || job.phase === 'thumbnail') {
            status = 'Finalizing...';
          }
        } else if (job.phase === 'encrypt') status = 'Encrypting...';
        else if (job.phase === 'git-push') status = 'Pushing via git...';
        else if (job.phase === 'upload' && job.chunksTotal) {
          status = `Chunk ${job.chunksDone}/${job.chunksTotal}`;
          if (job.currentRepo) status += ` → ${job.currentRepo.split('/').pop()}`;
        } else if (job.phase === 'metadata') status = 'Saving metadata...';

        explorer.updatePendingProgress(pendingId, pct, status);
        if (job.id) TaskPanel.tasks.set(job.id, job);
        TaskPanel.render();
      }, uploadMode, uploadAccountIds);

      explorer.files = explorer.files.filter((f) => f.id !== pendingId);
      await explorer.refresh({ filesOnly: true });
    } catch (err) {
      explorer.files = explorer.files.filter((f) => f.id !== pendingId);
      explorer.render();
      this.toast(`Upload interrupted: ${err?.message || String(err) || 'unknown error'}. Resume from Background tasks.`, 'error');
    } finally {
      App.endUploadActivity();
    }
  },

  async showDetails(file) {
    const modal = document.getElementById('details-modal');
    const body = document.getElementById('details-body');
    const view = explorer?.accountView || 'primary';
    modal.classList.remove('hidden');
    body.innerHTML = '<div class="details-loading">Loading...</div>';

    try {
      const d = await API.files.details(file.id, view);
      const viewInfo = d.view && d.view.type !== 'primary'
        ? `<span>Account view</span><span>${d.view.label} (${d.view.chunks_available}/${d.view.chunks_total} chunks)</span>`
        : '';
      const chunkCountLabel = d.view && d.view.type !== 'primary'
        ? `${d.view.chunks_available} / ${d.view.chunks_total}`
        : String(d.file.chunk_count);
      body.innerHTML = `
        <div class="details-section">
          <h3>${d.file.name}</h3>
          <div class="details-grid">
            <span>Path</span><span>${d.file.path}</span>
            ${viewInfo}
            <span>Size</span><span>${formatSize(d.file.size)}</span>
            <span>Type</span><span>${d.file.mime_type || 'unknown'}</span>
            <span>Chunks</span><span>${chunkCountLabel}</span>
            ${d.file.has_hls || d.file.hls_segment_count ? `
            <span>HLS</span><span>${d.file.has_hls ? 'Ready' : 'Incomplete'} — ${d.file.hls_segment_count} segment(s)${d.file.hls_duration_sec ? `, ${explorer.formatHlsDuration(d.file.hls_duration_sec)}` : ''}${d.file.hls_min_segments > 1 ? ` (expected ≥${d.file.hls_min_segments})` : ''}</span>
            ` : ''}
            <span>Encryption</span><span>${d.file.encryption_mode || 'chunk'}</span>
            <span>Created</span><span>${new Date(d.file.created_at).toLocaleString()}</span>
          </div>
        </div>
        <div class="details-section">
          <h4>Repos used${d.view && d.view.type !== 'primary' ? ` (${d.view.label})` : ''}</h4>
          ${Object.keys(d.repos_used).length
    ? Object.entries(d.repos_used).map(([r, n]) => `<div class="plan-repo-row"><span>${r}</span><span>${n} chunks</span></div>`).join('')
    : '<p class="plan-error">No chunks in this account view.</p>'}
        </div>
        <div class="details-section details-chunks">
          <h4>Chunk map${d.view && d.view.type !== 'primary' ? ` — ${d.view.label}` : ''}</h4>
          ${d.chunks.length ? `
          <table class="chunk-table">
            <thead><tr><th>#</th><th>Repo</th><th>Path</th><th>Size</th><th>SHA</th></tr></thead>
            <tbody>${d.chunks.map(c => `
              <tr>
                <td>${c.index}</td>
                <td>${c.repo}</td>
                <td class="mono">${c.path}</td>
                <td>${formatSize(c.plain_size)}</td>
                <td class="mono sha-cell">${(c.sha || '').slice(0, 8)}…</td>
              </tr>`).join('')}
            </tbody>
          </table>` : '<p class="plan-error">No chunks stored for this account view.</p>'}
        </div>
      `;
    } catch (err) {
      body.innerHTML = `<p class="plan-error">${err.message}</p>`;
    }
  },

  showFileHistory(file) {
    if (!file) return;
    if (typeof FileHistory === 'undefined') {
      this.toast('File history script failed to load. Hard-refresh the page (Ctrl+F5).', 'error');
      return;
    }
    const isFolder = !!(file.is_folder === true || file.is_folder === 1 || file.is_folder === '1');
    if (isFolder) {
      if (FileHistory.openFolder) {
        FileHistory.openFolder(file);
      } else if (FileHistory.open) {
        FileHistory.open(file);
      } else {
        this.toast('Folder history requires a hard refresh (Ctrl+F5).', 'error');
      }
      return;
    }
    if (FileHistory.open) {
      FileHistory.open(file);
      return;
    }
    const modal = document.getElementById('file-history-modal');
    if (!modal) {
      this.toast('File history UI is missing. Hard-refresh the page (Ctrl+F5).', 'error');
      return;
    }
    this.toast('File history script failed to load. Hard-refresh the page (Ctrl+F5).', 'error');
  },

  async shareFile(file) {
    try {
      const [result, settings] = await Promise.all([
        API.files.share(file.id),
        API.files.shareSettings().catch(() => ({ client_stream: true })),
      ]);
      const isFolder = !!(file.is_folder === true || file.is_folder === 1 || file.is_folder === '1');
      const titleEl = document.querySelector('#share-modal h2');
      const descEl = document.querySelector('#share-modal .modal-desc');
      if (titleEl) titleEl.textContent = isFolder ? 'Share folder' : 'Share file';
      if (descEl) {
        descEl.textContent = isFolder
          ? 'Anyone with this link can browse and download files in this folder.'
          : 'Anyone with this link can view or download the file.';
      }
      document.getElementById('share-url').value = result.url;
      const toggle = document.getElementById('share-client-stream');
      if (toggle) toggle.checked = !!settings.client_stream;
      document.getElementById('share-modal').classList.remove('hidden');
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  async createFolder() {
    const name = document.getElementById('folder-name').value.trim();
    if (!name) return;

    const btn = document.getElementById('btn-create-folder');
    App.setButtonLoading(btn, true);

    try {
      await API.files.createFolder(name, explorer.currentPath);
      document.getElementById('folder-modal').classList.add('hidden');
      this.toast(`Created folder "${name}"`, 'success');
      await this.refreshAll();
    } catch (err) {
      this.toast(err.message, 'error');
    } finally {
      App.setButtonLoading(btn, false);
    }
  },

  updateSetupUrls(providerConfig = null) {
    const origin = window.location.origin;
    const callbacks = providerConfig?.oauth_callbacks || providerConfig || null;
    const githubCallback = callbacks?.github || `${origin}/auth/github/callback`;
    const bitbucketCallback = callbacks?.bitbucket || `${origin}/auth/bitbucket/callback`;
    const codebergCallback = callbacks?.codeberg || `${origin}/auth/codeberg/callback`;
    const pastebinLink = callbacks?.pastebin || `${origin}/auth/pastebin/link`;
    const setText = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    };
    setText('setup-homepage-url', providerConfig?.app_url || origin);
    setText('setup-callback-url', githubCallback);
    setText('repo-setup-callback-url', githubCallback);
    setText('bitbucket-setup-callback-url', bitbucketCallback);
    setText('codeberg-setup-callback-url', codebergCallback);
    setText('pastebin-setup-link-url', pastebinLink);
  },

  async fetchProviderConfig() {
    try {
      return await API.accounts.providers();
    } catch {
      return null;
    }
  },

  setBitbucketLinkPanelState({ configured, message = '' }) {
    const bbPanel = document.getElementById('bitbucket-link-panel');
    const bbStorageInput = document.getElementById('link-url-bitbucket-storage');
    const bbBackupInput = document.getElementById('link-url-bitbucket-backup');
    const bbExpiryEl = document.getElementById('bitbucket-link-url-expiry');
    const bbStatusEl = document.getElementById('bitbucket-link-status');
    bbPanel?.classList.remove('hidden');
    if (bbStatusEl) {
      bbStatusEl.textContent = message;
      bbStatusEl.classList.toggle('hidden', !message);
    }
    if (!configured) {
      const hint = message || 'Set BITBUCKET_CLIENT_ID and BITBUCKET_CLIENT_SECRET in the server .env, then restart the vault.';
      if (bbStorageInput) {
        bbStorageInput.value = '';
        bbStorageInput.placeholder = hint;
      }
      if (bbBackupInput) {
        bbBackupInput.value = '';
        bbBackupInput.placeholder = hint;
      }
      if (bbExpiryEl) bbExpiryEl.textContent = '';
    }
  },

  async updateBitbucketLinkUrls(providerConfig = null) {
    const bbStorageInput = document.getElementById('link-url-bitbucket-storage');
    const bbBackupInput = document.getElementById('link-url-bitbucket-backup');
    const bbExpiryEl = document.getElementById('bitbucket-link-url-expiry');
    if (!bbStorageInput || !bbBackupInput) return;

    bbStorageInput.value = 'Generating one-time link…';
    bbBackupInput.value = 'Generating one-time link…';
    bbStorageInput.placeholder = '';
    bbBackupInput.placeholder = '';

    try {
      const config = providerConfig || await this.fetchProviderConfig();
      if (config) this.updateSetupUrls(config);

      const providers = Object.fromEntries((config?.providers || []).map((p) => [p.id, p]));
      const bitbucketConfigured = !!providers.bitbucket?.configured;

      if (!bitbucketConfigured) {
        this.setBitbucketLinkPanelState({
          configured: false,
          message: 'Bitbucket OAuth is not configured on this server — add BITBUCKET_CLIENT_ID and BITBUCKET_CLIENT_SECRET to .env and restart.',
        });
        return;
      }

      const [bbStorage, bbBackup] = await Promise.all([
        API.accounts.createLinkToken('storage', 'bitbucket'),
        API.accounts.createLinkToken('backup', 'bitbucket'),
      ]);

      bbStorageInput.value = bbStorage.url || '';
      bbBackupInput.value = bbBackup.url || '';
      if (!bbStorage.url || !bbBackup.url) {
        throw new Error('Bitbucket link response missing URL — check server logs');
      }

      this.setBitbucketLinkPanelState({
        configured: true,
        message: 'Copy a link below, open it in a private window, and approve Bitbucket access. Do not use the raw Bitbucket authorize URL.',
      });
      if (bbExpiryEl) {
        bbExpiryEl.textContent = `Each Bitbucket link works once and expires in ${bbStorage.expires_in_minutes} minutes.`;
      }
    } catch (err) {
      bbStorageInput.value = '';
      bbBackupInput.value = '';
      bbStorageInput.placeholder = err.message || 'Failed to generate Bitbucket link';
      bbBackupInput.placeholder = err.message || 'Failed to generate Bitbucket link';
      this.setBitbucketLinkPanelState({
        configured: true,
        message: `Could not generate Bitbucket links: ${err.message}`,
      });
      this.toast(err.message, 'error');
    }
  },

  setCodebergLinkPanelState({ configured, message = '' }) {
    const panel = document.getElementById('codeberg-link-panel');
    const storageInput = document.getElementById('link-url-codeberg-storage');
    const backupInput = document.getElementById('link-url-codeberg-backup');
    const expiryEl = document.getElementById('codeberg-link-url-expiry');
    const statusEl = document.getElementById('codeberg-link-status');
    panel?.classList.remove('hidden');
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.classList.toggle('hidden', !message);
    }
    if (!configured) {
      const hint = message || 'Set CODEBERG_CLIENT_ID and CODEBERG_CLIENT_SECRET in the server .env, then restart the vault.';
      if (storageInput) {
        storageInput.value = '';
        storageInput.placeholder = hint;
      }
      if (backupInput) {
        backupInput.value = '';
        backupInput.placeholder = hint;
      }
      if (expiryEl) expiryEl.textContent = '';
    }
  },

  async updateCodebergLinkUrls(providerConfig = null) {
    const storageInput = document.getElementById('link-url-codeberg-storage');
    const backupInput = document.getElementById('link-url-codeberg-backup');
    const expiryEl = document.getElementById('codeberg-link-url-expiry');
    if (!storageInput || !backupInput) return;

    storageInput.value = 'Generating one-time link…';
    backupInput.value = 'Generating one-time link…';
    storageInput.placeholder = '';
    backupInput.placeholder = '';

    try {
      const config = providerConfig || await this.fetchProviderConfig();
      if (config) this.updateSetupUrls(config);

      const providers = Object.fromEntries((config?.providers || []).map((p) => [p.id, p]));
      const codebergConfigured = !!providers.codeberg?.configured;

      if (!codebergConfigured) {
        this.setCodebergLinkPanelState({
          configured: false,
          message: 'Codeberg OAuth is not configured on this server — add CODEBERG_CLIENT_ID and CODEBERG_CLIENT_SECRET to .env and restart.',
        });
        return;
      }

      const [cbStorage, cbBackup] = await Promise.all([
        API.accounts.createLinkToken('storage', 'codeberg'),
        API.accounts.createLinkToken('backup', 'codeberg'),
      ]);

      storageInput.value = cbStorage.url || '';
      backupInput.value = cbBackup.url || '';
      if (!cbStorage.url || !cbBackup.url) {
        throw new Error('Codeberg link response missing URL — check server logs');
      }

      this.setCodebergLinkPanelState({
        configured: true,
        message: 'Copy a link below, open it in a private window, and approve Codeberg access.',
      });
      if (expiryEl) {
        expiryEl.textContent = `Each Codeberg link works once and expires in ${cbStorage.expires_in_minutes} minutes.`;
      }
    } catch (err) {
      storageInput.value = '';
      backupInput.value = '';
      storageInput.placeholder = err.message || 'Failed to generate Codeberg link';
      backupInput.placeholder = err.message || 'Failed to generate Codeberg link';
      this.setCodebergLinkPanelState({
        configured: true,
        message: `Could not generate Codeberg links: ${err.message}`,
      });
      this.toast(err.message, 'error');
    }
  },

  setPastebinLinkPanelState({ configured, message = '' }) {
    const panel = document.getElementById('pastebin-link-panel');
    const storageInput = document.getElementById('link-url-pastebin-storage');
    const backupInput = document.getElementById('link-url-pastebin-backup');
    const expiryEl = document.getElementById('pastebin-link-url-expiry');
    const statusEl = document.getElementById('pastebin-link-status');
    panel?.classList.remove('hidden');
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.classList.toggle('hidden', !message);
    }
    if (!configured) {
      const hint = message || 'Set PASTEBIN_DEV_KEY in the server .env, then restart the vault.';
      if (storageInput) {
        storageInput.value = '';
        storageInput.placeholder = hint;
      }
      if (backupInput) {
        backupInput.value = '';
        backupInput.placeholder = hint;
      }
      if (expiryEl) expiryEl.textContent = '';
    }
  },

  async updatePastebinLinkUrls(providerConfig = null) {
    const storageInput = document.getElementById('link-url-pastebin-storage');
    const backupInput = document.getElementById('link-url-pastebin-backup');
    const expiryEl = document.getElementById('pastebin-link-url-expiry');
    if (!storageInput || !backupInput) return;

    storageInput.value = 'Generating one-time link…';
    backupInput.value = 'Generating one-time link…';
    storageInput.placeholder = '';
    backupInput.placeholder = '';

    try {
      const config = providerConfig || await this.fetchProviderConfig();
      if (config) this.updateSetupUrls(config);

      const providers = Object.fromEntries((config?.providers || []).map((p) => [p.id, p]));
      const pastebinConfigured = !!providers.pastebin?.configured;

      if (!pastebinConfigured) {
        this.setPastebinLinkPanelState({
          configured: false,
          message: 'Pastebin API is not configured — add PASTEBIN_DEV_KEY to .env and restart.',
        });
        return;
      }

      const [pbStorage, pbBackup] = await Promise.all([
        API.accounts.createLinkToken('storage', 'pastebin'),
        API.accounts.createLinkToken('backup', 'pastebin'),
      ]);

      storageInput.value = pbStorage.url || '';
      backupInput.value = pbBackup.url || '';
      if (!pbStorage.url || !pbBackup.url) {
        throw new Error('Pastebin link response missing URL — check server logs');
      }

      this.setPastebinLinkPanelState({
        configured: true,
        message: 'Copy a link, open it in a private window, and sign in with your Pastebin member account.',
      });
      if (expiryEl) {
        expiryEl.textContent = `Each Pastebin link works once and expires in ${pbStorage.expires_in_minutes} minutes.`;
      }
    } catch (err) {
      storageInput.value = '';
      backupInput.value = '';
      storageInput.placeholder = err.message || 'Failed to generate Pastebin link';
      backupInput.placeholder = err.message || 'Failed to generate Pastebin link';
      this.setPastebinLinkPanelState({
        configured: true,
        message: `Could not generate Pastebin links: ${err.message}`,
      });
      this.toast(err.message, 'error');
    }
  },

  async updateLinkUrls() {
    const storageInput = document.getElementById('link-url-storage');
    const backupInput = document.getElementById('link-url-backup');
    const bothInput = document.getElementById('link-url-both');
    const expiryEl = document.getElementById('link-url-expiry');
    if (!storageInput || !backupInput) {
      await Promise.all([this.updateBitbucketLinkUrls(), this.updateCodebergLinkUrls(), this.updatePastebinLinkUrls()]);
      return;
    }

    storageInput.value = 'Generating one-time link…';
    backupInput.value = 'Generating one-time link…';
    if (bothInput) bothInput.value = 'Generating one-time link…';

    let providerConfig = null;
    try {
      providerConfig = await this.fetchProviderConfig();
      if (providerConfig) this.updateSetupUrls(providerConfig);

      const requests = [
        API.accounts.createLinkToken('storage', 'github'),
        API.accounts.createLinkToken('backup', 'github'),
      ];
      if (bothInput) requests.push(API.accounts.createLinkToken('both', 'github'));
      const links = await Promise.all(requests);

      storageInput.value = links[0].url;
      backupInput.value = links[1].url;
      if (bothInput) bothInput.value = links[2]?.url || '';
      if (expiryEl) {
        expiryEl.textContent = `Each GitHub link works once and expires in ${links[0].expires_in_minutes} minutes.`;
      }
    } catch (err) {
      storageInput.value = '';
      backupInput.value = '';
      if (bothInput) bothInput.value = '';
      this.toast(err.message, 'error');
    }

    await this.updateBitbucketLinkUrls(providerConfig);
    await this.updateCodebergLinkUrls(providerConfig);
    await this.updatePastebinLinkUrls(providerConfig);
  },

  async copyText(text) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      this.toast('Copied', 'success');
    } catch {
      this.toast('Copy failed', 'error');
    }
  },

  async copyTextFromElement(elementId) {
    const el = document.getElementById(elementId);
    if (!el) return;
    const text = el.value ?? el.textContent ?? '';
    if (!text) return;
    const isInput = el.tagName === 'INPUT';
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      if (isInput) {
        el.select();
        document.execCommand('copy');
      }
    }
    const message = elementId.includes('api-key') ? 'API key copied'
      : elementId.includes('link-url') ? 'Link copied — open it in a private window'
        : 'Copied';
    this.toast(message, 'success');
  },

  async showRepoModal() {
    document.getElementById('repo-modal').classList.remove('hidden');
    const providerConfig = await this.fetchProviderConfig();
    this.updateSetupUrls(providerConfig);
    await Promise.all([
      this.updateLinkUrls(),
      this.loadRateLimits(),
      this.loadLinkedAccounts(),
      this.loadOrgPanel(),
      this.loadRepos(),
    ]);
  },

  async loadLinkedAccounts() {
    const listEl = document.getElementById('linked-accounts-list');
    if (!listEl) return;

    try {
      const { accounts } = await API.accounts.list();
      if (!accounts.length) {
        listEl.innerHTML = '<p class="linked-accounts-empty">No linked accounts yet.</p>';
        return;
      }

      listEl.innerHTML = '';
      for (const account of accounts) {
        const card = document.createElement('div');
        card.className = 'linked-account-card';

        const providerLabel = providerLabelFor(account.provider);
        const roleLabel = linkedAccountRoleLabel(account.role);
        const statusLabel = account.is_active ? 'Active' : 'Inactive';

        const quota = this.lastRateLimits?.find(
          (q) => (account.id == null && q.is_primary) || q.id === account.id
            || (q.username === account.username && q.role === account.role)
        );
        const quotaHtml = quota?.known ? `
          <div class="linked-account-quota">
            <span>${quota.used}/${quota.limit} API calls</span>
            <span>${quota.remaining} left${quota.paused ? ` · paused ${this.formatDuration(quota.pause_seconds_left)}` : ''}</span>
          </div>
        ` : '';

        card.innerHTML = `
          <div class="linked-account-info">
            <img class="linked-account-avatar" src="${account.avatar_url || ''}" alt="">
            <div>
              <span class="linked-account-name">@${account.username}</span>
              <span class="linked-account-meta">${providerLabel} · ${roleLabel} · ${statusLabel}</span>
              ${quotaHtml}
            </div>
          </div>
        `;

        const actions = document.createElement('div');
        actions.className = 'linked-account-actions';

        const roleSelect = document.createElement('select');
        roleSelect.className = 'linked-account-role';
        roleSelect.innerHTML = `
          <option value="storage"${account.role === 'storage' ? ' selected' : ''}>Storage</option>
          <option value="backup"${account.role === 'backup' ? ' selected' : ''}>Backup</option>
          <option value="both"${account.role === 'both' ? ' selected' : ''}>Storage + Backup</option>
        `;
        roleSelect.addEventListener('change', async () => {
          try {
            await API.accounts.update(account.id, { role: roleSelect.value });
            this.toast(`@${account.username} set to ${roleSelect.value}`, 'success');
            await this.loadLinkedAccounts();
            await this.loadRepos();
          } catch (err) {
            this.toast(err.message, 'error');
            roleSelect.value = account.role;
          }
        });
        actions.appendChild(roleSelect);

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'btn-secondary';
        toggleBtn.textContent = account.is_active ? 'Disable' : 'Enable';
        toggleBtn.addEventListener('click', async () => {
          try {
            await API.accounts.update(account.id, { is_active: !account.is_active });
            await this.loadLinkedAccounts();
            await this.loadRepos();
          } catch (err) {
            this.toast(err.message, 'error');
          }
        });
        actions.appendChild(toggleBtn);

        if (isBackupAccountRole(account.role)) {
          const redoBtn = document.createElement('button');
          redoBtn.className = 'btn-primary';
          redoBtn.textContent = 'Re-fork repos';
          redoBtn.title = 'Reset backup repo mapping and fork primary repos again';
          redoBtn.addEventListener('click', async () => {
            if (!confirm(`Re-fork all storage repos to @${account.username}? This re-discovers forks and restarts backup sync.`)) return;
            App.setButtonLoading(redoBtn, true);
            try {
              const result = await API.accounts.redoBackup(account.id);
              this.toast(`Re-forked ${result.count} repo(s) for @${account.username}`, 'success');
              await Promise.all([this.loadLinkedAccounts(), this.loadRepos(), this.loadAccountViews(), this.loadStats()]);
            } catch (err) {
              this.toast(err.message, 'error');
            } finally {
              App.setButtonLoading(redoBtn, false);
            }
          });
          actions.appendChild(redoBtn);
        }

        const unlinkBtn = document.createElement('button');
        unlinkBtn.className = 'btn-danger';
        unlinkBtn.textContent = 'Unlink';
        unlinkBtn.addEventListener('click', async () => {
          if (!confirm(`Unlink @${account.username}?`)) return;
          try {
            await API.accounts.unlink(account.id);
            this.toast(`Unlinked @${account.username}`, 'success');
            await this.loadLinkedAccounts();
            await this.loadRepos();
            await this.loadStats();
          } catch (err) {
            this.toast(err.message, 'error');
          }
        });
        actions.appendChild(unlinkBtn);

        card.appendChild(actions);
        listEl.appendChild(card);
      }
    } catch (err) {
      listEl.innerHTML = `<p class="linked-accounts-empty">${err.message}</p>`;
    }
  },

  async loadOrgPanel() {
    const select = document.getElementById('vault-org-select');
    const statusEl = document.getElementById('vault-org-status');
    const nameInput = document.getElementById('vault-org-name');
    if (!select || !statusEl) return;

    try {
      const [{ org: vaultOrg, configured }, { orgs, needs_reauth: needsReauth }] = await Promise.all([
        API.repos.org(),
        API.repos.orgs(),
      ]);

      const selectable = orgs.filter((o) => o.role === 'admin' || o.role === 'unknown');
      select.innerHTML = '<option value="">Select an organization…</option>'
        + selectable.map((o) => {
          const suffix = o.role === 'unknown' ? ' (from repos)' : '';
          return `<option value="${o.login}"${vaultOrg === o.login ? ' selected' : ''}>${o.login}${suffix}</option>`;
        }).join('');

      if (needsReauth) {
        statusEl.innerHTML = `
          <span class="org-status-warn">GitHub needs organization permission to list your orgs.</span>
          <a class="org-reconnect-link" href="/auth/github/reconnect">Reconnect GitHub</a>
          <span class="org-status-hint"> — or type your org name below and click Set up org storage.</span>
        `;
      } else if (!selectable.length) {
        statusEl.innerHTML = `
          <span class="org-status-hint">No organizations found where you are an owner/admin.</span>
          <a class="org-create-link" href="https://github.com/account/organizations/new" target="_blank" rel="noopener">Create one on GitHub</a>
          <span class="org-status-hint">, then type its name below.</span>
        `;
      } else if (vaultOrg) {
        nameInput.value = vaultOrg;
        statusEl.innerHTML = `<span class="org-status-active">Active vault org: <strong>${vaultOrg}</strong> · ${configured.length} storage repo${configured.length !== 1 ? 's' : ''}</span>`;
      } else {
        statusEl.textContent = 'No vault organization configured — storage repos are created on your personal account.';
      }
    } catch (err) {
      statusEl.textContent = err.message;
      if (/403|scope/i.test(err.message)) {
        statusEl.innerHTML = `${err.message} <a class="org-reconnect-link" href="/auth/github/reconnect">Reconnect GitHub</a>`;
      }
    }
  },

  async setupVaultOrg() {
    const select = document.getElementById('vault-org-select');
    const nameInput = document.getElementById('vault-org-name');
    const countInput = document.getElementById('vault-org-repo-count');
    const btn = document.getElementById('btn-setup-vault-org');
    const org = (nameInput?.value || select?.value || '').trim().toLowerCase();
    const repoCount = parseInt(countInput?.value, 10) || 3;

    if (!org) {
      this.toast('Select or enter an organization name', 'error');
      return;
    }

    App.setButtonLoading(btn, true);
    try {
      const result = await API.repos.setupOrg(org, repoCount);
      this.toast(`Vault org ${result.org} ready with ${result.repos.length} repo(s)`, 'success');
      await Promise.all([this.loadOrgPanel(), this.loadRepos(), this.loadStats()]);
    } catch (err) {
      this.toast(err.message, 'error');
    } finally {
      App.setButtonLoading(btn, false);
    }
  },

  async clearVaultOrg() {
    try {
      await API.repos.clearOrg();
      this.toast('Vault org preference cleared', 'success');
      await this.loadOrgPanel();
    } catch (err) {
      this.toast(err.message, 'error');
    }
  },

  async loadRepos() {
    const configuredEl = document.getElementById('configured-repos');
    const availableEl = document.getElementById('available-repos');
    configuredEl.innerHTML = '<div class="panel-status-msg">Loading...</div>';
    availableEl.innerHTML = '';

    try {
      const [configured, available] = await Promise.all([
        API.repos.configured(),
        API.repos.available(),
      ]);

      configuredEl.innerHTML = configured.repos.length ? '' : '<div class="panel-status-msg">No repos configured. Add one below.</div>';
      for (const repo of configured.repos) {
        configuredEl.appendChild(this.createRepoCard(repo, true));
      }

      const unconfigured = available.repos.filter(r => !r.configured);
      availableEl.innerHTML = unconfigured.length ? '' : '<div class="panel-status-msg">All repos are already configured.</div>';
      for (const repo of unconfigured) {
        availableEl.appendChild(this.createRepoCard(repo, false));
      }
    } catch (err) {
      configuredEl.innerHTML = `<div class="panel-status-error">${err.message}</div>`;
    }
  },

  createRepoCard(repo, isConfigured) {
    const card = document.createElement('div');
    card.className = 'repo-card';

    const info = document.createElement('div');
    info.className = 'repo-info';

    const isFull = repo.is_full || (isConfigured && repo.available <= 0);

    let driveHtml = '';
    if (isConfigured && repo.capacity != null) {
      driveHtml = `
        <div class="repo-drive">
          ${renderDriveBar(repo.vault_percent || 0, repo.used_percent || 0)}
          <span class="repo-drive-text">
            ${formatSize(repo.available || 0)} free of ${formatSize(repo.capacity || 0)}
            · Vault ${formatSize(repo.vault_used || repo.total_bytes || 0)}
          </span>
        </div>
      `;
    }

    const accountBadge = repo.account_username
      ? `<span class="repo-account-badge">@${repo.account_username}</span>`
      : '';
    const providerBadge = repo.provider && repo.provider !== 'github'
      ? `<span class="repo-badge provider">${providerLabelFor(repo.provider)}</span>`
      : '';

    info.innerHTML = `
      <span class="repo-name">${repo.full_name || repo.name} ${providerBadge} ${accountBadge}</span>
      <span class="repo-meta">
        ${isConfigured
          ? `${repo.private === false || repo.is_public ? 'Public' : 'Private'} · ${repo.chunk_count || 0} chunks · ${formatSize(repo.vault_used || repo.total_bytes || 0)} vault data`
          : `${repo.private ? 'Private' : 'Public'}${repo.account_username ? ` · @${repo.account_username}` : ''}`}
      </span>
      ${driveHtml}
    `;
    applyDynamicStyles(info);

    const actions = document.createElement('div');
    actions.className = 'repo-card-actions';

    if (isConfigured) {
      if (repo.is_metadata) {
        const badge = document.createElement('span');
        badge.className = 'repo-badge metadata';
        badge.textContent = 'Metadata';
        actions.appendChild(badge);
      } else if (repo.is_backup) {
        const badge = document.createElement('span');
        badge.className = 'repo-badge backup';
        badge.textContent = 'Backup mirror';
        actions.appendChild(badge);
      } else {
        const badge = document.createElement('span');
        badge.className = 'repo-badge' + (repo.is_active ? '' : ' inactive');
        badge.textContent = repo.is_active ? 'Active' : 'Inactive';
        actions.appendChild(badge);

        if (isFull) {
          const fullBadge = document.createElement('span');
          fullBadge.className = 'repo-badge full';
          fullBadge.textContent = 'Full';
          actions.appendChild(fullBadge);
        }

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'btn-secondary';
        toggleBtn.textContent = repo.is_active ? 'Disable' : 'Enable';
        toggleBtn.addEventListener('click', async () => {
          await API.repos.toggle(repo.id, !repo.is_active);
          this.loadRepos();
          this.loadStats();
        });
        actions.appendChild(toggleBtn);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'btn-danger';
        removeBtn.textContent = 'Remove';
        removeBtn.addEventListener('click', async () => {
          if (!confirm(`Remove ${repo.full_name} from storage pool?`)) return;
          try {
            await API.repos.remove(repo.id);
            this.toast('Repo removed', 'success');
            this.loadRepos();
            this.loadStats();
          } catch (err) {
            this.toast(err.message, 'error');
          }
        });
        actions.appendChild(removeBtn);
      }
    } else {
      const addBtn = document.createElement('button');
      addBtn.className = 'btn-primary';
      addBtn.textContent = 'Add';
      addBtn.addEventListener('click', async () => {
        try {
          await API.repos.add(repo.full_name, repo.linked_account_id || undefined);
          this.toast(`Added ${repo.full_name}`, 'success');
          this.loadRepos();
          this.loadStats();
        } catch (err) {
          this.toast(err.message, 'error');
        }
      });
      actions.appendChild(addBtn);
    }

    card.appendChild(info);
    card.appendChild(actions);
    return card;
  },
};

document.getElementById('btn-create-repo').addEventListener('click', async () => {
  try {
    const result = await API.repos.create();
    App.toast(`Created ${result.repo.full_name}`, 'success');
    App.loadRepos();
    App.loadStats();
  } catch (err) {
    App.toast(err.message, 'error');
  }
});

document.getElementById('btn-make-repos-public')?.addEventListener('click', async () => {
  const msg = 'Make all primary storage repos public on GitHub?\n\n'
    + 'This enables offline share playback via raw.githubusercontent.com. '
    + 'Chunks remain encrypted — only ciphertext is exposed.';
  if (!confirm(msg)) return;
  const btn = document.getElementById('btn-make-repos-public');
  btn.disabled = true;
  try {
    const result = await API.post('/api/repos/make-public');
    const failed = (result.results || []).filter((r) => !r.ok);
    if (failed.length) {
      App.toast(`${result.made_public}/${result.total} repos public — ${failed[0].error}`, 'error');
    } else {
      App.toast(`${result.made_public} storage repo(s) are now public`, 'success');
    }
    await App.loadRepos();
  } catch (err) {
    App.toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('btn-migrate-mysql')?.addEventListener('click', async () => {
  if (!confirm('Migrate all local SQLite data to MySQL?\n\nEnsure MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, and MYSQL_DATABASE are set in .env before proceeding.')) return;
  const btn = document.getElementById('btn-migrate-mysql');
  const status = document.getElementById('mysql-migrate-status');
  btn.disabled = true;
  status.textContent = 'Migrating...';
  status.className = 'org-setup-status';
  try {
    const result = await API.accounts.migrateToMysql();
    status.textContent = result.output.slice(-3).join('\n') || 'Migration complete.';
    status.className = 'org-setup-status org-setup-success';
    App.toast('MySQL migration complete', 'success');
  } catch (err) {
    status.textContent = 'Migration failed: ' + (err.message || 'Unknown error');
    status.className = 'org-setup-status org-setup-error';
    App.toast(err.message || 'Migration failed', 'error');
  } finally {
    btn.disabled = false;
  }
});

// Theme toggle
(function initTheme() {
  const btn = document.getElementById('btn-theme');
  if (!btn) return;
  const saved = localStorage.getItem('vault-theme');
  const prefersLight = saved === 'light' || (!saved && window.matchMedia('(prefers-color-scheme: light)').matches);
  if (prefersLight) document.documentElement.setAttribute('data-theme', 'light');
  btn.textContent = prefersLight ? '🌙' : '☀️';
  btn.addEventListener('click', () => {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    document.documentElement.setAttribute('data-theme', isLight ? 'dark' : 'light');
    btn.textContent = isLight ? '☀️' : '🌙';
    localStorage.setItem('vault-theme', isLight ? 'dark' : 'light');
  });
})();

// Command Palette (Ctrl+K)
(function initCommandPalette() {
  const overlay = document.getElementById('cmd-palette');
  const input = document.getElementById('cmd-input');
  const results = document.getElementById('cmd-results');
  if (!overlay || !input) return;

  const commands = [
    { icon: '📁', label: 'New Folder', action: () => App.openFolderModal(), keywords: 'create mkdir' },
    { icon: '📤', label: 'Upload File', action: () => App.openUploadPicker(), keywords: 'add import' },
    { icon: '⚡', label: 'Seamless Upload', action: () => App.openUploadPicker('seamless'), keywords: 'stream server cache large' },
    { icon: '📂', label: 'Upload Folder', action: () => { document.getElementById('file-input').setAttribute('webkitdirectory',''); App.openUploadPicker(); document.getElementById('file-input').removeAttribute('webkitdirectory'); }, keywords: 'directory' },
    { icon: '🔄', label: 'Refresh', action: () => App.refreshAll(), keywords: 'reload' },
    { icon: '⚙️', label: 'Storage Repos', action: () => App.showRepoModal(), keywords: 'settings repos' },
    { icon: '🔑', label: 'API Keys', action: () => App.showApiKeysPanel(), keywords: 'keys tokens' },
    { icon: '🔒', label: 'Site Access', action: () => App.showSiteAccessPanel(), keywords: 'key gate login share' },
    { icon: '🤖', label: 'Agents', action: () => App.showAgentsPanel(), keywords: 'sync clients' },
    { icon: '📊', label: 'Bandwidth', action: () => App.showBandwidthPanel(), keywords: 'stats' },
    { icon: '👁️', label: 'Live Viewers', action: () => App.showViewersPanel(), keywords: 'presence' },
  ];

  function renderResults(filter) {
    const q = (filter || '').toLowerCase();
    const filtered = q ? commands.filter(c =>
      c.label.toLowerCase().includes(q) || c.keywords.includes(q)
    ) : commands;

    if (!filtered.length) {
      results.innerHTML = '<div class="cmd-empty">No matching commands</div>';
      return;
    }

    results.innerHTML = filtered.map((c, i) =>
      `<div class="cmd-item${i === 0 ? ' active' : ''}" data-action="${c.label}">
        <span class="cmd-icon">${c.icon}</span>
        <span>${c.label}</span>
        <span class="cmd-label">${c.keywords.split(' ')[0]}</span>
      </div>`
    ).join('');

    results.querySelectorAll('.cmd-item').forEach(el => {
      el.addEventListener('click', () => {
        const cmd = filtered.find(c => c.label === el.dataset.action);
        if (cmd) { hide(); cmd.action(); }
      });
    });
  }

  function show() {
    overlay.classList.remove('hidden'); input.focus(); input.value = ''; renderResults('');
  }
  function hide() { overlay.classList.add('hidden'); }

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); show(); }
    if (e.key === 'Escape' && !overlay.classList.contains('hidden')) { hide(); }
  });

  overlay.addEventListener('click', (e) => { if (e.target === overlay) hide(); });
  input.addEventListener('input', () => renderResults(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { hide(); return; }
    if (e.key === 'Enter') {
      const active = results.querySelector('.cmd-item.active');
      if (active) active.click();
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const items = [...results.querySelectorAll('.cmd-item')];
      const active = results.querySelector('.cmd-item.active');
      const idx = active ? items.indexOf(active) : -1;
      const next = e.key === 'ArrowDown' ? (idx + 1) % items.length : (idx - 1 + items.length) % items.length;
      items.forEach(el => el.classList.remove('active'));
      items[next]?.classList.add('active');
    }
  });

  // Also search files when user types
  input.addEventListener('input', () => {
    const q = input.value.trim();
    if (q) {
      const searchFiles = explorer.files
        .filter(f => f.name.toLowerCase().includes(q.toLowerCase()))
        .slice(0, 5)
        .map((f, i) =>
          `<div class="cmd-item" data-file="${f.id}">
            <span class="cmd-icon">${f.is_folder ? '📁' : '📄'}</span><span>${f.name}</span>
            <span class="cmd-label">${f.is_folder ? 'Folder' : formatSize(f.size)}</span>
          </div>`
        );
      if (searchFiles.length) {
        results.querySelector('.cmd-empty')?.remove();
        const fileSection = results.querySelector('.cmd-file-section');
        if (fileSection) fileSection.remove();
        const div = document.createElement('div');
        div.className = 'cmd-file-section';
        div.innerHTML = '<div class="cmd-file-section-label">Files</div>' + searchFiles.join('');
        results.appendChild(div);
        div.querySelectorAll('.cmd-item').forEach(el => {
          el.addEventListener('click', () => {
            hide();
            const file = explorer.files.find(f => f.id === el.dataset.file);
            if (file) { if (file.is_folder) explorer.openItem(file); else Viewer.open(file); }
          });
        });
      }
    }
  });
})();

// Details Panel
(function initDetailsPanel() {
  const panel = document.getElementById('details-panel');
  const empty = document.getElementById('details-empty');
  const content = document.getElementById('details-content');
  if (!panel) return;

  window.showDetailsPanel = function(file) {
    panel.classList.remove('hidden');
    empty.classList.add('hidden');
    content.classList.remove('hidden');

    const iconEl = document.getElementById('details-icon');
    const previewType = !file.is_folder && getPreviewType(file.name, file.mime_type);
    if (file.has_thumbnail && previewType) {
      const src = ThumbCache.resolveUrl(file.id, file.thumbVersion);
      if (src) {
        iconEl.innerHTML = `<img class="details-thumb" src="${src}" alt="">`;
        const img = iconEl.querySelector('img');
        img.onerror = () => {
          file.has_thumbnail = false;
          ThumbCache.markFailed(file.id, file.thumbVersion);
          iconEl.textContent = file.is_folder ? '📁' : getFileIcon(file.name, false);
        };
        ThumbCache.prefetch(file.id, file.thumbVersion).then((url) => {
          if (img && url) img.src = url;
          else if (img) img.onerror?.(new Event('error'));
        }).catch(() => {});
      } else {
        iconEl.textContent = file.is_folder ? '📁' : getFileIcon(file.name, false);
      }
    } else {
      iconEl.textContent = file.is_folder ? '📁' : getFileIcon(file.name, false);
    }
    document.getElementById('details-name').textContent = file.name;
    document.getElementById('details-type').textContent = file.is_folder ? 'Folder' : (file.mime_type || 'Unknown');
    document.getElementById('detail-size').textContent = file.is_folder ? '—' : formatSize(file.size || 0);
    document.getElementById('detail-date').textContent = file.created_at ? new Date(file.created_at).toLocaleString() : '—';
    document.getElementById('detail-chunks').textContent = file.is_folder ? '—' : (file.chunk_count || 0);
    if (!file.is_folder) {
      const view = explorer?.accountView || 'primary';
      const chunksEl = document.getElementById('detail-chunks');
      API.files.details(file.id, view).then((d) => {
        if (d.view && d.view.type !== 'primary') {
          chunksEl.textContent = `${d.view.chunks_available} / ${d.view.chunks_total} (${d.view.label})`;
        } else {
          chunksEl.textContent = String(d.file.chunk_count || 0);
        }
      }).catch(() => {});
    }
    document.getElementById('detail-mime').textContent = file.mime_type || '—';
    document.getElementById('detail-hash').textContent = file.content_hash ? file.content_hash.slice(0, 20) + '...' : '—';
    document.getElementById('detail-enc').textContent = file.encryption_mode || 'chunk';

    const dd = document.getElementById('detail-download');
    const ds = document.getElementById('detail-share');
    const dp = document.getElementById('detail-preview');
    dd.onclick = () => { if (!file.is_folder) explorer.downloadFile(file); };
    ds.onclick = () => { App.shareFile(file); };
    dp.onclick = () => { if (!file.is_folder) Viewer.open(file); };
    dd.style.display = file.is_folder ? 'none' : '';
    dp.style.display = file.is_folder ? 'none' : '';
    ds.style.display = '';
    const divider = document.getElementById('panel-divider');
    if (divider) divider.classList.remove('hidden');
    DetailsPreview?.show?.(file);
  };

  window.hideDetailsPanel = function() {
    DetailsPreview?.clear?.();
    panel.classList.add('hidden');
    empty.classList.remove('hidden');
    content.classList.add('hidden');
    document.getElementById('panel-divider')?.classList.add('hidden');
  };
})();

// Resizable panel divider
(function initResizablePanels() {
  const divider = document.getElementById('panel-divider');
  const details = document.getElementById('details-panel');
  if (!divider || !details) return;

  let dragging = false;
  let startX = 0;
  let startW = 0;

  divider.addEventListener('mousedown', (e) => {
    dragging = true;
    startX = e.clientX;
    startW = details.offsetWidth;
    divider.classList.add('active');
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const diff = startX - e.clientX;
    const newW = Math.min(500, Math.max(180, startW + diff));
    details.style.width = newW + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    divider.classList.remove('active');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  });
})();

// Staggered file animations (visible window only)
const originalRenderVisible = Explorer.prototype.renderVisibleRange;
if (originalRenderVisible && !originalRenderVisible._staggeredPatched) {
  Explorer.prototype.renderVisibleRange = function() {
    originalRenderVisible.call(this);
    if (this.files.length <= VirtualGrid.threshold) {
      const items = document.querySelectorAll('#file-grid .file-item');
      items.forEach((el, i) => { el.style.animationDelay = `${Math.min(i * 12, 240)}ms`; });
    }
  };
  Explorer.prototype.renderVisibleRange._staggeredPatched = true;
}

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
  if (document.getElementById('cmd-palette')?.classList.contains('hidden') === false) return;

  const ctrl = e.ctrlKey || e.metaKey;

  if (ctrl && e.shiftKey && e.key.toLowerCase() === 'f') {
    e.preventDefault();
    GlobalSearch?.show?.();
    return;
  }
  if (ctrl && e.key === 'k') { e.preventDefault(); return; }
  if (ctrl && e.key === 'f') {
    e.preventDefault();
    document.getElementById('search-input')?.classList.remove('hidden');
    document.getElementById('search-input')?.focus();
    document.getElementById('btn-search').textContent = '✕';
    return;
  }
  if (e.key === 'Escape') {
    explorer.selected.clear();
    explorer.updateSelectionClasses();
    explorer.updateToolbar();
    explorer.updateStatus();
    if (typeof hideDetailsPanel === 'function') hideDetailsPanel();
    return;
  }
})

document.addEventListener('DOMContentLoaded', () => App.init());
window.App = App;
