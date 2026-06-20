/**
 * File and folder version history UI — preview, restore, and chunk details.
 */
const FileHistory = {
  file: null,
  folder: null,
  mode: 'file',
  data: null,
  folderData: null,
  selectedDay: null,
  folderBrowsePath: '/',
  folderBrowseData: null,

  isFolder(entry) {
    return !!(entry && (entry.is_folder === true || entry.is_folder === 1 || entry.is_folder === '1'));
  },

  init() {
    const modal = document.getElementById('file-history-modal');
    modal?.addEventListener('click', (e) => {
      const preview = e.target.closest('[data-history-preview]');
      const download = e.target.closest('[data-history-download]');
      const details = e.target.closest('[data-history-details]');
      const restore = e.target.closest('[data-history-restore]');
      const back = e.target.closest('[data-history-back]');
      const folderDay = e.target.closest('[data-folder-history-day]');
      const folderRestore = e.target.closest('[data-folder-history-restore]');
      const folderBrowseUp = e.target.closest('[data-folder-browse-up]');
      if (preview) this.previewVersion(parseInt(preview.dataset.historyPreview, 10));
      if (download) this.downloadVersion(parseInt(download.dataset.historyDownload, 10));
      if (details) this.showVersionDetails(parseInt(details.dataset.historyDetails, 10));
      if (restore) this.restoreVersion(parseInt(restore.dataset.historyRestore, 10));
      if (back) this.showList();
      if (folderRestore) this.restoreFolderDay(folderRestore.dataset.folderHistoryRestore);
      else if (folderDay) this.selectFolderDay(folderDay.dataset.folderHistoryDay);
      if (folderBrowseUp) this.navigateFolderBrowse(folderBrowseUp.dataset.folderBrowseUp);
    });

    modal?.addEventListener('dblclick', (e) => {
      const item = e.target.closest('[data-folder-browse-item]');
      if (!item || this.mode !== 'folder') return;
      if (item.dataset.folderBrowseItem === 'folder') {
        this.navigateFolderBrowse(item.dataset.folderBrowsePath);
      } else if (item.dataset.folderBrowseItem === 'file') {
        this.previewFolderFile(
          parseInt(item.dataset.folderBrowseFileId, 10),
          parseInt(item.dataset.folderBrowseVersionId, 10),
          item.dataset.folderBrowseName,
          item.dataset.folderBrowseMime || '',
        );
      }
    });

    document.getElementById('version-details-modal')?.addEventListener('click', (e) => {
      const restore = e.target.closest('[data-version-details-restore]');
      if (restore) {
        const versionId = parseInt(restore.dataset.versionDetailsRestore, 10);
        document.getElementById('version-details-modal')?.classList.add('hidden');
        this.restoreVersion(versionId);
      }
    });
  },

  async open(file) {
    if (!file) return;
    if (this.isFolder(file)) {
      return this.openFolder(file);
    }
    this.mode = 'file';
    this.folder = null;
    this.folderData = null;
    this.selectedDay = null;
    this.file = file;
    this.data = null;
    const modal = document.getElementById('file-history-modal');
    const body = document.getElementById('file-history-body');
    const title = document.getElementById('file-history-title');
    const subtitle = document.getElementById('file-history-subtitle');
    const icon = document.getElementById('file-history-icon');
    if (!modal || !body) return;

    modal.classList.remove('file-history-modal--folder');

    if (title) title.textContent = file.name;
    if (subtitle) {
      const parts = [];
      if (file.size) parts.push(formatSize(file.size));
      if (file.path) parts.push(file.path);
      subtitle.textContent = parts.join(' · ') || 'Past versions of this file';
    }
    if (icon && typeof getFileIcon === 'function') {
      icon.textContent = getFileIcon(file.name, false);
    }

    body.innerHTML = '<div class="file-history-loading"><span class="file-history-spinner"></span> Loading history…</div>';
    modal.classList.remove('hidden');

    try {
      const data = await API.files.history(file.id);
      this.data = data;
      this.render(data);
    } catch (err) {
      body.innerHTML = `<div class="file-history-empty"><p>${this.escape(err.message)}</p></div>`;
    }
  },

  async openFolder(folder) {
    if (!folder || !this.isFolder(folder)) {
      App?.toast?.('Could not open folder history for this item', 'error');
      return;
    }
    this.mode = 'folder';
    this.folder = folder;
    this.file = null;
    this.data = null;
    this.folderData = null;
    this.selectedDay = null;
    this.folderBrowsePath = folder.path || (folder.parent_path === '/' ? `/${folder.name}` : `${folder.parent_path}/${folder.name}`);
    this.folderBrowseData = null;

    const modal = document.getElementById('file-history-modal');
    const body = document.getElementById('file-history-body');
    const title = document.getElementById('file-history-title');
    const subtitle = document.getElementById('file-history-subtitle');
    const icon = document.getElementById('file-history-icon');
    if (!modal || !body) return;

    modal.classList.add('file-history-modal--folder');
    if (title) title.textContent = folder.name;
    if (subtitle) {
      subtitle.textContent = `${this.folderBrowsePath} · folder history by day`;
    }
    if (icon) icon.textContent = '📁';

    body.innerHTML = '<div class="file-history-loading"><span class="file-history-spinner"></span> Loading folder history…</div>';
    modal.classList.remove('hidden');

    try {
      const data = await API.files.folderHistory(folder.id);
      this.folderData = data;
      this.renderFolder(data);
      if (data.days?.length) {
        this.selectFolderDay(data.days[0].day);
      }
    } catch (err) {
      body.innerHTML = `<div class="file-history-empty"><p>${this.escape(err.message)}</p></div>`;
    }
  },

  showList() {
    if (!this.data) return;
    const body = document.getElementById('file-history-body');
    if (body) this.render(this.data);
  },

  render(data) {
    const body = document.getElementById('file-history-body');
    if (!data.enabled) {
      body.innerHTML = `
        <div class="file-history-empty">
          <div class="file-history-empty-icon">⏸</div>
          <p class="file-history-empty-title">History is turned off</p>
          <p class="file-history-empty-desc">File history is disabled on this server.</p>
        </div>`;
      return;
    }

    const intro = `
      <div class="file-history-intro">
        <p>Each content change creates a snapshot. <strong>Preview</strong> opens the vault viewer; <strong>Restore</strong> makes that version the live file (current content is saved first).</p>
      </div>`;

    if (!data.versions?.length) {
      body.innerHTML = `
        ${intro}
        <div class="file-history-empty">
          <div class="file-history-empty-icon">🕐</div>
          <p class="file-history-empty-title">No versions yet</p>
          <p class="file-history-empty-desc">Edit this file locally and let Vault Sync upload the change.</p>
        </div>
        ${this.renderGitSection(data.gitCommits)}
      `;
      return;
    }

    const previewType = getPreviewType(this.file.name, this.file.mime_type);
    const cards = data.versions.map((v, idx) => this.renderVersionCard(v, previewType, idx === 0)).join('');

    body.innerHTML = `
      ${intro}
      <section class="file-history-section" aria-label="Saved versions">
        <div class="file-history-section-head">
          <h3>Saved versions</h3>
          <span class="file-history-count">${data.versions.length} version${data.versions.length === 1 ? '' : 's'}</span>
        </div>
        <div class="file-history-timeline">${cards}</div>
      </section>
      ${this.renderGitSection(data.gitCommits)}
    `;
  },

  renderFolder(data) {
    const body = document.getElementById('file-history-body');
    if (!data.enabled) {
      body.innerHTML = `
        <div class="file-history-empty">
          <div class="file-history-empty-icon">⏸</div>
          <p class="file-history-empty-title">History is turned off</p>
          <p class="file-history-empty-desc">File history is disabled on this server.</p>
        </div>`;
      return;
    }

    const intro = `
      <div class="file-history-intro">
        <p>Changes across all files in this folder are grouped by <strong>calendar day</strong>. Select a day to browse that folder as it was at end of day. <strong>Restore day</strong> rolls every file back to that snapshot (current content is saved first).</p>
      </div>`;

    if (!data.days?.length) {
      body.innerHTML = `
        ${intro}
        <div class="file-history-empty">
          <div class="file-history-empty-icon">🕐</div>
          <p class="file-history-empty-title">No history yet</p>
          <p class="file-history-empty-desc">Edit files in this folder and let Vault Sync upload changes.</p>
        </div>`;
      return;
    }

    const dayCards = data.days.map((d) => this.renderFolderDayCard(d)).join('');
    body.innerHTML = `
      ${intro}
      <div class="file-history-folder-layout">
        <aside class="file-history-folder-days" aria-label="Days with changes">
          <div class="file-history-section-head">
            <h3>Days</h3>
            <span class="file-history-count">${data.days.length}</span>
          </div>
          <div class="file-history-folder-day-list">${dayCards}</div>
        </aside>
        <main class="file-history-folder-preview" id="folder-history-preview" aria-label="Folder preview">
          <div class="file-history-folder-preview-empty">
            <p>Select a day to preview this folder at end of day.</p>
          </div>
        </main>
      </div>
    `;
  },

  renderFolderDayCard(d) {
    const selected = this.selectedDay === d.day ? ' is-selected' : '';
    const changeLabel = `${d.changeCount} change${d.changeCount === 1 ? '' : 's'}`;
    const stateLabel = `${d.stateFileCount} file${d.stateFileCount === 1 ? '' : 's'} in snapshot`;
    const canRestore = d.restorableCount > 0;
    const changesPreview = (d.changes || []).slice(0, 4).map((c) => `
      <li>
        <span class="folder-history-change-name">${this.escape(c.name)}</span>
        <span class="folder-history-change-meta">v${c.versionNum}</span>
      </li>
    `).join('');
    const more = d.changeCount > 4 ? `<li class="folder-history-change-more">+${d.changeCount - 4} more</li>` : '';

    return `
      <article class="file-history-folder-day${selected}">
        <button type="button" class="file-history-folder-day-btn" data-folder-history-day="${this.escape(d.day)}">
          <div class="file-history-folder-day-top">
            <span class="file-history-folder-day-label">${this.escape(d.label || d.day)}</span>
            <span class="file-history-folder-day-key">${this.escape(d.day)}</span>
          </div>
          <p class="file-history-folder-day-stats">${changeLabel} · ${stateLabel}</p>
          <ul class="folder-history-change-list">${changesPreview}${more}</ul>
        </button>
        ${canRestore ? `<button type="button" class="btn-primary btn-sm file-history-folder-restore" data-folder-history-restore="${this.escape(d.day)}">Restore day</button>` : ''}
      </article>
    `;
  },

  async selectFolderDay(dayKey) {
    if (!this.folder || !dayKey) return;
    this.selectedDay = dayKey;
    this.folderBrowsePath = this.folderData?.folderPath || this.folderBrowsePath;

    document.querySelectorAll('.file-history-folder-day').forEach((el) => {
      const btn = el.querySelector('[data-folder-history-day]');
      el.classList.toggle('is-selected', btn?.dataset.folderHistoryDay === dayKey);
    });

    await this.loadFolderBrowse();
  },

  async loadFolderBrowse() {
    const preview = document.getElementById('folder-history-preview');
    if (!preview || !this.folder || !this.selectedDay) return;

    preview.innerHTML = '<div class="file-history-loading"><span class="file-history-spinner"></span> Loading preview…</div>';

    try {
      const data = await API.files.folderHistoryBrowse(
        this.folder.id,
        this.selectedDay,
        this.folderBrowsePath,
      );
      this.folderBrowseData = data;
      preview.innerHTML = this.renderFolderBrowse(data);
    } catch (err) {
      preview.innerHTML = `<div class="file-history-empty"><p>${this.escape(err.message)}</p></div>`;
    }
  },

  renderFolderBrowse(data) {
    const day = this.folderData?.days?.find((d) => d.day === this.selectedDay);
    const dayLabel = day?.label || this.selectedDay;
    const rootPath = data.folderPath || this.folderBrowsePath;
    const canUp = data.parentPath && data.parentPath !== rootPath;
    const crumbs = this.folderBrowseCrumbs(data.parentPath, rootPath);

    const folders = (data.folders || []).map((f) => `
      <div class="folder-history-browse-item is-folder" data-folder-browse-item="folder" data-folder-browse-path="${this.escape(f.path)}" title="Open folder">
        <span class="folder-history-browse-icon">📁</span>
        <span class="folder-history-browse-name">${this.escape(f.name)}</span>
      </div>
    `).join('');

    const files = (data.files || []).map((f) => {
      const icon = typeof getFileIcon === 'function' ? getFileIcon(f.name, false) : '📄';
      const canPreview = f.downloadable !== false && getPreviewType(f.name, f.mime_type);
      return `
        <div class="folder-history-browse-item${canPreview ? ' is-previewable' : ''}"
          data-folder-browse-item="file"
          data-folder-browse-file-id="${f.id}"
          data-folder-browse-version-id="${f.versionId}"
          data-folder-browse-name="${this.escape(f.name)}"
          data-folder-browse-mime="${this.escape(f.mime_type || '')}"
          title="${canPreview ? 'Double-click to preview' : 'No preview for this type'}">
          <span class="folder-history-browse-icon">${icon}</span>
          <span class="folder-history-browse-name">${this.escape(f.name)}</span>
          <span class="folder-history-browse-size">${formatSize(f.size)}</span>
        </div>
      `;
    }).join('');

    const empty = !folders && !files
      ? '<p class="folder-history-browse-empty">No files in this folder on this day.</p>'
      : (!data.folders?.length && !data.files?.length
        ? '<p class="folder-history-browse-empty">This folder is empty on this day.</p>'
        : '');

    return `
      <div class="folder-history-preview-head">
        <div>
          <h3>${this.escape(dayLabel)}</h3>
          <p class="folder-history-preview-sub">End-of-day snapshot · double-click files to preview</p>
        </div>
        ${day?.restorableCount ? `<button type="button" class="btn-primary btn-sm" data-folder-history-restore="${this.escape(this.selectedDay)}">Restore day</button>` : ''}
      </div>
      <div class="folder-history-browse-toolbar">
        ${canUp ? `<button type="button" class="btn-ghost btn-sm" data-folder-browse-up="${this.escape(this.parentFolderPath(data.parentPath))}">↑ Up</button>` : ''}
        <nav class="folder-history-browse-crumbs" aria-label="Browse path">${crumbs}</nav>
      </div>
      <div class="folder-history-browse-grid vault-scroll">
        ${folders}
        ${files}
        ${empty}
      </div>
    `;
  },

  folderBrowseCrumbs(currentPath, rootPath) {
    if (!currentPath || currentPath === rootPath) {
      return `<span class="folder-history-crumb is-current">${this.escape(this.folder?.name || 'Folder')}</span>`;
    }
    const parts = currentPath.replace(rootPath, '').split('/').filter(Boolean);
    let path = rootPath;
    const items = [`<button type="button" class="folder-history-crumb" data-folder-browse-up="${this.escape(rootPath)}">${this.escape(this.folder?.name || 'Folder')}</button>`];
    for (const part of parts) {
      path = path === '/' ? `/${part}` : `${path}/${part}`;
      const isLast = path === currentPath;
      if (isLast) {
        items.push(`<span class="folder-history-crumb is-current">${this.escape(part)}</span>`);
      } else {
        items.push(`<button type="button" class="folder-history-crumb" data-folder-browse-up="${this.escape(path)}">${this.escape(part)}</button>`);
      }
    }
    return items.join('<span class="folder-history-crumb-sep">/</span>');
  },

  parentFolderPath(path) {
    if (!path || path === '/') return '/';
    const idx = path.lastIndexOf('/');
    if (idx <= 0) return '/';
    return path.slice(0, idx) || '/';
  },

  async navigateFolderBrowse(path) {
    if (!path || !this.selectedDay) return;
    const root = this.folderData?.folderPath || this.folderBrowsePath;
    if (path !== root && !path.startsWith(`${root}/`)) return;
    this.folderBrowsePath = path;
    await this.loadFolderBrowse();
  },

  previewFolderFile(fileId, versionId, name, mimeType) {
    const day = this.folderData?.days?.find((d) => d.day === this.selectedDay);
    const fileEntry = this.folderBrowseData?.files?.find((f) => f.id === fileId);
    if (fileEntry?.downloadable === false) {
      App.toast('This version cannot be previewed — missing encryption data', 'error');
      return;
    }
    const type = getPreviewType(name, mimeType);
    if (!type) {
      App.toast('No preview available for this file type', 'error');
      return;
    }

    const previewFile = {
      id: fileId,
      name,
      mime_type: mimeType,
      size: fileEntry?.size,
      chunk_count: fileEntry?.chunk_count,
      has_hls: false,
      _historyVersionId: versionId,
      _historyLabel: `${day?.label || this.selectedDay} · v${fileEntry?.versionNum ?? '?'}`,
    };

    document.getElementById('file-history-modal')?.classList.add('hidden');
    const opened = Viewer.open(previewFile);
    if (!opened) {
      document.getElementById('file-history-modal')?.classList.remove('hidden');
      App.toast('Could not open preview', 'error');
    }
  },

  async restoreFolderDay(dayKey) {
    if (!this.folder || !dayKey) return;
    const day = this.folderData?.days?.find((d) => d.day === dayKey);
    if (!day?.restorableCount) {
      App.toast('Nothing restorable for this day', 'error');
      return;
    }

    const label = day.label || dayKey;
    if (!confirm(`Restore all ${day.restorableCount} file(s) in "${this.folder.name}" to how they were at end of ${label}?\n\nCurrent file content is saved to history first.`)) {
      return;
    }

    try {
      App.toast('Restoring folder snapshot…', 'info');
      const result = await API.files.folderHistoryRestore(this.folder.id, dayKey);
      if (result.restoredCount) {
        App.toast(`Restored ${result.restoredCount} file(s) from ${label}`, 'success');
      } else if (result.failedCount) {
        App.toast(`Restore failed for ${result.failedCount} file(s)`, 'error');
      } else {
        App.toast('All files already matched that day', 'info');
      }
      document.getElementById('file-history-modal')?.classList.add('hidden');
      if (typeof App.refreshAll === 'function') App.refreshAll();
    } catch (err) {
      App.toast(err.message || 'Restore failed', 'error');
    }
  },

  renderVersionCard(v, previewType, isFirst) {
    const when = this.formatWhen(v.createdAt);
    const whenFull = v.createdAt
      ? new Date(v.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      : '';
    const source = this.formatSource(v.source);
    const canOpen = v.downloadable !== false;
    const previewBtn = previewType && canOpen
      ? `<button type="button" class="btn-secondary btn-sm" data-history-preview="${v.id}">Preview</button>`
      : '';
    const downloadBtn = canOpen
      ? `<button type="button" class="btn-ghost btn-sm" data-history-download="${v.id}">Download</button>`
      : '';
    const detailsBtn = `<button type="button" class="btn-ghost btn-sm" data-history-details="${v.id}">Details</button>`;
    const restoreBtn = canOpen && !v.isCurrent
      ? `<button type="button" class="btn-primary btn-sm" data-history-restore="${v.id}">Restore</button>`
      : '';

    return `
      <article class="file-history-card${v.isCurrent ? ' is-current' : ''}${isFirst ? ' is-latest' : ''}">
        <div class="file-history-card-marker" aria-hidden="true"></div>
        <div class="file-history-card-body">
          <div class="file-history-card-top">
            <div class="file-history-card-title">
              <span class="file-history-version-label">Version ${v.versionNum}</span>
              ${v.isCurrent ? '<span class="history-badge">Current</span>' : ''}
            </div>
            <span class="file-history-card-size">${formatSize(v.size)}</span>
          </div>
          <p class="file-history-card-meta">
            <time datetime="${this.escape(v.createdAt || '')}" title="${this.escape(whenFull)}">${when}</time>
            <span class="file-history-meta-dot">·</span>
            <span class="history-source-pill history-source-${this.escape(v.source || 'upload')}">${this.escape(source.label)}</span>
          </p>
          <p class="file-history-card-desc">${this.escape(source.desc)}</p>
          <div class="file-history-card-actions">
            ${previewBtn}
            ${detailsBtn}
            ${downloadBtn}
            ${restoreBtn}
          </div>
          ${!canOpen ? '<p class="history-unavailable">Missing encryption metadata — listed for audit only.</p>' : ''}
        </div>
      </article>
    `;
  },

  renderGitSection(commits) {
    if (!commits?.length) return '';
    const items = commits.slice(0, 10).map((c) => {
      const when = this.formatWhen(c.date);
      const whenFull = c.date
        ? new Date(c.date).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
        : '';
      const label = this.formatGitCommit(c.message);
      const sha = (c.sha || '').slice(0, 7);
      return `
        <li class="file-history-git-item">
          <div class="file-history-git-dot" aria-hidden="true"></div>
          <div class="file-history-git-content">
            <p class="file-history-git-label">${this.escape(label)}</p>
            <p class="file-history-git-meta">
              <time datetime="${this.escape(c.date || '')}" title="${this.escape(whenFull)}">${when}</time>
              ${sha ? `<span class="file-history-meta-dot">·</span><code class="history-sha" title="Commit ${this.escape(c.sha || '')}">${sha}</code>` : ''}
            </p>
          </div>
        </li>`;
    }).join('');

    return `
      <section class="file-history-section file-history-git">
        <div class="file-history-section-head">
          <h3>Git audit trail</h3>
          <span class="file-history-section-hint">Metadata repo</span>
        </div>
        <p class="file-history-git-intro">GitHub commits for the file manifest. Recoverable versions appear above when chunk keys are stored.</p>
        <ul class="file-history-git-list">${items}</ul>
      </section>
    `;
  },

  async showVersionDetails(versionId) {
    if (!this.file) return;
    const modal = document.getElementById('version-details-modal');
    const body = document.getElementById('version-details-body');
    const title = document.getElementById('version-details-title');
    if (!modal || !body) return;

    const v = this.data?.versions?.find((x) => x.id === versionId);
    title.textContent = v ? `Version ${v.versionNum} details` : 'Version details';
    body.innerHTML = '<div class="file-history-loading"><span class="file-history-spinner"></span> Loading…</div>';
    modal.classList.remove('hidden');

    try {
      const d = await API.files.historyDetails(this.file.id, versionId);
      const restoreBtn = d.downloadable && !v?.isCurrent
        ? `<button type="button" class="btn-primary" data-version-details-restore="${versionId}">Restore this version</button>`
        : '';
      body.innerHTML = `
        <div class="details-section">
          <h3>${this.escape(d.file.name)}</h3>
          <div class="details-grid">
            <span>Version</span><span>${d.version.versionNum}${v?.isCurrent ? ' (current)' : ''}</span>
            <span>Size</span><span>${formatSize(d.file.size)}</span>
            <span>Type</span><span>${this.escape(d.file.mime_type || 'unknown')}</span>
            <span>Chunks</span><span>${d.file.chunk_count}</span>
            <span>Source</span><span>${this.escape(this.formatSource(d.version.source).label)}</span>
            <span>Recorded</span><span>${d.recorded_at ? new Date(d.recorded_at).toLocaleString() : '—'}</span>
            ${d.manifest_sha ? `<span>Manifest SHA</span><span class="mono">${this.escape(d.manifest_sha.slice(0, 12))}…</span>` : ''}
            ${d.content_fingerprint ? `<span>Fingerprint</span><span class="mono" title="${this.escape(d.content_fingerprint)}">${this.escape(d.content_fingerprint.slice(0, 16))}…</span>` : ''}
          </div>
        </div>
        <div class="details-section">
          <h4>Repos used</h4>
          ${Object.entries(d.repos_used).map(([r, n]) => `
            <div class="plan-repo-row"><span>${this.escape(r)}</span><span>${n} chunk${n === 1 ? '' : 's'}</span></div>
          `).join('')}
        </div>
        <div class="details-section details-chunks">
          <h4>GitHub chunks</h4>
          <p class="modal-desc">Encrypted blobs referenced by this snapshot. Historical content is fetched by blob SHA.</p>
          <div class="file-history-table-wrap">
            <table class="chunk-table file-history-chunk-table">
              <thead>
                <tr><th>#</th><th>Repo</th><th>Path</th><th>Plain</th><th>Encrypted</th><th>SHA</th></tr>
              </thead>
              <tbody>
                ${d.chunks.map((c) => `
                  <tr>
                    <td>${c.index}</td>
                    <td>${this.escape(c.repo)}</td>
                    <td class="mono">${this.escape(c.path)}</td>
                    <td>${formatSize(c.plain_size)}</td>
                    <td>${formatSize(c.encrypted_size)}</td>
                    <td class="mono sha-cell" title="${this.escape(c.sha || '')}">${(c.sha || '').slice(0, 10)}…</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
        ${restoreBtn ? `<div class="version-details-actions">${restoreBtn}</div>` : ''}
      `;
    } catch (err) {
      body.innerHTML = `<p class="plan-error">${this.escape(err.message)}</p>`;
    }
  },

  previewVersion(versionId) {
    if (!this.file) return;
    const v = this.data?.versions?.find((x) => x.id === versionId);
    if (v?.downloadable === false) {
      App.toast('This version cannot be previewed — missing encryption data', 'error');
      return;
    }
    const type = getPreviewType(this.file.name, this.file.mime_type);
    if (!type) {
      App.toast('No preview available for this file type', 'error');
      return;
    }

    const previewFile = {
      ...this.file,
      size: v?.size ?? this.file.size,
      chunk_count: v?.chunkCount ?? this.file.chunk_count,
      has_hls: false,
      _historyVersionId: versionId,
      _historyLabel: `Version ${v?.versionNum ?? '?'}`,
    };

    document.getElementById('file-history-modal')?.classList.add('hidden');
    const opened = Viewer.open(previewFile);
    if (!opened) {
      document.getElementById('file-history-modal')?.classList.remove('hidden');
      App.toast('Could not open preview', 'error');
    }
  },

  downloadVersion(versionId) {
    if (!this.file) return;
    window.location.href = API.files.historyDownload(this.file.id, versionId);
  },

  async restoreVersion(versionId) {
    if (!this.file) return;
    const v = this.data?.versions?.find((x) => x.id === versionId);
    if (!v || v.isCurrent) return;

    const label = `Version ${v.versionNum} (${formatSize(v.size)})`;
    if (!confirm(`Restore ${label}?\n\nThe current file will be saved to history first, then replaced with this version.`)) {
      return;
    }

    try {
      App.toast('Restoring version…', 'info');
      const result = await API.files.historyRestore(this.file.id, versionId);
      if (result.unchanged) {
        App.toast('File already matches this version', 'info');
      } else {
        App.toast(`Restored ${label}`, 'success');
      }
      document.getElementById('file-history-modal')?.classList.add('hidden');
      document.getElementById('version-details-modal')?.classList.add('hidden');
      if (typeof App.refreshAll === 'function') App.refreshAll();
    } catch (err) {
      App.toast(err.message || 'Restore failed', 'error');
    }
  },

  formatWhen(iso) {
    if (!iso) return 'Unknown date';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'Unknown date';

    const now = Date.now();
    const diff = now - d.getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;

    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  },

  formatSource(source) {
    const map = {
      upload: { label: 'Upload', desc: 'Saved when the file was uploaded or re-synced with new content.' },
      sync: { label: 'Vault Sync', desc: 'Snapshot from a Vault Sync edit — previous chunks remain on GitHub.' },
      repair: { label: 'Repair', desc: 'Saved after a verify/repair run fixed or replaced file chunks.' },
      git: { label: 'Git history', desc: 'Recovered from a past metadata commit on GitHub.' },
      restore: { label: 'Restore', desc: 'Snapshot taken during a version restore operation.' },
    };
    return map[source] || { label: source || 'Saved', desc: 'Content snapshot recorded on the server.' };
  },

  formatGitCommit(message) {
    const raw = (message || '').split('\n')[0].trim();
    if (!raw) return 'Metadata updated on GitHub';
    if (/^vault:\s*store chunk/i.test(raw)) return 'Metadata saved on GitHub';
    if (/^vault:/i.test(raw)) return raw.replace(/^vault:\s*/i, '').replace(/^\w/, (c) => c.toUpperCase());
    return raw;
  },

  escape(s) {
    const el = document.createElement('span');
    el.textContent = s ?? '';
    return el.innerHTML;
  },
};
