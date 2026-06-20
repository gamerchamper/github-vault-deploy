const SeamlessUpload = {
  PART_CONCURRENCY: 8,

  async start(file, parentPath, chunkSize, convertHls, onProgress, uploadAccountIds = null) {
    const session = await UploadStore.createFromFile(file, parentPath, chunkSize, 'seamless', convertHls, uploadAccountIds);
    return this.run(this.attachFile(session, file), onProgress);
  },

  attachFile(session, file) {
    if (!file) return session;
    UploadManager.files.set(session.taskId, file);
    return { ...session, file };
  },

  getFile(session) {
    return session.file || UploadManager.files.get(session.taskId) || null;
  },

  async resume(taskId, fileOverride, onProgress) {
    let session = await UploadStore.get(taskId);
    if (!session) {
      throw new Error('Upload session not found locally. Select the same file to resume.');
    }

    if (session.fileId) {
      const status = await API.files.seamlessStatus(session.fileId).catch(() => null);
      if (status?.stagingComplete) {
        UploadManager.active.delete(taskId);
        await API.tasks.resume(taskId).catch(() => {});
        await API.files.seamlessResume(session.fileId, taskId, !!session.convertHls);
        TaskPanel.track(taskId);
        if (onProgress) {
          onProgress({
            id: taskId,
            type: 'upload',
            uploadMode: 'seamless',
            phase: 'processing',
            percent: 35,
            title: session.fileName,
            status: 'processing',
          });
        }
        return { fileId: session.fileId, taskId, seamless: true, serverProcessing: true };
      }
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
    UploadManager.active.delete(taskId);
    await API.tasks.resume(taskId).catch(() => {});
    return this.run(session, onProgress);
  },

  async run(session, onProgress) {
    if (UploadManager.active.has(session.taskId)) {
      return UploadManager.active.get(session.taskId);
    }
    const promise = this._run(session, onProgress).finally(() => {
      UploadManager.active.delete(session.taskId);
    });
    UploadManager.active.set(session.taskId, promise);
    return promise;
  },

  async _run(session, onProgress) {
    session = this.attachFile(session, this.getFile(session));
    if (!session.file) {
      throw new Error('File data not available. Select the same file to resume.');
    }

    const convertHls = !!session.convertHls;
    let init;
    try {
      init = await API.files.seamlessInit({
        fileName: session.fileName,
        parentPath: session.parentPath,
        size: session.fileSize,
        mimeType: session.mimeType,
        chunkSize: session.chunkSize,
        fileId: session.fileId,
        taskId: session.taskId,
        convertHls,
        uploadAccountIds: session.uploadAccountIds || null,
      });

      session.fileId = init.fileId;
      session.taskId = init.jobId;
      session.totalParts = init.totalParts;
      session.partSize = init.partSize;
      session.totalChunks = init.totalChunks;
      session.status = 'uploading';
      session.error = null;
      await UploadStore.save(session);
      TaskPanel.track(init.jobId);
    } catch (err) {
      session.status = 'error';
      session.error = err.message;
      await UploadStore.save(session).catch(() => {});
      throw err;
    }

    const { totalParts, partSize } = init;
    const startPart = init.nextPart ?? 0;
    const partIndices = [];
    for (let i = startPart; i < totalParts; i++) partIndices.push(i);

    const pool = AdaptiveConcurrency.createPool(partIndices.length, {
      max: this.PART_CONCURRENCY,
      initial: Math.min(this.PART_CONCURRENCY, partIndices.length),
    });

    try {
      await AdaptiveConcurrency.map(partIndices, pool, async (partIndex) => {
        const start = partIndex * partSize;
        const end = Math.min(start + partSize, session.file.size);
        const slice = session.file.slice(start, end);
        const result = await API.files.seamlessPart(
          init.fileId,
          partIndex,
          slice,
          init.jobId
        );
        pool.recordBytes(slice.size);
        if (onProgress) {
          onProgress({
            id: init.jobId,
            type: 'upload',
            uploadMode: 'seamless',
            phase: result.partsDone >= totalParts ? 'processing' : 'receiving',
            percent: result.percent,
            seamlessPartsDone: result.partsDone,
            seamlessPartsTotal: totalParts,
            chunksTotal: init.totalChunks,
            title: session.fileName,
          });
        }
      });

      await API.files.seamlessComplete(init.fileId, init.jobId, convertHls);

      session.status = 'processing';
      session.fileId = init.fileId;
      await UploadStore.save(session);

      if (onProgress) {
        onProgress({
          id: init.jobId,
          type: 'upload',
          uploadMode: 'seamless',
          phase: 'processing',
          percent: 35,
          title: session.fileName,
          status: 'processing',
        });
      }

      return { fileId: init.fileId, taskId: init.jobId, seamless: true };
    } catch (err) {
      session.status = 'error';
      session.error = err.message;
      await UploadStore.save(session).catch(() => {});
      throw err;
    }
  },
};
