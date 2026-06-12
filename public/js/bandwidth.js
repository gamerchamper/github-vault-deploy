const BandwidthPanel = {
  tab: null,
  pollTimer: null,

  init() {
    this.tab = document.getElementById('bandwidth-tab');
  },

  formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
  },

  show() {
    if (!this.tab) return;
    this.tab.classList.remove('hidden');
    this.render();
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => this.render(), 30000);
    }
  },

  hide() {
    if (this.tab) this.tab.classList.add('hidden');
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  },

  async render() {
    try {
      const data = await API.bandwidth.summary();
      this.renderSummary(data);
      this.renderTopFiles(data.topFiles);
    } catch { /* ignore */ }
  },

  renderSummary(data) {
    const hour = this.renderPeriod(data.hour);
    const day = this.renderPeriod(data.day);
    const month = this.renderPeriod(data.month);
    const total = this.formatBytes(data.total?.totalBytes || 0);
    const el = document.getElementById('bandwidth-summary');
    if (el) {
      el.innerHTML = `
        <div class="bw-row"><span class="bw-label">Last hour</span><span class="bw-value">${hour}</span></div>
        <div class="bw-row"><span class="bw-label">Last 24 hours</span><span class="bw-value">${day}</span></div>
        <div class="bw-row"><span class="bw-label">Last 30 days</span><span class="bw-value">${month}</span></div>
        <div class="bw-row bw-total"><span class="bw-label">Lifetime</span><span class="bw-value">${total}</span></div>
      `;
    }
  },

  renderPeriod(p) {
    if (!p || p.totalBytes === 0) return '0 B';
    const stream = this.formatBytes(p.streamBytes || 0);
    const download = this.formatBytes(p.downloadBytes || 0);
    const total = this.formatBytes(p.totalBytes || 0);
    return `${total} <span class="bw-detail">(stream: ${stream}, dl: ${download})</span>`;
  },

  renderTopFiles(files) {
    const el = document.getElementById('bandwidth-top-files');
    if (!el) return;
    if (!files || files.length === 0) {
      el.innerHTML = '<p class="bw-empty">No bandwidth data yet</p>';
      return;
    }
    el.innerHTML = files.map((f, i) => `
      <div class="bw-file-row">
        <span class="bw-file-rank">${i + 1}</span>
        <span class="bw-file-name">${this.escape(f.name)}</span>
        <span class="bw-file-bytes">${this.formatBytes(f.total_bytes)}</span>
      </div>
    `).join('');
  },

  escape(str) {
    const n = document.createElement('span');
    n.textContent = str || '';
    return n.innerHTML;
  },
};