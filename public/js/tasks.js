const TaskPanel = {
  tasks: new Map(),
  pollTimer: null,
  doneTimers: new Map(),
  expandedTaskId: null,
  panelExpanded: false,
  _renderScheduled: false,

  scheduleRender() {
    if (this._renderScheduled) return;
    this._renderScheduled = true;
    requestAnimationFrame(() => {
      this._renderScheduled = false;
      this.render();
    });
  },

  async init() {
    try {
      const saved = localStorage.getItem('vault-task-panel-expanded');
      this.panelExpanded = saved === 'true';
      const { tasks } = await API.tasks.list({ resumable: true });
      for (const task of tasks) this.tasks.set(task.id, task);
      await UploadManager.restoreInterrupted();
      this.render();
      this.ensurePoll();
      this.bindActions();
      this.bindPanelChrome();
    } catch (err) {
      console.error('TaskPanel init failed:', err);
    }
  },

  bindPanelChrome() {
    const mini = document.getElementById('task-panel-mini');
    const collapse = document.getElementById('task-panel-collapse');
    if (mini && !mini.dataset.bound) {
      mini.dataset.bound = '1';
      mini.addEventListener('click', () => this.setExpanded(true));
    }
    if (collapse && !collapse.dataset.bound) {
      collapse.dataset.bound = '1';
      collapse.addEventListener('click', (e) => {
        e.stopPropagation();
        this.setExpanded(!this.panelExpanded);
      });
    }
  },

  setExpanded(expanded) {
    this.panelExpanded = !!expanded;
    localStorage.setItem('vault-task-panel-expanded', this.panelExpanded ? 'true' : 'false');
    this.render();
  },

  activeTasks() {
    return [...this.tasks.values()].filter(
      (t) => t.status === 'processing' || t.status === 'pending' || t.status === 'paused'
        || (t.status === 'error' && t.resumable !== false)
    );
  },

  errorCount() {
    return this.failedTasks().length;
  },

  updateChrome(items) {
    const panel = document.getElementById('task-panel');
    const mini = document.getElementById('task-panel-mini');
    const badge = document.getElementById('task-badge');
    const counter = document.getElementById('task-panel-counter');
    const collapse = document.getElementById('task-panel-collapse');
    const active = this.activeTasks().length;
    const errors = this.errorCount();
    const hasTasks = items.length > 0;

    if (badge) {
      badge.textContent = String(active || items.length);
      badge.classList.toggle('error', errors > 0 && active === 0);
      badge.classList.toggle('hidden', !hasTasks);
    }
    if (counter) {
      counter.textContent = hasTasks
        ? `${active} active${errors ? ` · ${errors} failed` : ''}`
        : '';
    }
    if (mini) {
      mini.classList.toggle('hidden', !hasTasks || this.panelExpanded);
      mini.setAttribute('aria-label', `${active || items.length} background task${items.length === 1 ? '' : 's'}`);
    }
    if (panel) {
      panel.classList.toggle('hidden', !hasTasks);
      panel.classList.toggle('collapsed', !this.panelExpanded);
      panel.classList.toggle('expanded', this.panelExpanded);
    }
    if (collapse) {
      collapse.textContent = this.panelExpanded ? '▼' : '▲';
      collapse.title = this.panelExpanded ? 'Minimize panel' : 'Expand panel';
    }
  },

  bindActions() {
    const list = document.getElementById('task-list');
    if (!list || list.dataset.bound) return;
    list.dataset.bound = '1';
    list.addEventListener('click', async (e) => {
      const resumeBtn = e.target.closest('.task-btn-resume');
      const pauseBtn = e.target.closest('.task-btn-pause');
      const cancelBtn = e.target.closest('.task-btn-cancel');
      const restartBtn = e.target.closest('.task-btn-restart');
      const retryHlsBtn = e.target.closest('.task-btn-hls-retry');
      const dismissBtn = e.target.closest('.task-btn-dismiss');
      const backupForceBtn = e.target.closest('.task-btn-backup-force');
      const taskItem = e.target.closest('.task-item');

      if (backupForceBtn) {
        e.preventDefault();
        const accountId = parseInt(backupForceBtn.dataset.accountId, 10);
        await App.forceBackupSync(Number.isFinite(accountId) ? accountId : null);
        return;
      }

      if (!resumeBtn && !pauseBtn && !cancelBtn && !restartBtn && !retryHlsBtn && !dismissBtn && taskItem) {
        const id = taskItem.dataset.taskId;
        this.expandedTaskId = this.expandedTaskId === id ? null : id;
        this.render();
        return;
      }

      if (resumeBtn) {
        e.preventDefault();
        await this.resumeUpload(resumeBtn.dataset.taskId);
      }
      if (pauseBtn) {
        e.preventDefault();
        await this.pauseUpload(pauseBtn.dataset.taskId);
      }
      if (restartBtn) {
        e.preventDefault();
        await this.restartUpload(restartBtn.dataset.taskId);
      }
      if (retryHlsBtn) {
        e.preventDefault();
        await this.retryHlsConvert(retryHlsBtn.dataset.taskId);
      }
      if (cancelBtn) {
        e.preventDefault();
        const taskId = cancelBtn.dataset.taskId;
        const task = this.tasks.get(taskId);
        if (task?.type === 'upload') {
          if (!confirm('Cancel this upload and discard partial progress?')) return;
          await UploadManager.cancel(taskId);
          App.toast('Upload cancelled', 'success');
        } else {
          if (!confirm('Cancel this background task?')) return;
          const updated = await API.tasks.cancel(taskId);
          this.handleTask(updated);
          App.toast('Task cancelled', 'success');
        }
      }
      if (dismissBtn) {
        e.preventDefault();
        await this.dismissTask(dismissBtn.dataset.taskId);
      }
    });

    const clearBtn = document.getElementById('task-clear-failed');
    if (clearBtn && !clearBtn.dataset.bound) {
      clearBtn.dataset.bound = '1';
      clearBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        await this.clearFailed();
      });
    }
  },

  failedTasks() {
    return [...this.tasks.values()].filter((t) => t.status === 'error');
  },

  async cleanupUploadTask(taskId) {
    const session = await UploadStore.get(taskId);
    if (session?.fileId) {
      await API.files.uploadCancel(session.fileId, taskId).catch(() => {});
    }
    await UploadStore.remove(taskId);
  },

  async dismissTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task || task.status !== 'error') return;

    try {
      await API.tasks.dismiss(taskId);
      if (task.type === 'upload') await this.cleanupUploadTask(taskId);
      this.removeLocal(taskId);
    } catch (err) {
      App.toast(err.message, 'error');
    }
  },

  async clearFailed() {
    const failed = this.failedTasks();
    if (!failed.length) return;
    if (!confirm(`Clear ${failed.length} failed task${failed.length === 1 ? '' : 's'}?`)) return;

    try {
      await API.tasks.clearFailed();
      for (const task of failed) {
        if (task.type === 'upload') await this.cleanupUploadTask(task.id);
        this.removeLocal(task.id);
      }
      App.toast('Cleared failed tasks', 'success');
    } catch (err) {
      App.toast(err.message, 'error');
    }
  },

  removeLocal(taskId) {
    if (this.doneTimers.has(taskId)) {
      clearTimeout(this.doneTimers.get(taskId));
      this.doneTimers.delete(taskId);
    }
    this.tasks.delete(taskId);
    this.render();
    this.stopPollIfIdle();
  },

  async pauseUpload(taskId) {
    const btn = document.querySelector(`.task-btn-pause[data-task-id="${taskId}"]`);
    if (btn) App.setButtonLoading(btn, true);
    try {
      await UploadManager.pause(taskId);
      const task = await API.tasks.get(taskId);
      this.handleTask(task);
      App.toast('Upload paused', 'success');
    } catch (err) {
      App.toast(err?.message || String(err) || 'Pause failed', 'error');
    } finally {
      if (btn) App.setButtonLoading(btn, false);
    }
  },

  mergeSessionFromTask(session, task) {
    if (!task) return session;
    return {
      ...session,
      fileId: task.fileId ?? session.fileId,
      fileName: task.fileName || task.title || session.fileName,
      fileSize: task.fileSize ?? session.fileSize,
      mimeType: task.mimeType || session.mimeType,
      parentPath: task.parentPath || session.parentPath || '/',
      chunkSize: task.chunkSize ?? session.chunkSize,
      uploadMode: task.uploadMode || session.uploadMode || 'api',
      convertHls: task.convertHls ?? session.convertHls ?? false,
      chunksDone: task.chunksDone ?? session.chunksDone ?? 0,
      totalChunks: task.chunksTotal ?? session.totalChunks ?? 0,
      seamlessPartsDone: task.seamlessPartsDone ?? session.seamlessPartsDone ?? 0,
      seamlessPartsTotal: task.seamlessPartsTotal ?? session.seamlessPartsTotal ?? 0,
    };
  },

  async resumeUpload(taskId) {
    const task = this.tasks.get(taskId);
    const btn = document.querySelector(`.task-btn-resume[data-task-id="${taskId}"]`);
    if (btn) App.setButtonLoading(btn, true);

    try {
      if (task?.status === 'error' && task.resumable === false) {
        throw new Error('This upload was cancelled — upload the file again to start fresh');
      }

      let session = await UploadStore.get(taskId);
      if (!session) {
        if (!task?.fileSize || !(task?.fileName || task?.title)) {
          throw new Error('Upload session not found — refresh the page and try again');
        }
        session = {
          taskId,
          fileId: task.fileId || null,
          fileName: task.fileName || task.title,
          fileSize: task.fileSize,
          mimeType: task.mimeType || 'application/octet-stream',
          parentPath: task.parentPath || '/',
          chunkSize: task.chunkSize,
          uploadMode: task.uploadMode || 'api',
          convertHls: !!task.convertHls,
          chunksDone: task.chunksDone || 0,
          totalChunks: task.chunksTotal || 0,
          status: task.status === 'paused' ? 'paused' : 'error',
          error: task.error,
        };
      } else {
        session = this.mergeSessionFromTask(session, task);
      }

      if (task?.status === 'error' || task?.error === 'Cancelled') {
        session.fileId = null;
      }

      let fileOverride = null;
      const mode = session.uploadMode || task?.uploadMode || 'api';

      if (mode === 'seamless' && session.fileId) {
        const status = await API.files.seamlessStatus(session.fileId).catch(() => null);
        if (status?.stagingComplete) {
          await API.tasks.resume(taskId).catch(() => {});
          await API.files.seamlessResume(session.fileId, taskId, !!session.convertHls);
          App.toast(`Resuming server processing for ${task?.title || session.fileName}`, 'success');
          TaskPanel.track(taskId);
          return;
        }
      }

      if (!session.file) {
        const file = await UploadManager.pickFileForResume(session);
        if (!file) return;
        if (file.size !== session.fileSize || file.name !== session.fileName) {
          App.toast('Selected file does not match the interrupted upload', 'error');
          return;
        }
        fileOverride = file;
      }

      await UploadStore.save({ ...session, file: fileOverride || session.file });
      App.toast(`Resuming ${task?.title || session.fileName || 'upload'}`, 'success');
      if (mode === 'seamless') {
        await SeamlessUpload.resume(taskId, fileOverride, (job) => this.handleTask(job));
      } else {
        await UploadManager.resume(taskId, fileOverride, (job) => this.handleTask(job));
      }
    } catch (err) {
      console.error('Resume upload failed:', taskId, err);
      const msg = err?.message || (err != null ? String(err) : 'Resume failed — select the same file and try again');
      App.toast(msg, 'error');
    } finally {
      if (btn) App.setButtonLoading(btn, false);
    }
  },

  async restartUpload(taskId) {
    const session = await UploadStore.get(taskId);
    if (!session?.file) {
      App.toast('Select the original file to restart this upload', 'error');
      await this.resumeUpload(taskId);
      return;
    }

    if (session.fileId) {
      await API.files.uploadCancel(session.fileId, taskId);
      session.fileId = null;
      session.chunksDone = 0;
      session.status = 'pending';
      session.error = null;
      await UploadStore.save(session);
    }

    try {
      await UploadManager.run(session, (job) => this.handleTask(job));
      App.toast(`Restarted ${session.fileName}`, 'success');
    } catch (err) {
      App.toast(err.message, 'error');
    }
  },

  async retryHlsConvert(taskId) {
    const task = this.tasks.get(taskId);
    const btn = document.querySelector(`.task-btn-hls-retry[data-task-id="${taskId}"]`);
    if (!task?.fileId) {
      App.toast('Missing file id for HLS retry', 'error');
      return;
    }
    if (btn) App.setButtonLoading(btn, true);
    try {
      await this.dismissTask(taskId);
      const result = await API.files.hlsConvert(task.fileId);
      if (result?.taskId) {
        this.track(result.taskId);
        this.setExpanded(true);
      }
      App.toast('HLS conversion restarted', 'success');
    } catch (err) {
      App.toast(err.message || 'HLS retry failed', 'error');
    } finally {
      if (btn) App.setButtonLoading(btn, false);
    }
  },

  track(taskId) {
    this.fetchOne(taskId);
    this.ensurePoll();
  },

  async fetchOne(taskId) {
    try {
      const task = await API.tasks.get(taskId);
      this.handleTask(task);
    } catch {
      // task may have finished before first fetch
    }
  },

  handleTask(task) {
    const prev = this.tasks.get(task.id);
    this.tasks.set(task.id, task);
    this.scheduleRender();

    if (task.type === 'backup-sync' && (task.status === 'processing' || task.status === 'pending')) {
      App.ensureBackupPoll();
      if (App.lastBackupSync) App.renderBackupWidget(App.lastBackupSync);
    }

    if (prev?.status === 'processing' && task.status === 'done') {
      this.onTaskDone(task);
    }
    if (prev?.status === 'processing' && task.status === 'error') {
      const errMsg = task.error && task.error !== 'Cancelled' && task.error !== 'Interrupted'
        ? task.error
        : null;
      const hint = task.resumable ? 'Resume from Background tasks' : 'See Background tasks for details';
      App.toast(
        errMsg ? `${task.title} failed: ${errMsg}` : `${task.title} failed — ${hint}`,
        'error'
      );
    }
  },

  onTaskDone(task) {
    if (this.doneTimers.has(task.id)) return;
    this.doneTimers.set(task.id, setTimeout(() => {
      this.doneTimers.delete(task.id);
      if (this.tasks.get(task.id)?.status === 'done') {
        this.tasks.delete(task.id);
        this.render();
        this.stopPollIfIdle();
      }
    }, 6000));

    if (task.type === 'upload') {
      if (!task.convertHls) {
        App.toast(`Uploaded ${task.fileName || task.title}`, 'success');
      }
      explorer.refresh({ filesOnly: true });
      App.loadStats();
    }
    if (task.type === 'delete') {
      const label = task.total > 1 ? `${task.total} items` : (task.names?.[0] || task.title.replace(/^Deleting /, ''));
      App.toast(`Deleted ${label}`, 'success');
      explorer.refresh();
      App.loadStats();
    }
    if (task.type === 'backup-sync') {
      App.toast('Backup sync complete', 'success');
      App.pollBackupStatus();
      App.loadAccountViews();
    }
    if (task.type === 'hls-convert') {
      App.toast('HLS conversion complete', 'success');
      explorer.refresh({ filesOnly: true });
    }
    if (task.type === 'verify-hls') {
      const msg = task.valid === false
        ? (task.error || 'HLS verification found issues')
        : 'HLS verification complete';
      App.toast(msg, task.valid === false ? 'error' : 'success');
      explorer.refresh({ filesOnly: true });
    }
    if (task.type === 'thumbnail-upload') {
      App.toast(task.total > 1
        ? `Updated ${task.total} custom thumbnail(s)`
        : 'Custom thumbnail updated', 'success');
      explorer.refresh({ filesOnly: true });
    }
  },

  ensurePoll() {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => this.poll(), 800);
  },

  stopPollIfIdle() {
    const active = [...this.tasks.values()].some(
      (t) => t.status === 'processing' || t.status === 'pending' || t.status === 'paused'
        || (t.status === 'error' && t.resumable)
    ) || App.lastBackupSync?.some((s) => !s.up_to_date || s.syncing);
    if (!active && this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  },

  async poll() {
    try {
      const { tasks } = await API.tasks.list({ resumable: true });
      const seen = new Set(tasks.map((t) => t.id));
      for (const task of tasks) this.handleTask(task);
      for (const [id, task] of this.tasks) {
        if (!seen.has(id) && (task.status === 'processing' || task.status === 'pending' || task.status === 'paused')) {
          await this.fetchOne(id);
        }
      }
      this.stopPollIfIdle();
    } catch {
      // keep polling through transient errors
    }
  },

  label(task) {
    if (task.type === 'upload') {
      if (task.status === 'paused') {
        const pos = task.chunksTotal
          ? ` — chunk ${task.chunksDone || 0}/${task.chunksTotal}`
          : '';
        const reason = task.pauseReason && !/no progress|no chunk activity/i.test(task.pauseReason)
          ? task.pauseReason
          : 'Paused';
        return `${reason}${pos}`;
      }
      if (task.status === 'error' && task.resumable) {
        const pos = task.chunksTotal
          ? ` at chunk ${task.chunksDone || 0}/${task.chunksTotal}`
          : '';
        return `${task.error || 'Interrupted'}${pos}`;
      }
      if (task.phase === 'encrypt') return 'Encrypting...';
      if (task.uploadMode === 'seamless') {
        if (task.phase === 'receiving' && task.seamlessPartsTotal) {
          return `Caching on server ${task.seamlessPartsDone || 0}/${task.seamlessPartsTotal}`;
        }
        if (task.phase === 'processing') return 'Server processing from cache...';
        if (task.phase === 'upload' && task.chunksTotal) {
          return `Server uploading ${task.chunksDone || 0}/${task.chunksTotal}`;
        }
        if (task.phase === 'hls-convert') return 'Converting to HLS on server...';
        if (task.pauseReason) return task.pauseReason;
      }
      if (task.phase === 'upload' && task.chunksTotal) {
        if (task.uploadMode === 'git') {
          let status = `Staging locally ${task.chunksDone}/${task.chunksTotal} (git push at end)`;
          if (task.currentRepo) status += ` → ${task.currentRepo}`;
          return status;
        }
        let status = `Uploading chunk ${task.chunksDone}/${task.chunksTotal}`;
        if (task.currentRepo) status += ` → ${task.currentRepo.split('/').pop()}`;
        return status;
      }
      if (task.phase === 'rate-limit') return task.currentRepo || 'Waiting for GitHub rate limit...';
      if (task.phase === 'metadata') return 'Saving metadata...';
      if (task.phase === 'thumbnail') return 'Processing thumbnail...';
      if (task.phase === 'git-push') return 'Pushing chunks via git...';
      if (task.phase === 'hls-convert') return 'Converting to HLS...';
      if (task.phase === 'assembling') return 'Assembling file for HLS...';
      if (task.phase === 'converting') return 'Running FFmpeg HLS conversion...';
      if (task.phase === 'uploading' && task.segmentsTotal) {
        return `Uploading HLS segment ${task.segmentsDone || 0}/${task.segmentsTotal}`;
      }
      if (task.phase === 'playlist') return 'Creating m3u8 playlist...';
      return 'Uploading...';
    }
    if (task.type === 'hls-convert') {
      if (task.status === 'error') return task.error || 'HLS conversion failed';
      if (task.lastLog) return task.lastLog;
      if (task.phase === 'assembling') return 'Assembling file from chunks...';
      if (task.phase === 'converting') return 'Running FFmpeg HLS conversion...';
      if (task.phase === 'uploading' && task.segmentsTotal) {
        return `Uploading HLS segment ${task.segmentsDone || 0}/${task.segmentsTotal}`;
      }
      if (task.phase === 'playlist') return 'Creating m3u8 playlist...';
      if (task.phase === 'checking') return 'Recovering interrupted conversion...';
      return 'Converting to HLS...';
    }
    if (task.type === 'verify-repair') {
      if (task.status === 'error') return task.error || 'Verify/repair failed';
      if (task.lastLog) return task.lastLog;
      if (task.phase === 'verify') return `Checking chunks on GitHub (${task.chunksDone || 0}/${task.chunksTotal || 0})`;
      if (task.phase === 'repair') return task.lastLog || 'Repairing missing chunks...';
      if (task.phase === 'rate-limit') return task.currentRepo || 'Waiting for GitHub rate limit...';
      return 'Verifying file...';
    }
    if (task.type === 'verify-hls') {
      if (task.status === 'error') return task.error || 'HLS verification failed';
      if (task.lastLog) return task.lastLog;
      if (task.total > 1) {
        return `Verifying HLS (${(task.done || 0) + 1}/${task.total})`;
      }
      if (task.phase === 'playlist') return 'Checking m3u8 playlist on GitHub';
      if (task.segmentsTotal) {
        return `Checking HLS segments (${task.segmentsDone || 0}/${task.segmentsTotal})`;
      }
      return 'Verifying HLS...';
    }
    if (task.type === 'thumbnail-upload') {
      if (task.status === 'error') return task.error || 'Thumbnail upload failed';
      if (task.lastLog) return task.lastLog;
      if (task.total > 1) {
        return `Setting thumbnails (${(task.done || 0) + 1}/${task.total})`;
      }
      return task.currentName ? `Setting thumbnail for ${task.currentName}` : 'Setting thumbnail...';
    }
    if (task.type === 'delete') {
      if (task.total > 1) return `Removing from GitHub (${task.done || 0}/${task.total})`;
      return 'Removing chunks from GitHub repos...';
    }
    if (task.type === 'backup-sync') {
      if (task.status === 'paused') {
        return task.pauseReason || 'Paused — will resume automatically';
      }
      if (task.phase === 'rate-limit') return task.currentRepo || 'Waiting for GitHub rate limit...';
      if (task.phase === 'fork-sync') return task.currentRepo || 'Syncing forks from upstream...';
      if (task.phase === 'reconcile') return task.currentRepo || 'Reconciling backup records...';
      if (task.phase === 'chunk-fallback') {
        const chunks = task.chunksTotal
          ? `${task.chunksDone || 0}/${task.chunksTotal} chunks`
          : 'Uploading missing chunks';
        return `${chunks}${task.currentRepo ? ` → ${task.currentRepo}` : ''}`;
      }
      if (task.status === 'error' && task.resumable) return task.error || 'Backup sync interrupted';
      return 'Syncing backup...';
    }
    return task.phase || 'Working...';
  },

  formatBytes(n) {
    if (!n) return '0 B';
    if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`;
    if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${n} B`;
  },

  formatTime(ts) {
    if (!ts) return '—';
    try {
      return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return ts;
    }
  },

  debugRows(task) {
    const rows = [
      ['Status', task.status],
      ['Phase', task.phase || '—'],
      ['Updated', this.formatTime(task.updated_at)],
    ];
    if (task.type === 'upload') {
      rows.push(['Mode', task.uploadMode === 'seamless'
        ? 'Seamless (server cache)'
        : task.uploadMode === 'git' ? 'Git (local staging)' : 'GitHub API']);
      if (task.uploadMode === 'seamless' && task.seamlessPartsTotal) {
        rows.push(['Server cache', `${task.seamlessPartsDone || 0} / ${task.seamlessPartsTotal} parts`]);
      }
      if (task.chunksTotal) rows.push(['Chunks', `${task.chunksDone || 0} / ${task.chunksTotal}`]);
      if (task.currentRepo) rows.push(['Repo', task.currentRepo]);
      if (task.uploadMode === 'git' && task.gitBytesStaged) {
        rows.push(['Staged on disk', this.formatBytes(task.gitBytesStaged)]);
      }
      if (task.uploadMode === 'git' && task.gitRepos?.length) {
        rows.push(['Repos used', task.gitRepos.join(', ')]);
      }
      if (task.fileSize) rows.push(['File size', this.formatBytes(task.fileSize)]);
      if (task.fileId) rows.push(['File ID', task.fileId]);
    }
    if (task.type === 'backup-sync') {
      if (task.accountId) rows.push(['Account', task.accountId]);
      if (task.method) rows.push(['Method', task.method]);
      if (task.chunksTotal) rows.push(['Chunks', `${task.chunksDone || 0} / ${task.chunksTotal}`]);
      if (task.currentRepo) rows.push(['Current', task.currentRepo]);
    }
    if (task.type === 'verify-hls') {
      if (task.segmentsTotal) rows.push(['Segments', `${task.segmentsDone || 0} / ${task.segmentsTotal}`]);
      if (task.missing?.length) rows.push(['Missing', task.missing.join(', ')]);
      if (task.issues?.length) rows.push(['Issues', task.issues.join('; ')]);
    }
    if (task.type === 'thumbnail-upload') {
      if (task.total) rows.push(['Files', `${task.done || 0} / ${task.total}`]);
      if (task.currentName) rows.push(['Current', task.currentName]);
    }
    if (task.error) rows.push(['Error', task.error]);
    return rows;
  },

  renderDebug(task) {
    const rows = this.debugRows(task);
    const log = Array.isArray(task.log) ? task.log : [];
    const logHtml = log.length
      ? log.slice(-40).map((entry) => {
          const time = this.formatTime(entry.ts);
          const msg = this.escape(entry.msg || '');
          return `<div class="task-log-line"><span class="task-log-time">${time}</span> ${msg}</div>`;
        }).join('')
      : '<div class="task-log-empty">No log entries yet — activity will appear here as the task runs.</div>';

    return `
      <div class="task-debug">
        <div class="task-debug-grid">
          ${rows.map(([k, v]) => `
            <span class="task-debug-key">${this.escape(k)}</span>
            <span class="task-debug-val" title="${this.escape(String(v))}">${this.escape(String(v))}</span>
          `).join('')}
        </div>
        <div class="task-debug-log" tabindex="0">${logHtml}</div>
      </div>
    `;
  },

  dedupeBackupSyncTasks(items) {
    const byAccount = new Map();
    const others = [];

    for (const task of items) {
      if (task.type !== 'backup-sync' || !task.accountId) {
        others.push(task);
        continue;
      }
      const key = String(task.accountId);
      const prev = byAccount.get(key);
      if (!prev) {
        byAccount.set(key, task);
        continue;
      }
      const prevTs = Date.parse(prev.updated_at || 0) || 0;
      const taskTs = Date.parse(task.updated_at || 0) || 0;
      if (taskTs >= prevTs) byAccount.set(key, task);
    }

    return [...others, ...byAccount.values()];
  },

  render() {
    const panel = document.getElementById('task-panel');
    const list = document.getElementById('task-list');
    const clearBtn = document.getElementById('task-clear-failed');
    if (!panel || !list) return;

    const items = this.dedupeBackupSyncTasks([...this.tasks.values()]);
    const failedCount = this.failedTasks().length;
    this.updateChrome(items);
    if (clearBtn) {
      clearBtn.classList.toggle('hidden', failedCount === 0);
      clearBtn.textContent = failedCount > 1 ? `Clear failed (${failedCount})` : 'Clear failed';
    }

    list.innerHTML = items.map((task) => {
      const failed = task.status === 'error';
      const paused = task.status === 'paused';
      const done = task.status === 'done';
      const processing = task.status === 'processing' || task.status === 'pending';
      const clientActive = task.type === 'upload'
        && typeof UploadManager !== 'undefined'
        && UploadManager.active.has(task.id);
      const stalledUpload = processing && task.type === 'upload' && !clientActive;
      const cancelled = failed && (task.error === 'Cancelled' || task.phase === 'cancelled' || task.error === 'Interrupted');
      const resumable = ((failed || paused) && task.resumable !== false && task.type === 'upload' && !cancelled)
        || stalledUpload;
      const backupPaused = task.type === 'backup-sync' && (task.status === 'paused' || task.status === 'error');
      const detail = failed
        ? (task.error || 'Failed')
        : done
          ? 'Complete'
          : this.label(task);
      const percent = failed && task.resumable
        ? (task.percent || 0)
        : failed
          ? 100
          : (task.percent || 0);

      const actions = resumable ? `
        <div class="task-actions">
          <button class="task-btn task-btn-resume" data-task-id="${task.id}">Resume</button>
          ${failed ? `<button class="task-btn task-btn-restart" data-task-id="${task.id}">Restart</button>` : ''}
          <button class="task-btn task-btn-cancel" data-task-id="${task.id}">Cancel</button>
        </div>
      ` : processing && task.type === 'upload' ? `
        <div class="task-actions">
          <button class="task-btn task-btn-pause" data-task-id="${task.id}">Pause</button>
          <button class="task-btn task-btn-cancel" data-task-id="${task.id}">Cancel</button>
        </div>
      ` : processing && (task.type === 'hls-convert' || task.type === 'delete' || task.type === 'verify-repair' || task.type === 'verify-hls') ? `
        <div class="task-actions">
          <button class="task-btn task-btn-cancel" data-task-id="${task.id}">Cancel</button>
        </div>
      ` : failed && task.type === 'hls-convert' && task.fileId ? `
        <div class="task-actions">
          <button class="task-btn task-btn-hls-retry" data-task-id="${task.id}">Retry</button>
          <button class="task-btn task-btn-dismiss" data-task-id="${task.id}">Dismiss</button>
        </div>
      ` : failed ? `
        <div class="task-actions">
          <button class="task-btn task-btn-dismiss" data-task-id="${task.id}">Dismiss</button>
        </div>
      ` : cancelled ? `
        <div class="task-actions">
          <button class="task-btn task-btn-dismiss" data-task-id="${task.id}">Dismiss</button>
        </div>
      ` : '';

      const expanded = this.expandedTaskId === task.id;

      return `
        <div class="task-item task-${task.status}${expanded ? ' task-expanded' : ''}" data-task-id="${task.id}">
          <div class="task-item-header">
            <span class="task-icon">${task.type === 'upload' ? '⬆️' : task.type === 'backup-sync' ? '⎘' : task.type === 'hls-convert' ? '🎬' : task.type === 'thumbnail-upload' ? '🖼️' : (task.type === 'verify-repair' || task.type === 'verify-hls') ? '🔍' : '🗑️'}</span>
            <span class="task-title" title="${this.escape(task.title)}">${this.escape(task.title)}</span>
            <span class="task-percent">${cancelled ? 'Cancelled' : failed && !resumable ? 'Failed' : done ? 'Done' : `${percent}%`}</span>
            <button type="button" class="task-expand-btn" title="${expanded ? 'Hide details' : 'Show debug log'}" aria-expanded="${expanded}">${expanded ? '▾' : '▸'}</button>
            ${failed ? `<button type="button" class="task-dismiss-icon task-btn-dismiss" data-task-id="${task.id}" title="Dismiss" aria-label="Dismiss">×</button>` : ''}
          </div>
          <div class="task-detail">${this.escape(detail)}${task.lastLog && !expanded ? ` · <span class="task-last-log">${this.escape(task.lastLog)}</span>` : ''}</div>
          <div class="task-bar ${failed && !resumable ? 'task-bar-error' : failed && resumable ? 'task-bar-paused' : ''}">
            <div class="task-bar-fill" data-bar="${percent}"></div>
          </div>
          ${expanded ? this.renderDebug(task) : ''}
          ${actions}
        </div>
      `;
    }).join('');

    applyDynamicStyles(list);

    if (this.expandedTaskId) {
      const logEl = list.querySelector(`.task-item[data-task-id="${this.expandedTaskId}"] .task-debug-log`);
      if (logEl) logEl.scrollTop = logEl.scrollHeight;
    }
  },

  escape(str) {
    const el = document.createElement('span');
    el.textContent = str || '';
    return el.innerHTML;
  },
};
