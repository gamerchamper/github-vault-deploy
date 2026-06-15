const ShareDownload = {
  ZIP_PART_SIZE: 1024 * 1024 * 1024,
  DESKTOP_SINGLE_MAX: 768 * 1024 * 1024,
  MOBILE_SINGLE_MAX: 200 * 1024 * 1024,
  WRITE_CHUNK: 16 * 1024 * 1024,

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
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    await this.ensureDirPermission(handle);
    return handle;
  },

  async ensureDirPermission(dirHandle) {
    if (!dirHandle?.queryPermission) return;
    let perm = await dirHandle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      perm = await dirHandle.requestPermission({ mode: 'readwrite' });
    }
    if (perm !== 'granted') {
      throw new Error('Folder permission denied — cannot save download');
    }
  },

  async writeTextToDirectory(dirHandle, filename, text) {
    const data = new TextEncoder().encode(text);
    return this.writePartsToDirectory(dirHandle, filename, [data], data.byteLength);
  },

  async writePartsToDirectory(dirHandle, filename, parts, expectedSize) {
    await this.ensureDirPermission(dirHandle);
    const handle = await dirHandle.getFileHandle(filename, { create: true });
    const writable = await handle.createWritable();
    let written = 0;

    try {
      for (const part of parts) {
        const view = part instanceof Uint8Array ? part : new Uint8Array(part);
        for (let offset = 0; offset < view.byteLength; offset += this.WRITE_CHUNK) {
          const slice = view.subarray(offset, Math.min(offset + this.WRITE_CHUNK, view.byteLength));
          await writable.write(slice);
        }
        written += view.byteLength;
      }
    } finally {
      await writable.close();
    }

    const file = await handle.getFile();
    if (expectedSize > 0 && file.size !== expectedSize) {
      throw new Error(`Save failed for ${filename}: wrote ${file.size} of ${expectedSize} bytes`);
    }
    return { name: filename, size: file.size };
  },

  async writeBlobToDirectory(dirHandle, filename, blob) {
    await this.ensureDirPermission(dirHandle);
    const handle = await dirHandle.getFileHandle(filename, { create: true });
    const writable = await handle.createWritable();

    try {
      for (let offset = 0; offset < blob.size; offset += this.WRITE_CHUNK) {
        const slice = blob.slice(offset, Math.min(offset + this.WRITE_CHUNK, blob.size));
        await writable.write(slice);
      }
    } finally {
      await writable.close();
    }

    const file = await handle.getFile();
    if (file.size !== blob.size) {
      throw new Error(`Save failed for ${filename}: wrote ${file.size} of ${blob.size} bytes`);
    }
    return { name: filename, size: file.size };
  },

  downloadProgress(partial) {
    return {
      stage: 'starting',
      segments: 0,
      total_segments: 0,
      progress: 0,
      percent: 0,
      mode: 'client',
      ready: false,
      buffered: false,
      client_stream: true,
      ...partial,
    };
  },

  sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  },

  triggerSaveAnchor(blob, filename) {
    return new Promise((resolve, reject) => {
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
          resolve({ name: filename, size: blob.size });
        }, 500);
      });
      a.addEventListener('error', () => {
        URL.revokeObjectURL(url);
        a.remove();
        reject(new Error(`Browser blocked download for ${filename}`));
      }, { once: true });
    });
  },

  async triggerSave(blob, filename, { dirHandle = null } = {}) {
    if (dirHandle) {
      return this.writeBlobToDirectory(dirHandle, filename, blob);
    }
    return this.triggerSaveAnchor(blob, filename);
  },

  payloadPartName(partNum) {
    return `payload.part${String(partNum).padStart(3, '0')}.bin`;
  },

  payloadPartNames(totalParts) {
    return Array.from({ length: totalParts }, (_, i) => this.payloadPartName(i + 1));
  },

  quoteFileName(name) {
    return `"${String(name).replace(/"/g, '""')}"`;
  },

  combineCommands(fileName, totalParts) {
    const parts = this.payloadPartNames(totalParts);
    const out = this.quoteFileName(fileName);
    const concat = parts.join('+');
    const unixParts = parts.join(' ');
    return {
      parts,
      unix: `cat ${unixParts} > ${out}`,
      unixGlob: `cat payload.part*.bin > ${out}`,
      windowsCmd: `copy /b ${concat} ${out}`,
      windowsPowerShell: `cmd /c 'copy /b ${concat} ${out}'`,
    };
  },

  buildManifest(fileName, totalSize, totalParts, useDirectory = true) {
    const cmds = this.combineCommands(fileName, totalParts);
    return {
      format: 'github-vault-split-v1',
      original_name: fileName,
      total_size: totalSize,
      part_size: this.ZIP_PART_SIZE,
      total_parts: totalParts,
      payload_files: cmds.parts,
      combine_unix: cmds.unix,
      combine_unix_glob: cmds.unixGlob,
      combine_windows_cmd: cmds.windowsCmd,
      combine_windows_powershell: cmds.windowsPowerShell,
      note: useDirectory
        ? 'Run the combine command from the folder containing payload.part*.bin files.'
        : 'Extract each zip, then run the combine command in that folder.',
    };
  },

  buildReadme(fileName, totalSize, totalParts, useDirectory) {
    const sizeStr = typeof formatSize === 'function' ? formatSize(totalSize) : `${totalSize} bytes`;
    const cmds = this.combineCommands(fileName, totalParts);
    const lines = [
      'GitHub Vault — split offline download',
      '',
      `Original file: ${fileName}`,
      `Total size: ${sizeStr}`,
      `Parts: ${totalParts} ${useDirectory ? 'payload file(s)' : 'zip file(s)'}, ~1 GB each`,
      '',
      'Payload files (in order):',
      ...cmds.parts.map((p) => `  - ${p}`),
      '',
    ];
    if (useDirectory) {
      lines.push(
        'Payload files are saved directly in your chosen folder.',
        'Open Command Prompt in that folder, or use the PowerShell line below.',
      );
    } else {
      lines.push(
        '1. Extract every .zip into one folder',
        '2. Open Command Prompt in that folder (or use PowerShell below)',
      );
    }
    lines.push(
      '',
      'Linux / macOS (Terminal):',
      `  ${cmds.unix}`,
      `  (or: ${cmds.unixGlob})`,
      '',
      'Windows — Command Prompt (cmd.exe):',
      '  Do NOT paste into PowerShell; open cmd.exe or use the PowerShell line below.',
      `  ${cmds.windowsCmd}`,
      '',
      'Windows — PowerShell:',
      '  PowerShell aliases "copy" to Copy-Item; use cmd /c instead:',
      `  ${cmds.windowsPowerShell}`,
      '',
      'See manifest.json for the same commands and file list.',
    );
    return lines.join('\n');
  },

  async exportShare(token, file, onProgress, options = {}) {
    const reuseSession = ShareClientStream.token === token
      && ShareClientStream.fileId === file.id
      && !!ShareClientStream.manifest;

    ShareStreamLog?.info('download:export-start', {
      fileId: file.id,
      reuseSession,
      size: file.size,
    });

    await ShareClientStream.load(token, file.id, onProgress);

    if (onProgress) {
      onProgress(this.downloadProgress({
        stage: 'starting',
        total_segments: ShareClientStream.manifest?.chunks?.length || file.chunk_count || 0,
      }));
    }

    const size = ShareClientStream.manifest?.size || file.size || 0;
    const name = ShareClientStream.manifest?.name || file.name;
    const dirHandle = options.dirHandle ?? null;

    ShareStreamLog?.info('download:export-mode', {
      size,
      split: size > this.singleMaxBytes(),
      dir: !!dirHandle,
    });

    try {
      if (size <= this.singleMaxBytes()) {
        if (onProgress) {
          onProgress(this.downloadProgress({
            stage: 'fetching',
            total_segments: ShareClientStream.manifest?.chunks?.length || 0,
          }));
        }
        await ShareClientStream.fetchAllForDownload(onProgress);
        const blob = await ShareClientStream.buildFullBlobAsync();
        ShareClientStream.saveToCache(blob);
        const saved = await this.triggerSave(blob, name, { dirHandle });
        return {
          mode: 'single',
          parts: 1,
          name,
          pendingParts: [],
          savedFiles: saved ? [saved] : [],
          usedDirectory: !!dirHandle,
        };
      }

      return await this.exportSplitZips(name, size, onProgress, { dirHandle });
    } catch (err) {
      ShareStreamLog?.error('download:export-failed', {
        message: typeof ShareStreamLog !== 'undefined' ? ShareStreamLog.formatError(err) : (err.message || String(err)),
      });
      throw err;
    }
  },

  async exportSplitZips(fileName, totalSize, onProgress, { dirHandle = null } = {}) {
    const totalParts = Math.max(1, Math.ceil(totalSize / this.ZIP_PART_SIZE));
    const base = fileName.includes('.')
      ? fileName.slice(0, fileName.lastIndexOf('.'))
      : fileName;
    const totalChunks = ShareClientStream.manifest.chunks.length;
    const pendingParts = [];
    const savedFiles = [];

    let partNum = 1;
    let partBuffers = [];
    let partSize = 0;
    let savedParts = 0;
    let anchorUsed = false;

    const flushPart = async () => {
      if (!partBuffers.length) return;
      const thisPart = partNum;
      const zipName = `${base}.part${String(thisPart).padStart(2, '0')}of${String(totalParts).padStart(2, '0')}.zip`;
      const payloadName = `payload.part${String(thisPart).padStart(3, '0')}.bin`;

      if (dirHandle) {
        if (thisPart === 1) {
          savedFiles.push(await this.writeTextToDirectory(
            dirHandle,
            'README.txt',
            this.buildReadme(fileName, totalSize, totalParts, true),
          ));
          savedFiles.push(await this.writeTextToDirectory(
            dirHandle,
            'manifest.json',
            JSON.stringify(this.buildManifest(fileName, totalSize, totalParts, true), null, 2),
          ));
        }
        savedFiles.push(await this.writePartsToDirectory(dirHandle, payloadName, partBuffers, partSize));
      } else {
        const entries = [];
        if (thisPart === 1) {
          entries.push({
            name: 'README.txt',
            data: ShareZip.utf8(this.buildReadme(fileName, totalSize, totalParts, false)),
          });
          entries.push({
            name: 'manifest.json',
            data: ShareZip.utf8(JSON.stringify(this.buildManifest(fileName, totalSize, totalParts, false), null, 2)),
          });
        }
        entries.push({
          name: payloadName,
          data: partBuffers,
          size: partSize,
        });
        const zipBlob = ShareZip.create(entries);
        if (!anchorUsed) {
          savedFiles.push(await this.triggerSaveAnchor(zipBlob, zipName));
          anchorUsed = true;
        } else {
          pendingParts.push({ blob: zipBlob, name: zipName });
        }
      }

      partBuffers = [];
      partSize = 0;
      savedParts += 1;
      partNum += 1;

      if (onProgress) {
        onProgress(this.downloadProgress({
          stage: savedParts >= totalParts && !pendingParts.length ? 'ready' : 'caching',
          segments: savedParts,
          total_segments: totalParts,
          progress: Math.round((savedParts / totalParts) * 100),
          percent: Math.round((savedParts / totalParts) * 100),
          ready: savedParts >= totalParts && !pendingParts.length,
          buffered: savedParts >= totalParts && !pendingParts.length,
        }));
      }

      if (!dirHandle && !pendingParts.length) {
        await this.sleep(ShareClientStream.isLowMemoryDevice() ? 2000 : 400);
      }
    };

    for (let i = 0; i < totalChunks; i++) {
      if (!ShareClientStream.isChunkReady(i)) {
        ShareStreamLog?.debug('download:fetch-chunk', { index: i });
        await ShareClientStream.fetchOne(i);
      }
      const bytes = await ShareClientStream.getChunkBytes(i);
      if (!bytes) throw new Error(`Missing chunk ${i} for download`);

      const chunk = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      partBuffers.push(chunk);
      partSize += chunk.byteLength;
      if (ShareClientStream.chunks[i] !== ShareClientStream.CHUNK_ON_DISK) {
        await ShareClientStream.persistChunkToCache(i);
      }

      if (partSize >= this.ZIP_PART_SIZE) {
        await flushPart();
      }

      if (onProgress) {
        onProgress(this.downloadProgress({
          stage: 'fetching',
          segments: i + 1,
          total_segments: totalChunks,
          progress: Math.round(((i + 1) / totalChunks) * 100),
          percent: Math.round(((i + 1) / totalChunks) * 100),
        }));
      }

      if (ShareClientStream.shouldYieldForPlayback()) {
        await this.sleep(120);
      }
    }

    if (partBuffers.length) {
      await flushPart();
    }

    if (dirHandle && !savedFiles.length) {
      throw new Error('No files were written to the selected folder');
    }

    return {
      mode: 'split',
      parts: savedParts,
      name: fileName,
      totalParts,
      pendingParts,
      savedFiles,
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
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, entries.length, true);
    ev.setUint16(10, entries.length, true);
    ev.setUint32(12, central.reduce((s, c) => s + c.length, 0), true);
    ev.setUint32(16, offset, true);
    blobParts.push(end);

    return new Blob(blobParts, { type: 'application/zip' });
  },
};
