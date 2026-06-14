/**
 * Details panel — embedded live previews
 */
const DetailsPreview = {
  mount: null,
  pdfId: null,
  hlLoaded: false,

  init() {
    this.mount = document.getElementById('details-preview-mount');
  },

  clear() {
    if (this.pdfId) {
      PdfViewer?.destroy?.(this.pdfId);
      this.pdfId = null;
    }
    if (this.mount) {
      this.mount.querySelectorAll('video, audio').forEach((el) => {
        try {
          el.pause();
          el.removeAttribute('src');
          el.load();
        } catch { /* ignore */ }
      });
      this.mount.innerHTML = '';
    }
    this.mount?.classList.add('hidden');
  },

  async show(file) {
    if (!this.mount) this.init();
    if (!this.mount || file.is_folder) {
      this.clear();
      return;
    }

    this.clear();
    const type = getPreviewType(file.name, file.mime_type);
    if (!type) return;

    this.mount.classList.remove('hidden');
    const view = explorer?.accountView;

    if (type === 'image') {
      const v = file.thumbVersion ? `?v=${file.thumbVersion}` : '';
      this.mount.innerHTML = `<img class="details-preview-img" src="/api/files/view/${file.id}${v}" alt="">`;
      return;
    }

    if (type === 'video') {
      this.mount.innerHTML = `
        <div class="details-preview-media vault-video-enhanced-wrap">
          <video class="details-preview-video vault-video-enhanced" controls playsinline preload="metadata"
            x-webkit-airplay="allow"
            src="${API.files.stream(file.id, view)}"></video>
        </div>`;
      MediaPlayer?.configureVideoElement?.(this.mount.querySelector('.details-preview-video'));
      return;
    }

    if (type === 'audio') {
      this.mount.innerHTML = `
        <div class="details-preview-media details-preview-audio">
          <audio class="details-preview-audio-el" controls preload="metadata"
            src="${API.files.stream(file.id, view)}"></audio>
        </div>`;
      return;
    }

    if (type === 'pdf') {
      const el = document.createElement('div');
      el.id = 'details-pdf-mount';
      el.className = 'details-preview-pdf';
      this.mount.appendChild(el);
      this.pdfId = 'details-pdf-mount';
      PdfViewer.mount(el, API.files.view(file.id, view), { compact: true });
      return;
    }

    if (type === 'text' || type === 'html') {
      await this.showText(file, type, view);
    }
  },

  async showText(file, type, view) {
    const max = 48 * 1024;
    try {
      const res = await fetch(API.files.view(file.id, view), { credentials: 'same-origin' });
      if (!res.ok) throw new Error('Preview unavailable');
      const blob = await res.blob();
      const slice = blob.size > max ? blob.slice(0, max) : blob;
      let text = await slice.text();
      if (blob.size > max) text += '\n…';

      const ext = file.name.split('.').pop().toLowerCase();
      const isCode = type === 'text' && this.isCodeExt(ext);
      const pre = document.createElement('pre');
      pre.className = isCode ? 'details-preview-code' : 'details-preview-text';
      const code = document.createElement('code');
      code.className = isCode ? `language-${this.hlLang(ext)}` : '';
      code.textContent = text;
      pre.appendChild(code);
      this.mount.appendChild(pre);

      if (isCode) await this.highlight(code);
    } catch {
      this.mount.innerHTML = '<div class="details-preview-fallback">Preview unavailable</div>';
    }
  },

  isCodeExt(ext) {
    return [
      'js', 'ts', 'jsx', 'tsx', 'py', 'rb', 'go', 'rs', 'java', 'css', 'scss', 'html', 'htm',
      'json', 'xml', 'yaml', 'yml', 'sql', 'sh', 'bash', 'c', 'cpp', 'cs', 'php', 'swift', 'kt',
      'vue', 'svelte', 'lua', 'r',
    ].includes(ext);
  },

  hlLang(ext) {
    const map = {
      js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript',
      py: 'python', rb: 'ruby', rs: 'rust', cs: 'csharp', yml: 'yaml', sh: 'bash',
      htm: 'html', cpp: 'cpp', h: 'c',
    };
    return map[ext] || ext;
  },

  async highlight(codeEl) {
    if (typeof hljs !== 'undefined') {
      hljs.highlightElement(codeEl);
      return;
    }
    if (!this.hlLoaded) {
      this.hlLoaded = true;
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github-dark.min.css';
      document.head.appendChild(link);
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js';
        s.onload = resolve;
        s.onerror = reject;
        document.head.appendChild(s);
      });
    }
    if (typeof hljs !== 'undefined') hljs.highlightElement(codeEl);
  },
};
