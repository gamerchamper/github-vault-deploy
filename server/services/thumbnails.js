const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { v4: uuidv4 } = require('uuid');
const coverArt = require('./cover-art');
const typeThumbnails = require('./type-thumbnails');

const execFileAsync = promisify(execFile);

let sharp;
let musicMetadata;
try {
  sharp = require('sharp');
} catch {
  sharp = null;
}
try {
  musicMetadata = require('music-metadata');
} catch {
  musicMetadata = null;
}

const THUMB_SIZE = 200;

const AUDIO_EXT = new Set(['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mkv', 'avi', 'mov', 'm4v', 'ogv', 'wmv']);

function isAudio(mimeType, fileName) {
  if (mimeType?.startsWith('audio/')) return true;
  const ext = fileName?.split('.').pop()?.toLowerCase();
  return AUDIO_EXT.has(ext);
}

function isVideo(mimeType, fileName) {
  if (mimeType?.startsWith('video/')) return true;
  const ext = fileName?.split('.').pop()?.toLowerCase();
  return VIDEO_EXT.has(ext);
}

function isJar(mimeType, fileName) {
  return typeThumbnails.isJar(mimeType, fileName);
}

function supportsOnDemandThumbnail(mimeType, fileName) {
  return isAudio(mimeType, fileName)
    || isVideo(mimeType, fileName)
    || isJar(mimeType, fileName);
}

async function toThumbJpeg(buffer) {
  if (!sharp || !buffer?.length) return null;
  try {
    return await sharp(buffer)
      .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'cover', position: 'centre' })
      .jpeg({ quality: 85 })
      .toBuffer();
  } catch {
    return null;
  }
}

async function fromEmbeddedAudioArt(buffer, mimeType) {
  if (!musicMetadata || !buffer?.length) return null;
  try {
    const meta = await musicMetadata.parseBuffer(buffer, mimeType, { duration: false });
    const picture = meta.common.picture?.[0];
    if (!picture?.data?.length) return null;
    return toThumbJpeg(picture.data);
  } catch {
    return null;
  }
}

async function fromVideoFrame(buffer) {
  if (!buffer?.length) return null;

  const id = uuidv4();
  const tmpVideo = path.join(os.tmpdir(), `vault-thumb-${id}`);
  const tmpImage = `${tmpVideo}.jpg`;

  try {
    fs.writeFileSync(tmpVideo, buffer);
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', tmpVideo,
      '-map', '0:v:0',
      '-frames:v', '1',
      '-q:v', '3',
      '-y', tmpImage,
    ], { timeout: 30000 });

    if (!fs.existsSync(tmpImage)) return null;
    const frame = fs.readFileSync(tmpImage);
    return toThumbJpeg(frame);
  } catch {
    return null;
  } finally {
    for (const file of [tmpVideo, tmpImage]) {
      try {
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch {
        // ignore cleanup errors
      }
    }
  }
}

async function generateFromLookup(mimeType, fileName) {
  if (!sharp || !fileName) return null;

  if (isAudio(mimeType, fileName)) {
    try {
      const art = await coverArt.lookupMusicCover(fileName);
      if (art) return toThumbJpeg(art);
    } catch {
      // fall through
    }
    return null;
  }

  if (isVideo(mimeType, fileName)) {
    try {
      const art = await coverArt.lookupVideoCover(fileName);
      if (art) return toThumbJpeg(art);
    } catch {
      // fall through
    }
  }

  if (isJar(mimeType, fileName)) {
    return typeThumbnails.renderJarThumbnail(sharp, THUMB_SIZE);
  }

  return null;
}

async function generate(buffer, mimeType, fileName = '') {
  if (!sharp) return null;

  if (!buffer?.length) {
    return generateFromLookup(mimeType, fileName);
  }

  if (mimeType?.startsWith('image/')) {
    try {
      return await sharp(buffer)
        .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 })
        .toBuffer();
    } catch {
      return null;
    }
  }

  if (isAudio(mimeType, fileName)) {
    const embedded = await fromEmbeddedAudioArt(buffer, mimeType);
    if (embedded) return embedded;

    try {
      const art = await coverArt.lookupMusicCover(fileName);
      if (art) return toThumbJpeg(art);
    } catch {
      // fall through
    }
    return null;
  }

  if (isVideo(mimeType, fileName)) {
    try {
      const art = await coverArt.lookupVideoCover(fileName);
      if (art) return toThumbJpeg(art);
    } catch {
      // fall through
    }
    return fromVideoFrame(buffer);
  }

  if (isJar(mimeType, fileName)) {
    return typeThumbnails.renderJarThumbnail(sharp, THUMB_SIZE);
  }

  return null;
}

function previewByteLimit(mimeType, fileName, fileSize) {
  const MB = 1024 * 1024;
  if (isVideo(mimeType, fileName)) return Math.min(fileSize, 20 * MB);
  if (isAudio(mimeType, fileName)) return Math.min(fileSize, 5 * MB);
  if (mimeType?.startsWith('image/')) return Math.min(fileSize, 10 * MB);
  return Math.min(fileSize, 5 * MB);
}

module.exports = {
  generate,
  generateFromLookup,
  toThumbJpeg,
  fromVideoFrame,
  previewByteLimit,
  isAudio,
  isVideo,
  isJar,
  supportsOnDemandThumbnail,
  THUMB_SIZE,
};
