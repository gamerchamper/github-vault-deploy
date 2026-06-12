/**
 * Dedicated Upload Center — Active / Completed / Failed / Paused
 */
const UploadCenter = {
  tab: 'active',
  visible: false,

  init() {
    this.bindChrome();
  },

  bindChrome() {
    document.getElementById('btn-upload-center')?.addEventListener('click', () => this.toggle());
    document.getElementById('upload-center-close')?.addEventListener('click', () => this.hide());
    document.querySelectorAll('.upload-center-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        this.tab = tab.dataset.tab;
        this.syncTabs();
        this.render();
      });
    });
    document.getElementById('upload-center-list')?.addEventListener('click', async (e) => {
      const resume = e.target.closest('[data-upload-resume]');
      const pause = e.target.closest('[data-upload-pause]');
      const cancel = e.target.closest('[data-upload-cancel]');
      const dismiss = e.target.closest('[data-upload-dismiss]');
      const id = (resume || pause || cancel || dismiss)?.dataset.uploadResume
        || (resume || pause || cancel || dismiss)?.dataset.uploadPause
        || (resume || pause || cancel || dismiss)?.dataset.uploadCancel
        || (resume || pause || cancel || dismiss)?.dataset.uploadDismiss;
      if (!id) return;
      if (resume) await TaskPanel.resumeUpload(id);
      if (pause) await TaskPanel.pauseUpload(id);
      if (cancel) {
        if (!confirm('Cancel this upload?')) return;
        await UploadManager.cancel(id);
      }
      if (dismiss) await TaskPanel.dismissTask(id);
      this.render();
    });
  },

  toggle() {
    this.visible = !this.visible;
    document.getElementById('upload-center')?.classList.toggle('hidden', !this.visible);
    if (this.visible) this.render();
  },

  hide() {
    this.visible = false;
    document.getElementById('upload-center')?.classList.add('hidden');
  },

  syncTabs() {
    document.querySelectorAll('.upload-center-tab').forEach((el) => {
      el.classList.toggle('active', el.dataset.tab === this.tab);
      el.setAttribute('aria-selected', el.dataset.tab === this.tab ? 'true' : 'false');
    });
  },

  uploadTasks() {
    return [...TaskPanel.tasks.values()].filter((t) => t.type === 'upload');
  },

  filterTasks() {
    const uploads = this.uploadTasks();
    if (this.tab === 'active') {
      return uploads.filter((t) => t.status === 'processing' || t.status === 'pending');
    }
    if (this.tab === 'paused') {
      return uploads.filter((t) => t.status === 'paused');
    }
    if (this.tab === 'failed') {
      return uploads.filter((t) => t.status === 'error');
    }
    if (this.tab === 'completed') {
      return uploads.filter((t) => t.status === 'done');
    }
    return uploads;
  },

  formatSpeed(task) {
    if (!task.bytesPerSec) return '—';
    return `${formatSize(task.bytesPerSec)}/s`;
  },

  render() {
    const list = document.getElementById('upload-center-list');
    if (!list) return;
    this.syncTabs();
    const items = this.filterTasks();

    const counts = {
      active: this.uploadTasks().filter((t) => t.status === 'processing' || t.status === 'pending').length,
      paused: this.uploadTasks().filter((t) => t.status === 'paused').length,
      failed: this.uploadTasks().filter((t) => t.status === 'error').length,
      completed: this.uploadTasks().filter((t) => t.status === 'done').length,
    };
    document.querySelectorAll('.upload-center-tab-count').forEach((el) => {
      const tab = el.dataset.for;
      if (counts[tab] != null) el.textContent = counts[tab] || '';
    });

    if (!items.length) {
      list.innerHTML = `<div class="upload-center-empty">No ${this.tab} uploads</div>`;
      return;
    }

    list.innerHTML = items.map((task) => {
      const pct = task.percent || 0;
      const failed = task.status === 'error';
      const paused = task.status === 'paused';
      const active = task.status === 'processing' || task.status === 'pending';
      const resumable = (failed || paused) && task.resumable !== false;

      let actions = '';
      if (resumable) {
        actions = `<button class="btn-secondary" data-upload-resume="${task.id}">Resume</button>
          <button class="btn-secondary" data-upload-cancel="${task.id}">Cancel</button>`;
      } else if (active) {
        actions = `<button class="btn-secondary" data-upload-pause="${task.id}">Pause</button>
          <button class="btn-secondary" data-upload-cancel="${task.id}">Cancel</button>`;
      } else if (failed) {
        actions = `<button class="btn-secondary" data-upload-dismiss="${task.id}">Dismiss</button>`;
      }

      return `
        <div class="upload-center-item">
          <div class="upload-center-item-header">
            <span class="upload-center-name">${this.escape(task.title || task.fileName || 'Upload')}</span>
            <span class="upload-center-pct">${failed ? 'Failed' : `${pct}%`}</span>
          </div>
          <div class="upload-center-detail">${TaskPanel.label(task)}</div>
          <div class="upload-center-bar"><div class="upload-center-bar-fill" style="width:${pct}%"></div></div>
          <div class="upload-center-meta">
            <span>${this.formatSpeed(task)}</span>
            <span>${task.fileSize ? formatSize(task.fileSize) : ''}</span>
          </div>
          <div class="upload-center-actions">${actions}</div>
        </div>
      `;
    }).join('');
  },

  escape(s) {
    const el = document.createElement('span');
    el.textContent = s || '';
    return el.innerHTML;
  },
};

// Hook into TaskPanel renders
const _taskRender = TaskPanel.render.bind(TaskPanel);
TaskPanel.render = function (...args) {
  _taskRender(...args);
  if (UploadCenter.visible) UploadCenter.render();
};
