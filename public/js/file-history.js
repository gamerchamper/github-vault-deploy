/**
 * Experimental file version history UI.
 */
const FileHistory = {
  file: null,
  data: null,

  init() {
    document.getElementById('file-history-modal')?.addEventListener('click', (e) => {
      const preview = e.target.closest('[data-history-preview]');
      const download = e.target.closest('[data-history-download]');
      if (preview) this.previewVersion(parseInt(preview.dataset.historyPreview, 10));
      if (download) this.downloadVersion(parseInt(download.dataset.historyDownload, 10));
    });
  },

  async open(file) {
    if (!file || file.is_folder) return;
    this.file = file;
    const modal = document.getElementById('file-history-modal');
    const body = document.getElementById('file-history-body');
    const preview = document.getElementById('file-history-preview');
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
    preview?.classList.add('hidden');
    if (preview) preview.innerHTML = '';
    modal.classList.remove('hidden');

    try {
      const data = await API.files.history(file.id);
      this.data = data;
      this.render(data);
    } catch (err) {
      body.innerHTML = `<div class="file-history-empty"><p>${this.escape(err.message)}</p></div>`;
    }
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
        <p>Each time this file’s <strong>content</strong> changes (upload, edit + sync, or repair), a snapshot is saved. Open or download any past version.</p>
      </div>`;

    if (!data.versions?.length) {
      body.innerHTML = `
        ${intro}
        <div class="file-history-empty">
          <div class="file-history-empty-icon">🕐</div>
          <p class="file-history-empty-title">No versions yet</p>
          <p class="file-history-empty-desc">Edit this file locally and let Vault Sync upload the change — the first snapshot will appear here.</p>
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
    const previewBtn = previewType
      ? `<button type="button" class="btn-secondary btn-sm" data-history-preview="${v.id}">Preview</button>`
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
            <button type="button" class="btn-primary btn-sm" data-history-download="${v.id}">Download</button>
          </div>
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
        <p class="file-history-git-intro">When file metadata is saved, GitHub records a commit. This is separate from content snapshots but helps confirm when the vault index changed.</p>
        <ul class="file-history-git-list">${items}</ul>
      </section>
    `;
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
      sync: { label: 'Vault Sync', desc: 'Updated when Vault Sync detected a local edit and pushed changes.' },
      repair: { label: 'Repair', desc: 'Saved after a verify/repair run fixed or replaced file chunks.' },
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

  previewVersion(versionId) {
    if (!this.file) return;
    const url = API.files.historyView(this.file.id, versionId);
    const type = getPreviewType(this.file.name, this.file.mime_type);
    const preview = document.getElementById('file-history-preview');

    if (type === 'image' && preview) {
      preview.innerHTML = `
        <div class="file-history-preview-bar">
          <span>Previewing saved version</span>
          <button type="button" class="btn-ghost btn-sm" data-history-preview-close>Close preview</button>
        </div>
        <img src="${url}" alt="" class="file-history-preview-img">`;
      preview.classList.remove('hidden');
      preview.querySelector('[data-history-preview-close]')?.addEventListener('click', () => {
        preview.classList.add('hidden');
        preview.innerHTML = '';
      });
      return;
    }

    window.open(url, '_blank', 'noopener');
  },

  downloadVersion(versionId) {
    if (!this.file) return;
    window.location.href = API.files.historyDownload(this.file.id, versionId);
  },

  escape(s) {
    const el = document.createElement('span');
    el.textContent = s ?? '';
    return el.innerHTML;
  },
};
