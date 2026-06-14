const ThumbUpload = {
  stem(name) {
    const base = String(name || '').replace(/\.[^.]+$/, '');
    return base.trim().toLowerCase();
  },

  matchImagesToTargets(targets, images) {
    if (!targets.length || !images.length) {
      return { pairs: [], unmatched: targets.slice() };
    }

    if (images.length === 1) {
      return {
        pairs: targets.map((target) => ({ target, image: images[0] })),
        unmatched: [],
      };
    }

    const byStem = new Map();
    for (const image of images) {
      const key = this.stem(image.name);
      if (!byStem.has(key)) byStem.set(key, image);
    }

    const pairs = [];
    const unmatched = [];
    for (const target of targets) {
      const image = byStem.get(this.stem(target.name));
      if (image) pairs.push({ target, image });
      else unmatched.push(target);
    }
    return { pairs, unmatched };
  },

  async applyThumbnailToFile(file) {
    file.has_thumbnail = 1;
    file.thumbVersion = Date.now();
    const el = document.querySelector(`#file-grid .file-item[data-id="${file.id}"] img.file-thumb`);
    const url = await ThumbCache.prefetch(file.id, file.thumbVersion);
    if (el) el.src = url;
  },

  async uploadOne(file, imageFile) {
    const result = await API.files.uploadThumbnail(file.id, imageFile);
    await this.applyThumbnailToFile(file);
    return result;
  },

  async uploadPairs(pairs) {
    if (!pairs.length) {
      App.toast('No thumbnails to upload', 'error');
      return null;
    }

    if (pairs.length === 1) {
      await this.uploadOne(pairs[0].target, pairs[0].image);
      App.toast(`Thumbnail set for ${pairs[0].target.name}`, 'success');
      await explorer.refresh({ filesOnly: true });
      return { count: 1 };
    }

    const form = new FormData();
    form.append('fileIds', JSON.stringify(pairs.map((p) => p.target.id)));
    for (const pair of pairs) {
      form.append('thumbnails', pair.image, pair.image.name);
    }

    const result = await API.files.uploadThumbnailBatch(form);
    if (result?.taskId) {
      TaskPanel.track(result.taskId);
      TaskPanel.setExpanded(true);
    }
    App.toast(`Uploading ${pairs.length} custom thumbnail(s)`, 'success');
    return result;
  },

  async runForTargets(targets, imageFiles) {
    const { pairs, unmatched } = this.matchImagesToTargets(targets, imageFiles);
    if (!pairs.length) {
      App.toast('No matching images found for the selected files', 'error');
      return null;
    }
    if (unmatched.length) {
      App.toast(
        `${unmatched.length} file(s) had no matching image and were skipped`,
        'error'
      );
    }
    return this.uploadPairs(pairs);
  },

  async runForFile(file) {
    const imageFile = await this.pickImages(false);
    if (!imageFile) return null;
    try {
      App.toast(`Setting thumbnail for ${file.name}...`);
      await this.uploadOne(file, imageFile);
      App.toast(`Thumbnail set for ${file.name}`, 'success');
      await explorer.refresh({ filesOnly: true });
      return true;
    } catch (err) {
      App.toast(err.message || 'Thumbnail upload failed', 'error');
      throw err;
    }
  },

  async runForSelection() {
    const targets = explorer.getSelectedFileObjects();
    if (!targets.length) {
      App.toast('Select at least one file', 'error');
      return null;
    }

    const images = await this.pickImages(true);
    if (!images.length) return null;

    try {
      return await this.runForTargets(targets, images);
    } catch (err) {
      App.toast(err.message || 'Thumbnail upload failed', 'error');
      throw err;
    }
  },

  pickImages(multiple) {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.multiple = !!multiple;
      input.hidden = true;
      input.addEventListener('change', () => {
        const files = [...(input.files || [])];
        input.remove();
        resolve(multiple ? files : (files[0] || null));
      });
      document.body.appendChild(input);
      input.click();
    });
  },
};
