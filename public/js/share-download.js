const ShareDownload = {
  ZIP_PART_SIZE: 1024 * 1024 * 1024,
  DESKTOP_SINGLE_MAX: 768 * 1024 * 1024,
  MOBILE_SINGLE_MAX: 200 * 1024 * 1024,

  singleMaxBytes() {
    return ShareClientStream.isLowMemoryDevice()
      ? this.MOBILE_SINGLE_MAX
      : this.DESKTOP_SINGLE_MAX;
  },

  isLargeFile(size) {
    return (size || 0) > this.singleMaxBytes();
  },

  canUseDirectoryPicker() {
    return typeof window.showDirectoryPicker === 'function';
  },

  async pickSaveDirectory() {
    return window.showDirectoryPicker({ mode: 'readwrite' });
  },

  async writeBlobToDirectory(dirHandle, filename, blob) {
    const handle = await dirHandle.getFileHandle(filename, { create: true });
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
  },

  sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  },

  triggerSaveAnchor(blob, filename) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      requestAnimationFrame(() => {
        a.click();
        setTimeout(() => {
          a.remove();
          URL.revokeObjectURL(url);
          resolve();
        }, 500);
      });
    });
  },

  async triggerSave(blob, filename, { dirHandle = null } = {}) {
    if (dirHandle) {
      await this.writeBlobToDirectory(dirHandle, filename, blob);
      return;
    }
    await this.triggerSaveAnchor(blob, filename);
  },

  buildManifest(fileName, totalSize, totalParts) {
    return {
      format: 'github-vault-split-v1',
      original_name: fileName,
      total_size: totalSize,
      part_size: this.ZIP_PART_SIZE,
      total_parts: totalParts,
      combine_unix: `cat payload.part*.bin > ${fileName}`,
      combine_windows: `copy /b payload.part001.bin+payload.part002.bin+... ${fileName}`,
      note: 'Extract each zip, then combine payload.part*.bin files in numeric order.',
    };
  },

  buildReadme(fileName, totalSize, totalParts) {
    const sizeStr = typeof formatSize === 'function' ? formatSize(totalSize) : `${totalSize} bytes`;
    return [
      'GitHub Vault — split offline download',
      '',
      `Original file: ${fileName}`,
      `Total size: ${sizeStr}`,
      `Parts: ${totalParts} zip file(s), ~1 GB each`,
      '',
      '1. Extract every .zip',
      '2. Combine the payload.part*.bin files in order:',
      '',
      `   Linux/macOS: cat payload.part*.bin > ${fileName}`,
      `   Windows:     copy /b payload.part001.bin+payload.part002.bin+... ${fileName}`,
      '',
      'See manifest.json for details.',
    ].join('\n');
  },

  async exportShare(token, file, onProgress, options = {}) {
    const sameSession = ShareClientStream.token === token
      && ShareClientStream.fileId === file.id
      && ShareClientStream.manifest;

    if (sameSession) {
      if (onProgress) ShareClientStream.onProgress = onProgress;
      ShareClientStream.onProgress(ShareClientStream.getDownloadStatus());
    } else {
      if (ShareClientStream.stream) ShareClientStream.resetStream();
      await ShareClientStream.load(token, file.id, onProgress);
    }

    const size = ShareClientStream.manifest?.size || file.size || 0;
    const name = ShareClientStream.manifest?.name || file.name;
    const dirHandle = options.dirHandle ?? null;

    if (size <= this.singleMaxBytes()) {
      await ShareClientStream.fetchAllForDownload(onProgress);
      const blob = await ShareClientStream.buildFullBlobAsync();
      ShareClientStream.saveToCache(blob);
      await this.triggerSave(blob, name, { dirHandle });
      return { mode: 'single', parts: 1, name, pendingParts: [] };
    }

    return this.exportSplitZips(name, size, onProgress, { dirHandle });
  },

  async exportSplitZips(fileName, totalSize, onProgress, { dirHandle = null } = {}) {
    const totalParts = Math.max(1, Math.ceil(totalSize / this.ZIP_PART_SIZE));
    const base = fileName.includes('.')
      ? fileName.slice(0, fileName.lastIndexOf('.'))
      : fileName;
    const totalChunks = ShareClientStream.manifest.chunks.length;
    const pendingParts = [];

    let partNum = 1;
    let partBuffers = [];
    let partSize = 0;
    let savedParts = 0;
    let anchorUsed = false;

    const flushPart = async () => {
      if (!partBuffers.length) return;
      const thisPart = partNum;
      const zipName = `${base}.part${String(thisPart).padStart(2, '0')}of${String(totalParts).padStart(2, '0')}.zip`;
      const entries = [];

      if (thisPart === 1) {
        entries.push({
          name: 'README.txt',
          data: ShareZip.utf8(this.buildReadme(fileName, totalSize, totalParts)),
        });
        entries.push({
          name: 'manifest.json',
          data: ShareZip.utf8(JSON.stringify(this.buildManifest(fileName, totalSize, totalParts), null, 2)),
        });
      }

      const payloadName = `payload.part${String(thisPart).padStart(3, '0')}.bin`;
      entries.push({
        name: payloadName,
        data: partBuffers,
        size: partSize,
      });

      const zipBlob = ShareZip.create(entries);
      partBuffers = [];
      partSize = 0;

      if (dirHandle) {
        await this.writeBlobToDirectory(dirHandle, zipName, zipBlob);
      } else if (!anchorUsed) {
        await this.triggerSaveAnchor(zipBlob, zipName);
        anchorUsed = true;
      } else {
        pendingParts.push({ blob: zipBlob, name: zipName });
      }

      savedParts += 1;
      partNum += 1;

      if (onProgress) {
        onProgress({
          stage: savedParts >= totalParts && !pendingParts.length ? 'ready' : 'caching',
          segments: savedParts,
          total_segments: totalParts,
          progress: Math.round((savedParts / totalParts) * 100),
          mode: 'client',
          ready: savedParts >= totalParts && !pendingParts.length,
          buffered: savedParts >= totalParts && !pendingParts.length,
          client_stream: true,
        });
      }

      if (!dirHandle) {
        await this.sleep(ShareClientStream.isLowMemoryDevice() ? 2000 : 400);
      }
    };

    for (let i = 0; i < totalChunks; i++) {
      if (!ShareClientStream.isChunkReady(i)) {
        await ShareClientStream.fetchOne(i);
      }
      const bytes = await ShareClientStream.getChunkBytes(i);
      if (!bytes) throw new Error(`Missing chunk ${i} for download`);

      const chunk = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      partBuffers.push(chunk);
      partSize += chunk.byteLength;
      ShareClientStream.chunks[i] = ShareClientStream.CHUNK_ON_DISK;

      if (partSize >= this.ZIP_PART_SIZE) {
        await flushPart();
      }

      if (onProgress) {
        onProgress({
          stage: 'fetching',
          segments: i + 1,
          total_segments: totalChunks,
          progress: Math.round(((i + 1) / totalChunks) * 100),
          mode: 'client',
          ready: false,
          buffered: false,
          client_stream: true,
        });
      }
    }

    if (partBuffers.length) {
      await flushPart();
    }

    return {
      mode: 'split',
      parts: savedParts,
      name: fileName,
      totalParts,
      pendingParts,
      usedDirectory: !!dirHandle,
    };
  },
};

