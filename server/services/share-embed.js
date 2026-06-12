const appUrl = require('./app-url');
const storage = require('./storage');

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatSize(bytes) {
  if (!bytes || bytes < 1) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / (1024 ** i);
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function mediaKind(name, mimeType) {
  const ext = (name || '').split('.').pop().toLowerCase();
  if (mimeType?.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif'].includes(ext)) {
    return 'image';
  }
  if (mimeType?.startsWith('video/') || ['mp4', 'webm', 'mkv', 'avi', 'mov', 'm4v', 'ogv'].includes(ext)) {
    return 'video';
  }
  if (mimeType?.startsWith('audio/') || ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus'].includes(ext)) {
    return 'audio';
  }
  return 'file';
}

function fileQuery(fileId) {
  return fileId ? `?file=${encodeURIComponent(fileId)}` : '';
}

function isEmbedCrawler(req) {
  const ua = String(req.get('user-agent') || '').toLowerCase();
  return /discordbot|twitterbot|facebookexternalhit|slackbot|linkedinbot|telegrambot|whatsapp|embedly|pinterest|applebot/i.test(ua);
}

async function buildMeta({ req, token, shared, file, fileId, clientStream, hasThumbnail }) {
  const pagePath = `/share/${token}${fileId ? `?file=${encodeURIComponent(fileId)}` : ''}`;
  const pageUrl = appUrl.publicUrl(req, pagePath);
  const apiBase = `/api/public/share/${token}`;
  const qs = fileQuery(fileId);

  const isFolder = !!shared.is_folder && !fileId;
  const target = isFolder ? shared : file;
  const name = target?.name || 'Shared file';
  const size = target?.size || 0;
  const mimeType = target?.mime_type || '';
  const kind = isFolder ? 'folder' : mediaKind(name, mimeType);

  let title = isFolder ? `${name} — Shared folder` : name;
  let description = isFolder
    ? 'Shared folder on GitHub Vault'
    : `${formatSize(size)} · GitHub Vault share`;

  const tags = [
    `<meta property="og:site_name" content="GitHub Vault">`,
    `<meta property="og:url" content="${escapeHtml(pageUrl)}">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:description" content="${escapeHtml(description)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
    `<meta name="twitter:title" content="${escapeHtml(title)}">`,
    `<meta name="twitter:description" content="${escapeHtml(description)}">`,
    `<meta name="theme-color" content="#252526">`,
  ];

  const thumbUrl = hasThumbnail
    ? appUrl.publicUrl(req, `${apiBase}/thumbnail${qs}`)
    : null;

  if (isFolder) {
    tags.push('<meta property="og:type" content="website">');
    if (thumbUrl) {
      tags.push(`<meta property="og:image" content="${escapeHtml(thumbUrl)}">`);
      tags.push(`<meta name="twitter:image" content="${escapeHtml(thumbUrl)}">`);
    }
    return { title: escapeHtml(title), tagsHtml: tags.join('\n  ') };
  }

  if (kind === 'image') {
    tags.push('<meta property="og:type" content="website">');
    const imageUrl = thumbUrl || appUrl.publicUrl(req, `${apiBase}/stream${qs}`);
    tags.push(`<meta property="og:image" content="${escapeHtml(imageUrl)}">`);
    tags.push(`<meta name="twitter:image" content="${escapeHtml(imageUrl)}">`);
    description = `${formatSize(size)} · Image · GitHub Vault`;
    tags[3] = `<meta property="og:description" content="${escapeHtml(description)}">`;
    tags[5] = `<meta name="twitter:description" content="${escapeHtml(description)}">`;
    return { title: escapeHtml(title), tagsHtml: tags.join('\n  ') };
  }

  if (kind === 'video') {
    tags.push('<meta property="og:type" content="video.other">');
    const streamPath = clientStream
      ? `${apiBase}/embed/stream${qs}`
      : `${apiBase}/stream${qs}`;
    const streamUrl = appUrl.publicUrl(req, streamPath);
    const videoMime = mimeType && mimeType.startsWith('video/') ? mimeType : 'video/mp4';

    tags.push(`<meta property="og:video" content="${escapeHtml(streamUrl)}">`);
    tags.push(`<meta property="og:video:url" content="${escapeHtml(streamUrl)}">`);
    tags.push(`<meta property="og:video:secure_url" content="${escapeHtml(streamUrl)}">`);
    tags.push(`<meta property="og:video:type" content="${escapeHtml(videoMime)}">`);
    tags.push('<meta property="og:video:width" content="1280">');
    tags.push('<meta property="og:video:height" content="720">');
    tags.push(`<meta name="twitter:player" content="${escapeHtml(pageUrl)}">`);
    tags.push(`<meta name="twitter:player:stream" content="${escapeHtml(streamUrl)}">`);
    tags.push(`<meta name="twitter:player:stream:content_type" content="${escapeHtml(videoMime)}">`);

    if (thumbUrl) {
      tags.push(`<meta property="og:image" content="${escapeHtml(thumbUrl)}">`);
      tags.push(`<meta name="twitter:image" content="${escapeHtml(thumbUrl)}">`);
    }

    description = clientStream
      ? `${formatSize(size)} · Video · plays in browser`
      : `${formatSize(size)} · Video · GitHub Vault`;
    tags[3] = `<meta property="og:description" content="${escapeHtml(description)}">`;
    tags[5] = `<meta name="twitter:description" content="${escapeHtml(description)}">`;
    return { title: escapeHtml(title), tagsHtml: tags.join('\n  ') };
  }

  if (kind === 'audio') {
    tags.push('<meta property="og:type" content="music.song">');
    if (clientStream) {
      description = `${formatSize(size)} · Audio · plays in browser`;
    } else {
      const streamUrl = appUrl.publicUrl(req, `${apiBase}/stream${qs}`);
      tags.push(`<meta property="og:audio" content="${escapeHtml(streamUrl)}">`);
      tags.push(`<meta property="og:audio:secure_url" content="${escapeHtml(streamUrl)}">`);
      tags.push(`<meta property="og:audio:type" content="${escapeHtml(mimeType || 'audio/mpeg')}">`);
      description = `${formatSize(size)} · Audio · GitHub Vault`;
    }
    if (thumbUrl) {
      tags.push(`<meta property="og:image" content="${escapeHtml(thumbUrl)}">`);
      tags.push(`<meta name="twitter:image" content="${escapeHtml(thumbUrl)}">`);
    }
    tags[3] = `<meta property="og:description" content="${escapeHtml(description)}">`;
    tags[5] = `<meta name="twitter:description" content="${escapeHtml(description)}">`;
    return { title: escapeHtml(title), tagsHtml: tags.join('\n  ') };
  }

  tags.push('<meta property="og:type" content="website">');
  if (thumbUrl) {
    tags.push(`<meta property="og:image" content="${escapeHtml(thumbUrl)}">`);
    tags.push(`<meta name="twitter:image" content="${escapeHtml(thumbUrl)}">`);
  }
  description = `${formatSize(size)} · ${mimeType || 'File'} · Download on GitHub Vault`;
  tags[3] = `<meta property="og:description" content="${escapeHtml(description)}">`;
  tags[5] = `<meta name="twitter:description" content="${escapeHtml(description)}">`;
  return { title: escapeHtml(title), tagsHtml: tags.join('\n  ') };
}

async function resolveShareContext(token, fileId) {
  const shared = storage.getSharedByToken(token);
  if (!shared) return null;

  let file = shared;
  if (shared.is_folder && fileId) {
    file = storage.resolveSharedFile(token, fileId);
    if (!file) return null;
  }

  const clientStream = storage.getShareClientStreamEnabled(shared.user_id);
  const thumbTarget = shared.is_folder && fileId ? file : shared;
  const hasThumbnail = await storage.shareThumbnailAvailable(thumbTarget);

  return { shared, file, fileId, clientStream, hasThumbnail };
}

module.exports = {
  escapeHtml,
  formatSize,
  mediaKind,
  isEmbedCrawler,
  buildMeta,
  resolveShareContext,
};
