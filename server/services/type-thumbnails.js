const JAR_MIME = new Set([
  'application/java-archive',
  'application/x-java-archive',
  'application/jar',
  'application/x-jar',
]);

function isJar(mimeType, fileName) {
  if (mimeType && JAR_MIME.has(mimeType.toLowerCase())) return true;
  const ext = fileName?.split('.').pop()?.toLowerCase();
  return ext === 'jar';
}

function jarThumbnailSvg() {
  return `<svg width="200" height="200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Java archive">
  <defs>
    <linearGradient id="jar-bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#5382a1"/>
      <stop offset="55%" stop-color="#3d6b8f"/>
      <stop offset="100%" stop-color="#234567"/>
    </linearGradient>
    <linearGradient id="jar-cup" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff"/>
      <stop offset="100%" stop-color="#dbeafe"/>
    </linearGradient>
  </defs>
  <rect width="200" height="200" rx="18" fill="url(#jar-bg)"/>
  <rect x="18" y="18" width="164" height="164" rx="12" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="2"/>
  <path d="M68 88 L68 132 Q68 148 100 148 Q132 148 132 132 L132 88 Z" fill="url(#jar-cup)" stroke="#1e3a5f" stroke-width="2"/>
  <path d="M132 98 Q158 98 158 118 Q158 134 132 132" fill="none" stroke="#ffffff" stroke-width="8" stroke-linecap="round"/>
  <path d="M84 78 Q78 62 84 50" fill="none" stroke="#f89820" stroke-width="3.5" stroke-linecap="round"/>
  <path d="M100 74 Q94 56 100 44" fill="none" stroke="#f89820" stroke-width="3.5" stroke-linecap="round"/>
  <path d="M116 78 Q122 60 116 48" fill="none" stroke="#f89820" stroke-width="3.5" stroke-linecap="round"/>
  <text x="100" y="178" text-anchor="middle" font-family="Segoe UI, system-ui, sans-serif" font-size="24" font-weight="700" fill="#ffffff" letter-spacing="3">JAVA</text>
</svg>`;
}

async function renderJarThumbnail(sharp, size = 200) {
  if (!sharp) return null;
  try {
    return await sharp(Buffer.from(jarThumbnailSvg()))
      .resize(size, size)
      .jpeg({ quality: 88 })
      .toBuffer();
  } catch {
    return null;
  }
}

module.exports = {
  isJar,
  jarThumbnailSvg,
  renderJarThumbnail,
};
