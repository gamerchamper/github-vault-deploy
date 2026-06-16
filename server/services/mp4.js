const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');

const execFileAsync = promisify(execFile);

function isMp4(name, mimeType) {
  return mimeType === 'video/mp4' || /\.mp4$/i.test(name || '');
}

async function remuxFaststart(inputPath, outputPath) {
  if (!fs.existsSync(inputPath)) throw new Error('Input file not found for remux');

  await execFileAsync('ffmpeg', [
    '-y',
    '-i', inputPath,
    '-c', 'copy',
    '-movflags', 'faststart',
    outputPath,
  ], { timeout: 30 * 60 * 1000 });

  if (!fs.existsSync(outputPath)) {
    throw new Error('Faststart remux failed — output not created');
  }
}

async function probeDuration(filePath) {
  const info = await probeMediaInfo(filePath).catch(() => null);
  return info?.duration_sec || null;
}

function normalizeContainer(formatName, fallback = null) {
  const raw = String(formatName || '').toLowerCase();
  if (!raw) return fallback;
  if (raw.includes('mp4') || raw.includes('mov') || raw.includes('m4v')) return 'mp4';
  if (raw.includes('matroska') || raw.includes('mkv')) return 'mkv';
  if (raw.includes('webm')) return 'webm';
  return raw.split(',')[0] || fallback;
}

function videoResolutionLabel(height) {
  const h = Number(height) || 0;
  if (h >= 2160) return '4k';
  if (h >= 1440) return '1440';
  if (h >= 1080) return '1080';
  if (h >= 720) return '720';
  if (h >= 576) return '576';
  if (h >= 480) return '480';
  return h > 0 ? 'sd' : null;
}

async function probeMediaInfo(input, { userAgent = 'Lavf/60.16.100', timeoutMs = 120000 } = {}) {
  if (!input) throw new Error('probe target required');
  if (typeof input === 'string' && input.startsWith('/') && !fs.existsSync(input)) {
    throw new Error('Input file not found for probe');
  }

  const args = [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
  ];
  if (userAgent) args.push('-user_agent', userAgent);
  args.push(String(input));

  const { stdout } = await execFileAsync('ffprobe', args, { timeout: timeoutMs });
  const data = JSON.parse(stdout || '{}');
  const streams = Array.isArray(data.streams) ? data.streams : [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  const durationSec = parseFloat(data.format?.duration);

  return {
    container: normalizeContainer(data.format?.format_name),
    video_codec: video?.codec_name || null,
    video_profile: video?.profile || null,
    audio_codec: audio?.codec_name || null,
    audio_channels: audio?.channels || null,
    width: video?.width || null,
    height: video?.height || null,
    video_resolution: videoResolutionLabel(video?.height),
    bitrate: parseInt(data.format?.bit_rate, 10) || null,
    duration_sec: Number.isFinite(durationSec) && durationSec > 0 ? durationSec : null,
  };
}

module.exports = {
  isMp4,
  remuxFaststart,
  probeDuration,
  probeMediaInfo,
  normalizeContainer,
  videoResolutionLabel,
};
