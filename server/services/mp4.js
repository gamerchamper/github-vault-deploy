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
  if (!fs.existsSync(filePath)) return null;

  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ], { timeout: 60 * 1000 });

  const sec = parseFloat(stdout.trim());
  return Number.isFinite(sec) && sec > 0 ? sec : null;
}

module.exports = { isMp4, remuxFaststart, probeDuration };
