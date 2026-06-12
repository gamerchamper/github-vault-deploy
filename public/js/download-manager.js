const DownloadManager = {
  jobs: new Map(),
  pollTimer: null,
  playlistMode: false,

  publicApiBase(token) {
    return this.playlistMode
      ? `/api/public/playlist/${token}`
      : `/api/public/share/${token}`;
  },

  async downloadFile(file, options = {}) {
    const view = options.view ?? (typeof explorer !== 'undefined' ? explorer.accountView : null);
    const publicToken = options.token || null;
    const fileId = file.id;
    const fileName = file.name;

    if (publicToken && file.client_stream) {
      return this.downloadClientShare(file, publicToken);
    }

    const jobId = publicToken ? `pub:${fileId}` : `file:${fileId}:${view || 'primary'}`;
    if (this.jobs.has(jobId)) return;

    const job = {
      id: jobId,
      fileId,
      fileName,
      view,
      token: publicToken,
      sessionId: null,
      authToken: null,
      total: file.chunk_count || 1,
      status: null,
      blocks: null,
      done: false,
    };
    this.jobs.set(jobId, job);
    this.render();
    this.ensurePoll();

    try {
      const prepare = publicToken
        ? await this.preparePublic(publicToken, fileId)
        : await API.files.downloadPrepare(fileId, view);

      job.sessionId = prepare.sessionId;
      job.authToken = prepare.authToken;
      job.total = prepare.total || job.total;
      this.render();
    } catch (err) {
      job.error = err.message;
      job.done = true;
      this.render();
      if (typeof App !== 'undefined') App.toast(err.message, 'error');
    }
  },

  async preparePublic(token, fileId) {
    const qs = fileId ? `?file=${encodeURIComponent(fileId)}` : '';
    const res = await fetch(`${this.publicApiBase(token)}/download/prepare${qs}`, {
      method: 'POST',
      credentials: 'same-origin',
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Download failed');
    }
    return res.json();
  },

  async downloadClientShare(file, token) {
    const jobId = `pub:${file.id}`;
    if (this.jobs.has(jobId)) return;

    const job = {
      id: jobId,
      fileId: file.id,
      fileName: file.name,
      view: null,
      token,
      sessionId: 'client',
      authToken: null,
      total: file.chunk_count || 1,
      status: null,
      blocks: null,
      done: false,
    };
    this.jobs.set(jobId, job);
    this.render();

    try {
      const result = await ShareDownload.exportShare(token, file, (status) => {
        job.status = status;
        if (job.blocks) {
          ChunkBlocks.update(job.blocks, ChunkBlocks.fromDownloadStatus(status));
        } else {
          const mountEl = document.querySelector(`.download-item[data-job-id="${job.id}"] .download-chunk-blocks`);
          if (mountEl) {
            job.blocks = ChunkBlocks.mount(mountEl, { total: status.total_segments || job.total, label: 'Download blocks' });
            ChunkBlocks.update(job.blocks, ChunkBlocks.fromDownloadStatus(status));
          }
        }
        this.renderItem(job);
      });

      job.done = true;
      job.splitParts = result.mode === 'split' ? result.parts : null;
      job.status = {
        ...ShareClientStream.getDownloadStatus(),
        percent: 100,
        ready: true,
        stage: result.mode === 'split' ? 'done' : 'ready',
      };
      this.renderItem(job);

      const msg = result.mode === 'split'
        ? `Saved ${result.parts} zip part(s) — see README in part 1`
        : `Downloaded ${file.name}`;
      if (typeof App !== 'undefined') App.toast(msg, 'success');
      setTimeout(() => this.removeJob(job.id), 6000);
    } catch (err) {
      job.error = err.message;
      job.done = true;
      this.render();
      if (typeof App !== 'undefined') App.toast(err.message, 'error');
    } finally {
      ShareClientStream.abort();
    }
  },

  downloadUrl(job) {
    if (job.token) {
      const qs = new URLSearchParams();
      if (job.fileId) qs.set('file', job.fileId);
      qs.set('session', job.sessionId);
      if (job.authToken) qs.set('auth', job.authToken);
      return `${this.publicApiBase(job.token)}/download?${qs.toString()}`;
    }
    const base = API.files.download(job.fileId, job.view);
    const sep = base.includes('?') ? '&' : '?';
    const parts = [`session=${encodeURIComponent(job.sessionId)}`];
    if (job.authToken) parts.push(`auth=${encodeURIComponent(job.authToken)}`);
    return `${base}${sep}${parts.join('&')}`;
  },

  statusUrl(job) {
    if (job.token) {
      const qs = job.fileId ? `?file=${encodeURIComponent(job.fileId)}` : '';
      return `${this.publicApiBase(job.token)}/download/status/${job.sessionId}${qs}`;
    }
    return `/api/files/download/status/${job.sessionId}`;
  },

  triggerSave(job) {
    const a = document.createElement('a');
    a.href = this.downloadUrl(job);
    a.download = job.fileName;
    a.click();
  },

  ensurePoll() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.pollAll(), 800);
  },

  stopPollIfIdle() {
    const active = [...this.jobs.values()].some((j) => !j.done && !j.error);
    if (!active && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  },

  async pollAll() {
    for (const job of this.jobs.values()) {
      if (job.done || job.error || !job.sessionId) continue;
      try {
        const res = await fetch(this.statusUrl(job), { credentials: 'same-origin' });
        if (!res.ok) continue;
        const status = await res.json();
        job.status = status;

        if (job.blocks) {
          ChunkBlocks.update(job.blocks, ChunkBlocks.fromDownloadStatus(status));
        } else {
          const mountEl = document.querySelector(`.download-item[data-job-id="${job.id}"] .download-chunk-blocks`);
          if (mountEl) {
            job.blocks = ChunkBlocks.mount(mountEl, { total: status.total || job.total, label: 'Download blocks' });
            ChunkBlocks.update(job.blocks, ChunkBlocks.fromDownloadStatus(status));
          }
        }

        this.renderItem(job);

        if (status.error) {
          job.error = status.error;
          job.done = true;
          if (typeof App !== 'undefined') App.toast(`${job.fileName}: ${status.error}`, 'error');
        } else if (status.ready) {
          job.done = true;
          this.triggerSave(job);
          if (typeof App !== 'undefined') App.toast(`Downloaded ${job.fileName}`, 'success');
          setTimeout(() => this.removeJob(job.id), 4000);
        }
      } catch { /* retry */ }
    }
    this.stopPollIfIdle();
  },

  removeJob(jobId) {
    const job = this.jobs.get(jobId);
    if (job?.blocks) ChunkBlocks.destroy(job.blocks);
    this.jobs.delete(jobId);
    this.render();
    this.stopPollIfIdle();
  },

  dismiss(jobId) {
    this.removeJob(jobId);
  },

  stageLabel(stage) {
    return ChunkBlocks.stageLabel(stage);
  },

  escape(str) {
    const el = document.createElement('span');
    el.textContent = str || '';
    return el.innerHTML;
  },

  renderItem(job) {
    const el = document.querySelector(`.download-item[data-job-id="${job.id}"]`);
    if (!el) return;
    const status = job.status;
    const percent = job.error ? 0 : (status?.percent ?? 0);
    const detail = job.error
      ? job.error
      : job.done
        ? (job.splitParts
          ? `Saved ${job.splitParts} zip part(s) — combine using README in part 1`
          : 'Saved to your downloads folder')
        : status
          ? `${this.stageLabel(status.stage)} · ${status.fetched ?? status.segments ?? 0} / ${status.total || status.total_segments || job.total} ${status.stage === 'caching' ? 'parts' : 'chunks'}`
          : 'Preparing...';

    const fill = el.querySelector('.download-bar-fill');
    if (fill) fill.style.width = `${percent}%`;
    const detailEl = el.querySelector('.download-detail');
    if (detailEl) detailEl.textContent = detail;
    const pctEl = el.querySelector('.download-percent');
    if (pctEl) pctEl.textContent = job.error ? 'Failed' : job.done ? 'Done' : `${percent}%`;
  },

  render() {
    const panel = document.getElementById('download-panel');
    const list = document.getElementById('download-list');
    if (!panel || !list) return;

    const items = [...this.jobs.values()];
    panel.classList.toggle('hidden', items.length === 0);

    list.innerHTML = items.map((job) => {
      const status = job.status;
      const percent = job.error ? 0 : (status?.percent ?? (job.done ? 100 : 0));
      const detail = job.error
        ? job.error
        : job.done
          ? (job.splitParts
          ? `Saved ${job.splitParts} zip part(s) — combine using README in part 1`
          : 'Saved to your downloads folder')
          : status
            ? `${this.stageLabel(status.stage)} · ${status.fetched ?? status.segments ?? 0} / ${status.total || status.total_segments || job.total} ${status.stage === 'caching' ? 'parts' : 'chunks'}`
            : 'Preparing...';

      return `
        <div class="download-item${job.error ? ' download-item-error' : ''}${job.done ? ' download-item-done' : ''}" data-job-id="${job.id}">
          <div class="download-item-header">
            <span class="download-icon">${job.error ? '⚠️' : job.done ? '✓' : '⬇️'}</span>
            <span class="download-title" title="${this.escape(job.fileName)}">${this.escape(job.fileName)}</span>
            <span class="download-percent">${job.error ? 'Failed' : job.done ? 'Done' : `${percent}%`}</span>
            ${job.done || job.error ? `<button type="button" class="download-dismiss" data-job-id="${job.id}" title="Dismiss">×</button>` : ''}
          </div>
          <div class="download-detail">${this.escape(detail)}</div>
          <div class="download-chunk-blocks chunk-blocks-wrap"></div>
          <div class="download-bar">
            <div class="download-bar-fill" style="width:${percent}%"></div>
          </div>
        </div>
      `;
    }).join('');

    for (const job of items) {
      if (job.blocks && job.status) {
        ChunkBlocks.update(job.blocks, ChunkBlocks.fromDownloadStatus(job.status));
        continue;
      }
      const mountEl = list.querySelector(`.download-item[data-job-id="${job.id}"] .download-chunk-blocks`);
      if (mountEl && (job.sessionId || job.total) && !mountEl.querySelector('.chunk-blocks-grid')) {
        job.blocks = ChunkBlocks.mount(mountEl, { total: job.total, label: 'Download blocks' });
        if (job.status) ChunkBlocks.update(job.blocks, ChunkBlocks.fromDownloadStatus(job.status));
      }
    }

    list.querySelectorAll('.download-dismiss').forEach((btn) => {
      btn.addEventListener('click', () => this.dismiss(btn.dataset.jobId));
    });
  },

  bindEvents() {
    const list = document.getElementById('download-list');
    if (!list || list.dataset.bound) return;
    list.dataset.bound = '1';
  },
};
