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

    ShareStreamLog?.info('download:job-start', { fileId: file.id, name: file.name, size: file.size });

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
      pendingParts: [],
      saveDir: null,
      savedFiles: [],
    };
    this.jobs.set(jobId, job);
    this.render();

    const fileSize = file.size || 0;
    if (ShareDownload.isLargeFile(fileSize) && ShareDownload.canUseDirectoryPicker()) {
      try {
        job.saveDir = await ShareDownload.pickSaveDirectory();
        job.status = { stage: 'starting', progress: 0, percent: 0 };
        this.renderItem(job);
      } catch (err) {
        if (err?.name !== 'AbortError' && typeof App !== 'undefined') {
          App.toast(err.message, 'error');
        }
      }
    }

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
      }, { dirHandle: job.saveDir });

      job.pendingParts = result.pendingParts || [];
      job.savedFiles = result.savedFiles || [];
      job.splitParts = result.mode === 'split' ? result.parts : null;
      job.done = job.pendingParts.length === 0 && job.savedFiles.length > 0;
      if (job.saveDir && job.pendingParts.length === 0 && job.savedFiles.length === 0) {
        throw new Error('No files were saved to the selected folder');
      }
      job.status = {
        ...ShareClientStream.getDownloadStatus(),
        percent: job.done ? 100 : (job.status?.percent ?? job.status?.progress ?? 0),
        progress: job.done ? 100 : (job.status?.progress ?? 0),
        ready: job.done,
        stage: job.pendingParts.length ? 'caching' : (job.done ? 'done' : 'ready'),
      };
      this.render();

      if (job.pendingParts.length) {
        this.notifyDownload(`${job.pendingParts.length} zip part(s) ready — click Save below for each file`);
      } else if (job.done) {
        const names = job.savedFiles.map((f) => f.name).join(', ');
        ShareStreamLog?.info('download:job-done', { files: job.savedFiles.length, names });
        this.notifyDownload(job.saveDir
          ? `Saved to folder: ${names}`
          : `Downloaded ${file.name}`);
        if (!job.saveDir) setTimeout(() => this.removeJob(job.id), 8000);
      }
    } catch (err) {
      job.error = err.message;
      job.done = false;
      job.pendingParts = [];
      job.savedFiles = [];
      ShareStreamLog?.error('download:job-failed', { message: err.message });
      this.render();
      this.notifyDownload(err.message, 'error');
    }
  },

  async savePendingPart(jobId, partIndex) {
    const job = this.jobs.get(jobId);
    const part = job?.pendingParts?.[partIndex];
    if (!part) return;
    await ShareDownload.triggerSaveAnchor(part.blob, part.name);
    job.pendingParts.splice(partIndex, 1);
    job.savedFiles.push({ name: part.name, size: part.blob.size });
    if (!job.pendingParts.length) {
      job.done = true;
      job.status = { ...job.status, stage: 'done', ready: true, percent: 100, progress: 100 };
      this.notifyDownload(`Downloaded ${job.fileName}`);
      setTimeout(() => this.removeJob(job.id), 8000);
    }
    this.render();
  },

  notifyDownload(message, type = 'success') {
    if (typeof App !== 'undefined') App.toast(message, type);
  },

  formatSavedSize(size) {
    return typeof formatSize === 'function' ? formatSize(size) : `${size} B`;
  },

  jobSavedFilesHtml(job) {
    if (!job.savedFiles?.length) return '';
    return `
          <ul class="download-saved-files">
            ${job.savedFiles.map((f) => `<li>${this.escape(f.name)} · ${this.escape(this.formatSavedSize(f.size))}</li>`).join('')}
          </ul>`;
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
    if (job) job.pendingParts = [];
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
    const percent = job.error ? 0 : job.done ? 100 : (status?.percent ?? status?.progress ?? 0);
    const detail = this.jobDetailText(job);

    el.classList.toggle('download-item-done', !!job.done && !job.error && !job.pendingParts?.length);
    el.classList.toggle('download-item-error', !!job.error);
    el.classList.toggle('download-item-pending', !!job.pendingParts?.length);

    const fill = el.querySelector('.download-bar-fill');
    if (fill) fill.style.width = `${percent}%`;
    const detailEl = el.querySelector('.download-detail');
    if (detailEl) detailEl.textContent = detail;
    const pctEl = el.querySelector('.download-percent');
    if (pctEl) pctEl.textContent = job.error ? 'Failed' : job.pendingParts?.length ? 'Save' : job.done ? 'Done' : `${percent}%`;

    if (job.done || job.error || job.pendingParts?.length) {
      el.querySelector('.download-chunk-blocks')?.remove();
      el.querySelector('.download-bar')?.remove();
      const progressEl = el.querySelector('.download-progress');
      if (progressEl) progressEl.innerHTML = this.jobProgressHtml(job);
      if (job.blocks) {
        ChunkBlocks.destroy(job.blocks);
        job.blocks = null;
      }
    } else if (job.blocks && status) {
      ChunkBlocks.update(job.blocks, ChunkBlocks.fromDownloadStatus(status));
    }
  },

  jobDetailText(job) {
    if (job.error) return job.error;
    if (job.pendingParts?.length) {
      return `Click Save for each remaining zip part (${job.pendingParts.length} left)`;
    }
    if (job.done && job.savedFiles?.length) {
      if (job.saveDir) {
        const names = job.savedFiles.map((f) => f.name).join(', ');
        return `Saved to your folder: ${names}`;
      }
      if (job.splitParts) {
        return `Saved ${job.splitParts} zip part(s) — see README in part 1`;
      }
      return job.saveDir ? 'Saved to your selected folder' : 'Saved to your downloads folder';
    }
    if (job.done) {
      if (job.splitParts) {
        return job.saveDir
          ? `Saved ${job.splitParts} zip part(s) to your folder`
          : `Saved ${job.splitParts} zip part(s) — combine using README in part 1`;
      }
      return job.saveDir ? 'Saved to your selected folder' : 'Saved to your downloads folder';
    }
    const status = job.status;
    if (!status) return 'Preparing...';
    return `${this.stageLabel(status.stage)} · ${status.fetched ?? status.segments ?? 0} / ${status.total || status.total_segments || job.total} ${status.stage === 'caching' ? 'parts' : 'chunks'}`;
  },

  jobPendingPartsHtml(job) {
    if (!job.pendingParts?.length) return '';
    return `
          <div class="download-pending-parts">
            ${job.pendingParts.map((part, index) => `
              <button type="button" class="btn-secondary download-save-part" data-job-id="${job.id}" data-part-index="${index}">
                Save ${this.escape(part.name)}
              </button>
            `).join('')}
          </div>`;
  },

  jobProgressHtml(job) {
    if (job.error) return '';
    if (job.done && job.savedFiles?.length) return this.jobSavedFilesHtml(job);
    if (job.pendingParts?.length) return this.jobPendingPartsHtml(job);
    const status = job.status;
    const percent = status?.percent ?? status?.progress ?? 0;
    return `
          <div class="download-chunk-blocks chunk-blocks-wrap"></div>
          <div class="download-bar">
            <div class="download-bar-fill" data-bar="${percent}" style="width: ${percent}%;"></div>
          </div>`;
  },

  render() {
    const panel = document.getElementById('download-panel');
    const list = document.getElementById('download-list');
    if (!panel || !list) return;

    const items = [...this.jobs.values()];
    panel.classList.toggle('hidden', items.length === 0);

    list.innerHTML = items.map((job) => {
      const status = job.status;
      const percent = job.error ? 0 : job.done ? 100 : (status?.percent ?? status?.progress ?? 0);
      const detail = this.jobDetailText(job);

      return `
        <div class="download-item${job.error ? ' download-item-error' : ''}${job.done ? ' download-item-done' : ''}${job.pendingParts?.length ? ' download-item-pending' : ''}" data-job-id="${job.id}">
          <div class="download-item-header">
            <span class="download-icon">${job.error ? '⚠️' : job.done ? '✓' : job.pendingParts?.length ? '💾' : '⬇️'}</span>
            <span class="download-title" title="${this.escape(job.fileName)}">${this.escape(job.fileName)}</span>
            <span class="download-percent">${job.error ? 'Failed' : job.pendingParts?.length ? 'Save' : job.done ? 'Done' : `${percent}%`}</span>
            ${job.done || job.error || job.pendingParts?.length ? `<button type="button" class="download-dismiss" data-job-id="${job.id}" title="Dismiss">×</button>` : ''}
          </div>
          <div class="download-detail">${this.escape(detail)}</div>
          <div class="download-progress">${this.jobProgressHtml(job)}</div>
        </div>
      `;
    }).join('');

    applyDynamicStyles(list);

    for (const job of items) {
      if (job.done || job.error || job.pendingParts?.length) continue;
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

  },

  bindEvents() {
    const list = document.getElementById('download-list');
    if (!list || list.dataset.bound) return;
    list.dataset.bound = '1';
    list.addEventListener('click', (ev) => {
      const saveBtn = ev.target.closest('.download-save-part');
      if (saveBtn) {
        ev.preventDefault();
        this.savePendingPart(saveBtn.dataset.jobId, Number(saveBtn.dataset.partIndex));
        return;
      }
      const dismissBtn = ev.target.closest('.download-dismiss');
      if (dismissBtn) {
        ev.preventDefault();
        this.dismiss(dismissBtn.dataset.jobId);
      }
    });
  },
};
