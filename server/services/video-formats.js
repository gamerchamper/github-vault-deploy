const VIDEO_EXT = new Set(['mp4', 'webm', 'mkv', 'avi', 'mov', 'm4v', 'ogv', 'wmv']);

function isVideo(mimeType, fileName) {
  if (mimeType?.startsWith('video/')) return true;
  const ext = String(fileName || '').split('.').pop()?.toLowerCase();
  return VIDEO_EXT.has(ext);
}

function shouldConvertHls(convertHls, mimeType, fileName) {
  return !!convertHls && isVideo(mimeType, fileName);
}

module.exports = {
  VIDEO_EXT,
  isVideo,
  shouldConvertHls,
};
