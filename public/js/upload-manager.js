const UploadManager = {
  active: new Map(),
  files: new Map(),
  pauseRequested: new Set(),
  controllers: new Map(),

  abortControllers(taskId) {
    const set = this.controllers.get(taskId);
    if (!set) return;
    for (const controller of set) controller.abort();
    this.controllers.delete(taskId);
  },

  trackController(taskId, controller) {
    if (!this.controllers.has(taskId)) this.controllers.set(taskId, new Set());
    this.controllers.get(taskId).add(controller);
    return controller;
  },

  untrackController(taskId, controller) {
    const set = this.controllers.get(taskId);
    if (!set) return;
    set.delete(controller);
    if (!set.size) this.controllers.delete(taskId);
  },

  attachFile(session, file) {
    if (!file) return session;
    this.files.set(session.taskId, file);
    return { ...session, file };
  },

  getFile(session) {
    return session.file || this.files.get(session.taskId) || null;
  },

  clearFile(taskId) {
    this.files.delete(taskId);
  },

  async start(file, parentPath, chunkSize, convertHls, onProgress, uploadMode = 'api') {
    const session = this.attachFile(
      await UploadStore.createFromFile(file, parentPath, chunkSize, uploadMode, convertHls),
      file
    );
    return this.run(session, onProgress);
  },

  async resume(taskId, fileOverride, onProgress) {
    let session = await UploadStore.get(taskId);
    if (!session) {
      throw new Error('Upload session not found locally. Select the same file to resume.');
    }

    if (fileOverride) {
      if (fileOverride.size !== session.fileSize || fileOverride.name !== session.fileName) {
        throw new Error('Selected file does not match the interrupted upload');
      }
      session = this.attachFile(session, fileOverride);
      await UploadStore.save(session);
    }

    session = this.attachFile(session, this.getFile(session));
    if (!session.file) {
      throw new Error('File data not available. Select the same file to resume.');
    }

    this.pauseRequested.delete(taskId);
    this.abortControllers(taskId);
    this.active.delete(taskId);
    await API.tasks.resume(taskId).catch(() => {});
    return this.run(session, onProgress);
  },

  async pause(taskId) {
    this.pauseRequested.add(taskId);
    this.abortControllers(taskId);
    try {
      await API.tasks.pause(taskId);
    } catch {
      // task may already be paused server-side
    }
  },

  async run(session, onProgress) {
    if (this.active.has(session.taskId)) {
      return this.active.get(session.taskId);
    }

    const promise = this._run(session, onProgress).finally(() => {
      this.active.delete(session.taskId);
      this.abortControllers(session.taskId);
      this.pauseRequested.delete(session.taskId);
    });
    this.active.set(session.taskId, promise);
    return promise;
  },

  async _run(session, onProgress) {
    session = this.attachFile(session, this.getFile(session));
    if (!session.file) {
      throw new Error('File data not available. Select the same file to resume.');
    }

    const uploadMode = session.uploadMode || 'api';
    const convertHls = session.convertHls || false;
    let init;
    let taskId;

    try {
      init = await API.files.uploadInit({
        fileName: session.fileName,
        parentPath: session.parentPath,
        size: session.fileSize,
        mimeType: session.mimeType,
        chunkSize: session.chunkSize,
        fileId: session.fileId,
        taskId: session.taskId,
        uploadMode,
        convertHls,
      });

      session.fileId = init.fileId;
      session.taskId = init.jobId;
      session.totalChunks = init.totalChunks;
      session.chunkSize = init.chunkSize || session.chunkSize;
      session.uploadMode = init.uploadMode || uploadMode;
      session.chunksDone = init.chunksDone || 0;
      session.status = 'uploading';
      session.error = null;
      await UploadStore.save(session);
      TaskPanel.track(init.jobId);

      taskId = init.jobId;
    } catch (err) {
      const message = err?.message || (err != null ? String(err) : 'Failed to start upload');
      session.status = 'error';
      session.error = message;
      await UploadStore.save(session).catch(() => {});
      throw err instanceof Error ? err : new Error(message);
    }

    const { chunkSize, totalChunks } = init;
    const startChunk = init.nextChunk ?? 0;

    try {
      const chunkIndices = [];
      for (let i = startChunk; i < totalChunks; i++) chunkIndices.push(i);

      let lastProgressAt = 0;
      const reportProgress = async () => {
        const now = Date.now();
        if (now - lastProgressAt < 400) return;
        lastProgressAt = now;
        const job = await API.tasks.get(taskId).catch(() => null);
        if (!job) return;
        if (onProgress) onProgress(job);
        TaskPanel.handleTask(job);
      };

      const checkPaused = async () => {
        if (this.pauseRequested.has(taskId)) {
          const err = new DOMException('Upload paused', 'AbortError');
          this.abortControllers(taskId);
          throw err;
        }
        const remote = await API.tasks.get(taskId).catch(() => null);
        if (remote?.status === 'paused') {
          this.pauseRequested.add(taskId);
          this.abortControllers(taskId);
          throw new DOMException('Upload paused', 'AbortError');
        }
      };

      const pool = AdaptiveConcurrency.createPool(chunkIndices.length, { max: 50, initial: 12 });
      await AdaptiveConcurrency.map(chunkIndices, pool, async (chunkIndex) => {
        await checkPaused();

        const controller = this.trackController(taskId, new AbortController());
        try {
          const start = chunkIndex * chunkSize;
          const end = Math.min(start + chunkSize, session.file.size);
          const slice = session.file.slice(start, end);

          const result = await API.files.uploadChunk(
            init.fileId, chunkIndex, slice, taskId, uploadMode, controller.signal
          );
          pool.recordBytes(slice.size);
          session.chunksDone = Math.max(session.chunksDone || 0, result.chunksDone);
          session.status = 'uploading';
          await UploadStore.save(session).catch(() => {});
          await reportProgress();
        } finally {
          this.untrackController(taskId, controller);
        }
      });

      const isVideo = (session.mimeType || '').startsWith('video/')
        || /\.(mp4|webm|mkv|avi|mov|m4v|ogv)$/i.test(session.fileName || '');
      const previewCap = isVideo ? 20 * 1024 * 1024 : 5 * 1024 * 1024;
      const previewSize = Math.min(session.file.size, previewCap);
      const preview = session.file.size > 0 ? session.file.slice(0, previewSize) : null;
      const result = await API.files.uploadComplete(init.fileId, taskId, preview, uploadMode, convertHls);

      const verifyFile = session.file;
      session.status = 'done';
      await UploadStore.remove(taskId);

      VerifyRepair.run(init.fileId, verifyFile, {
        expectedSize: session.fileSize,
        displayName: session.fileName,
        quietOnSuccess: true,
        source: 'upload',
      }).catch((verifyErr) => {
        console.warn('Post-upload verify failed:', verifyErr);
        App.toast(
          `Upload finished but verification failed: ${verifyErr.message || verifyErr}`,
          'error'
        );
      }).finally(() => {
        this.clearFile(taskId);
      });

      const doneJob = await API.tasks.get(taskId);
      if (onProgress) onProgress(doneJob);
      TaskPanel.handleTask(doneJob);

      if (result?.hlsTaskId) {
        TaskPanel.track(result.hlsTaskId);
        if (convertHls) {
          App.toast(`Upload complete — converting ${session.fileName} to HLS`, 'success');
        }
      }

      return result;
    } catch (err) {
      if (err?.name !== 'AbortError' && !this.pauseRequested.has(taskId)) {
        this.abortControllers(taskId);
      }
      const message = err?.message || (err != null ? String(err) : 'Upload interrupted');
      if (err?.name === 'AbortError' || this.pauseRequested.has(taskId)) {
        session.status = 'paused';
        await UploadStore.save(session);
        const pausedJob = await API.tasks.get(taskId).catch(() => null);
        if (pausedJob) TaskPanel.handleTask(pausedJob);
        return null;
      }

      session.status = 'error';
      session.error = message;
      session.chunksDone = Math.max(init?.chunksDone ?? 0, session.chunksDone ?? 0);
      await UploadStore.save(session);

      try {
        const failedJob = await API.tasks.get(taskId);
        TaskPanel.handleTask({ ...failedJob, status: 'error', error: message, resumable: true });
      } catch {
        TaskPanel.handleTask({
          id: taskId,
          type: 'upload',
          title: session.fileName,
          status: 'error',
          error: message,
          resumable: true,
          chunksDone: session.chunksDone,
          chunksTotal: session.totalChunks,
          percent: session.totalChunks
            ? Math.round((session.chunksDone / session.totalChunks) * 100)
            : 0,
        });
      }

      throw err instanceof Error ? err : new Error(message);
    }
  },

  async cancel(taskId) {
    this.pauseRequested.add(taskId);
    this.abortControllers(taskId);
    this.active.delete(taskId);
    const session = await UploadStore.get(taskId);
    try {
      if (session?.fileId) {
        await API.files.uploadCancel(session.fileId, taskId);
      } else {
        await API.tasks.cancel(taskId);
      }
    } catch (err) {
      console.warn('Upload cancel:', err?.message || err);
      await API.tasks.cancel(taskId).catch(() => {});
    }
    await UploadStore.remove(taskId);
    this.clearFile(taskId);
    TaskPanel.removeLocal(taskId);
  },

  async restoreInterrupted() {
    const sessions = await UploadStore.listInterrupted();
    for (const session of sessions) {
      if (session.status === 'done') {
        await UploadStore.remove(session.taskId);
        continue;
      }
      if (TaskPanel.tasks.has(session.taskId)) continue;

      const remote = await API.tasks.get(session.taskId).catch(() => null);
      if (!remote || remote.status === 'done' || (remote.status === 'error' && remote.resumable === false)) {
        await UploadStore.remove(session.taskId);
        continue;
      }

      TaskPanel.tasks.set(session.taskId, {
        id: session.taskId,
        type: 'upload',
        title: remote.fileName || remote.title || session.fileName,
        status: remote.status === 'paused' ? 'paused' : remote.status === 'error' ? 'error' : remote.status,
        phase: remote.phase || 'upload',
        error: remote.error || session.error,
        resumable: remote.resumable !== false,
        chunksDone: remote.chunksDone ?? session.chunksDone ?? 0,
        chunksTotal: remote.chunksTotal ?? session.totalChunks ?? 0,
        percent: remote.percent ?? (session.totalChunks
          ? Math.round(((session.chunksDone || 0) / session.totalChunks) * 100)
          : 0),
        fileId: remote.fileId ?? session.fileId,
        parentPath: remote.parentPath || session.parentPath,
        chunkSize: remote.chunkSize ?? session.chunkSize,
        fileSize: remote.fileSize ?? session.fileSize,
        mimeType: remote.mimeType || session.mimeType,
        uploadMode: remote.uploadMode || session.uploadMode,
      });
    }
    TaskPanel.render();
    TaskPanel.ensurePoll();
  },

  pickFileForResume(session) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.hidden = true;
      input.addEventListener('change', () => {
        const file = input.files?.[0] || null;
        input.remove();
        resolve(file);
      });
      document.body.appendChild(input);
      input.click();
    });
  },
};