const ShareZip = {
  utf8(text) {
    return new TextEncoder().encode(text);
  },

  crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
      crc ^= bytes[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  },

  crc32Parts(parts, size) {
    let crc = 0xffffffff;
    let remaining = size;
    for (const part of parts) {
      const view = part instanceof Uint8Array ? part : new Uint8Array(part);
      const len = remaining < view.length ? remaining : view.length;
      for (let i = 0; i < len; i++) {
        crc ^= view[i];
        for (let j = 0; j < 8; j++) {
          crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
      }
      remaining -= len;
      if (remaining <= 0) break;
    }
    return (crc ^ 0xffffffff) >>> 0;
  },

  u16(n) {
    return new Uint8Array([n & 0xff, (n >> 8) & 0xff]);
  },

  u32(n) {
    return new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >> 24) & 0xff]);
  },

  create(entries) {
    const blobParts = [];
    const central = [];
    let offset = 0;

    for (const entry of entries) {
      const name = this.utf8(entry.name);
      const parts = Array.isArray(entry.data) ? entry.data : [entry.data];
      const size = entry.size ?? parts.reduce((s, p) => s + p.byteLength, 0);
      const crc = Array.isArray(entry.data)
        ? this.crc32Parts(parts, size)
        : this.crc32(parts[0] instanceof Uint8Array ? parts[0] : new Uint8Array(parts[0]));

      const header = new Uint8Array(30 + name.length);
      const view = new DataView(header.buffer);
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(8, 0, true);
      view.setUint16(10, 0, true);
      view.setUint32(14, crc, true);
      view.setUint32(18, size, true);
      view.setUint32(22, size, true);
      view.setUint16(26, name.length, true);
      header.set(name, 30);

      blobParts.push(header);
      for (const part of parts) blobParts.push(part);

      const cd = new Uint8Array(46 + name.length);
      const cdv = new DataView(cd.buffer);
      cdv.setUint32(0, 0x02014b50, true);
      cdv.setUint16(10, 0, true);
      cdv.setUint16(12, 0, true);
      cdv.setUint32(16, crc, true);
      cdv.setUint32(20, size, true);
      cdv.setUint32(24, size, true);
      cdv.setUint16(28, name.length, true);
      cdv.setUint32(42, offset, true);
      cd.set(name, 46);
      central.push(cd);

      offset += header.length + size;
    }

    blobParts.push(...central);
    blobParts.push(new Uint8Array(22));
    const end = new DataView(blobParts[blobParts.length - 1].buffer);
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, central.reduce((s, c) => s + c.length, 0), true);
    end.setUint32(16, offset, true);

    return new Blob(blobParts, { type: 'application/zip' });
  },
};
