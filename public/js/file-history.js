/**
 * File version history UI — preview, restore, and chunk details.
 */
const FileHistory = {
  file: null,
  data: null,

  init() {
    const modal = document.getElementById('file-history-modal');
    modal?.addEventListener('click', (e) => {
      const preview = e.target.closest('[data-history-preview]');
      const download = e.target.closest('[data-history-download]');
      const details = e.target.closest('[data-history-details]');
      const restore = e.target.closest('[data-history-restore]');
      const back = e.target.closest('[data-history-back]');
      if (preview) this.previewVersion(parseInt(preview.dataset.historyPreview, 10));
      if (download) this.downloadVersion(parseInt(download.dataset.historyDownload, 10));
      if (details) this.showVersionDetails(parseInt(details.dataset.historyDetails, 10));
      if (restore) this.restoreVersion(parseInt(restore.dataset.historyRestore, 10));
      if (back) this.showList();
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
    if (!file || file.is_folder) return;
    this.file = file;
    this.data = null;
    const modal = document.getElementById('file-history-modal');
    const body = document.getElementById('file-history-body');
    const title = document.getElementById('file-history-title');
    const subtitle = document.getElementById('file-history-subtitle');
    const icon = document.getElementById('file-history-icon');
    if (!modal || !body) return;

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
