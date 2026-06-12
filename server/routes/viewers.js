const express = require('express');
const db = require('../db/database');
const sharePresence = require('../services/share-presence');
const appUrl = require('../services/app-url');
const { requireAuth } = require('../middleware/auth');
const { ensureSetup } = require('../middleware/setup');

const router = express.Router();

router.use(requireAuth, ensureSetup);

function getUserShares(userId, req) {
  return db.prepare(`
    SELECT id, name, share_token, is_folder
    FROM files
    WHERE user_id = ? AND share_token IS NOT NULL
  `).all(userId).map((row) => ({
    ...row,
    share_url: appUrl.publicUrl(req, `/share/${row.share_token}`),
  }));
}

router.get('/live', (req, res) => {
  try {
    const shares = getUserShares(req.user.id, req);
    res.json(sharePresence.listLiveForUser(req.user.id, shares));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/live/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  sharePresence.subscribeOwner(req.user.id, res);

  const sendSnapshot = () => {
    try {
      const shares = getUserShares(req.user.id, req);
      const payload = JSON.stringify(sharePresence.listLiveForUser(req.user.id, shares));
      res.write(`data: ${payload}\n\n`);
    } catch {
      /* ignore write errors */
    }
  };

  sendSnapshot();

  const ping = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(ping);
    }
  }, 25000);

  const snapshot = setInterval(sendSnapshot, 3000);

  req.on('close', () => {
    clearInterval(ping);
    clearInterval(snapshot);
    sharePresence.unsubscribeOwner(req.user.id, res);
  });
});

module.exports = router;
