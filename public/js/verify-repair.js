const VerifyRepair = {
  pendingFileId: null,

  prompt(file) {
    if (!file || file.is_folder) return;
    this.pendingFileId = file.id;
    document.getElementById('verify-file-input')?.click();
  },

  async onFileSelected(input) {
    const fileId = this.pendingFileId;
    const localFile = input.files?.[0];
    input.value = '';
    this.pendingFileId = null;
    if (!fileId || !localFile) return;

    const vaultFile = explorer.files.find((f) => f.id === fileId)
      || explorer.contextTarget
      || null;
    if (!vaultFile) {
      App.toast('Vault file not found — refresh and try again', 'error');
      return;
    }

    try {
      await this.run(fileId, localFile, {
        expectedSize: vaultFile.size,
        displayName: vaultFile.name,
      });
    } catch (err) {
      App.toast(err.message || 'Verify/repair failed', 'error');
    }
  },

  async run(fileId, localFile, options = {}) {
    const {
      expectedSize = localFile.size,
      displayName = localFile.name,
      quietOnSuccess = false,
      trackTask = true,
      source = null,
    } = options;

    if (!fileId || !localFile) throw new Error('File required for verification');

    if (localFile.size !== expectedSize) {
      throw new Error(
        `File size mismatch: local ${formatSize(localFile.size)} vs vault ${formatSize(expectedSize)}`
      );
    }

    if (!quietOnSuccess) {
      App.toast(`Verifying ${displayName} against GitHub...`, 'info');
    }

    const init = await API.files.verifyRepairInit(fileId, {
      size: localFile.size,
      fileName: localFile.name,
      source,
    });

    if (init.alreadyRunning) {
      if (trackTask) TaskPanel.track(init.taskId);
      if (!quietOnSuccess) App.toast('Verification already in progress', 'info');
      return { valid: null, repaired: 0, taskId: init.taskId, alreadyRunning: true };
    }

    if (trackTask) {
      TaskPanel.track(init.taskId);
      if (!quietOnSuccess) TaskPanel.setExpanded(true);
    }

    if (init.valid) {
      if (!quietOnSuccess) {
        App.toast(`All ${init.totalChunks} chunks verified on GitHub`, 'success');
      }
      return { valid: true, repaired: 0, taskId: init.taskId, totalChunks: init.totalChunks };
    }

    const missing = init.missing || [];
    if (!missing.length) {
      return { valid: true, repaired: 0, taskId: init.taskId, totalChunks: init.totalChunks };
    }

    App.toast(`Repairing ${missing.length} missing chunk(s) for ${displayName}...`, 'info');

    for (let i = 0; i < missing.length; i++) {
      const chunkIndex = missing[i];
      const start = chunkIndex * init.chunkSize;
      const end = Math.min(start + init.chunkSize, localFile.size);
      const slice = localFile.slice(start, end);
      await API.files.verifyRepairChunk(fileId, chunkIndex, slice, init.taskId);
    }

    await API.files.verifyRepairComplete(fileId, init.taskId);
    App.toast(`Repaired ${missing.length} chunk(s) — ${displayName} is intact`, 'success');
    return {
      valid: true,
      repaired: missing.length,
      taskId: init.taskId,
      totalChunks: init.totalChunks,
    };
  },
};
