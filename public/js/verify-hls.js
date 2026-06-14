const VerifyHls = {
  eligibleFiles(files) {
    return (files || []).filter((f) => !f.is_folder && (f.has_hls || (f.hls_segment_count > 0)));
  },

  async runForFiles(files) {
    const targets = this.eligibleFiles(files);
    if (!targets.length) {
      App.toast('No HLS files in selection', 'error');
      return null;
    }

    try {
      let result;
      if (targets.length === 1) {
        result = await API.files.verifyHls(targets[0].id);
      } else {
        result = await API.files.verifyHlsBatch(targets.map((f) => f.id));
      }

      if (result?.taskId) {
        TaskPanel.track(result.taskId);
        TaskPanel.setExpanded(true);
      } else {
        TaskPanel.ensurePoll();
      }

      const skipped = result?.skipped?.length;
      const msg = result?.alreadyRunning
        ? 'HLS verification already running'
        : skipped
          ? `Verifying HLS for ${result.count || targets.length} file(s) (${skipped.length} skipped)`
          : `Verifying HLS for ${result.count || targets.length} file(s)`;
      App.toast(msg, 'success');
      return result;
    } catch (err) {
      App.toast(err.message || 'HLS verification failed', 'error');
      throw err;
    }
  },

  async runForSelection() {
    const files = explorer.getSelectedFileObjects?.() || [];
    return this.runForFiles(files);
  },
};
