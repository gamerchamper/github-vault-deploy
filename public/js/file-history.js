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
    if (!modal || !body) return;

    title.textContent = `History — ${file.name}`;
    body.innerHTML = '<p class="modal-desc">Loading versions…</p>';
    preview?.classList.add('hidden');
    if (preview) preview.innerHTML = '';
    modal.classList.remove('hidden');

    try {
      const data = await API.files.history(file.id);
      this.data = data;
      this.render(data);
    } catch (err) {
      body.innerHTML = `<p class="modal-desc">${this.escape(err.message)}</p>`;
    }
  },

  render(data) {
    const body = document.getElementById('file-history-body');
    if (!data.enabled) {
      body.innerHTML = '<p class="modal-desc">File history is disabled on this server.</p>';
      return;
    }
    if (!data.versions?.length) {
      body.innerHTML = `
        <p class="modal-desc">No saved versions yet. Versions are recorded when file content changes after an upload or vault sync.</p>
        ${this.renderGitSection(data.gitCommits)}
      `;
      return;
    }

    const previewType = getPreviewType(this.file.name, this.file.mime_type);
    const rows = data.versions.map((v) => {
      const when = v.createdAt ? new Date(v.createdAt).toLocaleString() : '—';
      const badge = v.isCurrent ? '<span class="history-badge">Current</span>' : '';
      const source = v.source ? `<span class="history-source">${this.escape(v.source)}</span>` : '';
      const previewBtn = previewType
        ? `<button type="button" class="btn-ghost btn-sm" data-history-preview="${v.id}">Preview</button>`
        : '';
      return `
        <tr>
          <td>v${v.versionNum} ${badge}</td>
          <td>${when}</td>
          <td>${formatSize(v.size)}</td>
          <td>${source}</td>
          <td class="history-actions">
            ${previewBtn}
            <button type="button" class="btn-ghost btn-sm" data-history-download="${v.id}">Download</button>
          </td>
        </tr>
      `;
    }).join('');

    body.innerHTML = `
      <p class="modal-desc">Snapshots are taken when content changes. Older chunks are loaded from Git by blob SHA.</p>
      <div class="file-history-table-wrap">
        <table class="file-history-table">
          <thead>
            <tr><th>Version</th><th>Date</th><th>Size</th><th>Source</th><th></th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      ${this.renderGitSection(data.gitCommits)}
    `;
  },

  renderGitSection(commits) {
    if (!commits?.length) return '';
    const items = commits.slice(0, 12).map((c) => {
      const when = c.date ? new Date(c.date).toLocaleString() : '';
      const msg = (c.message || '').split('\n')[0].trim() || '(no message)';
      return `<li><time>${when}</time> <span>${this.escape(msg)}</span> <code class="history-sha">${(c.sha || '').slice(0, 7)}</code></li>`;
    }).join('');
    return `
      <div class="file-history-git">
        <h3>Git manifest commits</h3>
        <ul class="file-history-git-list">${items}</ul>
      </div>
    `;
  },

  previewVersion(versionId) {
    if (!this.file) return;
    const url = API.files.historyView(this.file.id, versionId);
    const type = getPreviewType(this.file.name, this.file.mime_type);
    const preview = document.getElementById('file-history-preview');

    if (type === 'image' && preview) {
      preview.innerHTML = `<img src="${url}" alt="" class="file-history-preview-img">`;
      preview.classList.remove('hidden');
      return;
    }

    if (type === 'video' || type === 'audio' || type === 'pdf') {
      window.open(url, '_blank', 'noopener');
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

document.addEventListener('DOMContentLoaded', () => FileHistory.init());
