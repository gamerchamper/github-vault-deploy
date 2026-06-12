const fs = require('fs');
const path = require('path');
const express = require('express');
const shareEmbed = require('../services/share-embed');

const router = express.Router();
const TEMPLATE_PATH = path.join(__dirname, '../../public/share.html');
const PLAYLIST_TEMPLATE_PATH = path.join(__dirname, '../../public/playlist-share.html');
const COLLECTION_TEMPLATE_PATH = path.join(__dirname, '../../public/collection-share.html');
let templateCache = null;
let playlistTemplateCache = null;
let collectionTemplateCache = null;

function getTemplate() {
  if (!templateCache) {
    templateCache = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  }
  return templateCache;
}

async function renderSharePage(req, res, { embed = false } = {}) {
  const token = req.params.token;
  const fileId = req.query.file || null;
  const ctx = await shareEmbed.resolveShareContext(token, fileId);

  if (!ctx) {
    return res.status(404).send('Share not found');
  }

  const meta = await shareEmbed.buildMeta({
    req,
    token,
    shared: ctx.shared,
    file: ctx.file,
    fileId: ctx.fileId,
    clientStream: ctx.clientStream,
    hasThumbnail: ctx.hasThumbnail,
  });

  let html = getTemplate();
  html = html.replace('<!-- SHARE_EMBED_META -->', meta.tagsHtml);
  html = html.replace('<!-- SHARE_PAGE_TITLE -->', meta.title);

  if (embed) {
    html = html.replace('<body>', '<body class="share-embed-mode">');
    html = html.replace(
      '<!-- SHARE_EMBED_BOOT -->',
      '<script>window.SHARE_EMBED_MODE = true;</script>'
    );
  } else {
    html = html.replace('<!-- SHARE_EMBED_BOOT -->', '');
  }

  res.setHeader('Cache-Control', 'private, no-cache');
  res.type('html').send(html);
}

function getPlaylistTemplate() {
  if (!playlistTemplateCache) {
    playlistTemplateCache = fs.readFileSync(PLAYLIST_TEMPLATE_PATH, 'utf8');
  }
  return playlistTemplateCache;
}

function getCollectionTemplate() {
  if (!collectionTemplateCache) {
    collectionTemplateCache = fs.readFileSync(COLLECTION_TEMPLATE_PATH, 'utf8');
  }
  return collectionTemplateCache;
}

router.get('/p/:token', (req, res) => {
  let html = getTemplate();
  html = html.replace('<!-- SHARE_PAGE_TITLE -->', 'Playlist');
  html = html.replace('<!-- SHARE_EMBED_META -->', '');
  html = html.replace(
    '<!-- SHARE_EMBED_BOOT -->',
    '<script>window.SHARE_PLAYLIST_MODE = true;</script>'
  );
  res.setHeader('Cache-Control', 'private, no-cache');
  res.type('html').send(html);
});

router.get('/c/:token', (req, res) => {
  const html = getCollectionTemplate().replace('<!-- PAGE_TITLE -->', 'Collection');
  res.setHeader('Cache-Control', 'private, no-cache');
  res.type('html').send(html);
});

router.get('/:token/embed', (req, res) => {
  renderSharePage(req, res, { embed: true }).catch((err) => {
    if (!res.headersSent) res.status(500).send(err.message);
  });
});

router.get('/:token', async (req, res) => {
  const accept = req.headers.accept || '';
  const fileId = req.query.file || null;
  const wantsHtml = accept.includes('text/html') || accept.includes('application/xhtml');
  if (!wantsHtml || req.query.download === '1' || req.query.raw === '1') {
    const token = req.params.token;
    const ctx = await shareEmbed.resolveShareContext(token, fileId).catch(() => null);
    if (ctx) {
      const targetId = ctx.shared.is_folder ? fileId : ctx.file?.id;
      if (targetId) {
        return res.redirect(`/api/public/share/${token}/download?file=${targetId}`);
      }
    }
  }
  const embed = req.query.embed === '1' || req.query.embed === 'true';
  renderSharePage(req, res, { embed }).catch((err) => {
    if (!res.headersSent) res.status(500).send(err.message);
  });
});

module.exports = router;
