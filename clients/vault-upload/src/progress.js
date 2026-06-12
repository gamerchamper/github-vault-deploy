function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '--/s';
  return formatBytes(bytesPerSec) + '/s';
}

function formatTime(seconds) {
  if (!seconds || seconds <= 0 || !Number.isFinite(seconds)) return '--';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}m ${s}s`;
  }
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function renderProgressLine({ chunksDone, totalChunks, percent, bytesUploaded, speed, eta }) {
  const barWidth = 30;
  const filled = Math.round((percent / 100) * barWidth);
  const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, barWidth - filled));
  const pct = `${percent}%`.padStart(4);
  const chunks = `${chunksDone}/${totalChunks}`;
  const uploaded = formatBytes(bytesUploaded || 0).padStart(9);
  const spd = formatSpeed(speed).padStart(10);
  const etaStr = formatTime(eta).padStart(7);
  return `\r${bar} ${pct} ${chunks} ${uploaded} ${spd} ETA ${etaStr}`;
}

function renderFinalLine(result) {
  if (!result) return 'Upload paused or cancelled.';
  return `\nDone: ${result.name || 'file'} (${result.id || ''}) ${formatBytes(result.size || 0)}`;
}

function renderTable(sessions) {
  if (!sessions || sessions.length === 0) return 'No sessions found.';
  const lines = ['Task ID                               File              Status    Chunks    Progress'];
  lines.push('-'.repeat(90));
  for (const s of sessions) {
    const taskId = (s.taskId || '').padEnd(38).slice(0, 38);
    const name = (s.fileName || '').padEnd(17).slice(0, 17);
    const status = (s.status || '').padEnd(9).slice(0, 9);
    const chunks = `${s.chunksDone || 0}/${s.totalChunks || 0}`.padEnd(9).slice(0, 9);
    const pct = s.totalChunks > 0 ? `${Math.round(((s.chunksDone || 0) / s.totalChunks) * 100)}%` : '0%';
    lines.push(`${taskId} ${name} ${status} ${chunks} ${pct}`);
  }
  return lines.join('\n');
}

module.exports = { formatBytes, formatSpeed, formatTime, renderProgressLine, renderFinalLine, renderTable };
