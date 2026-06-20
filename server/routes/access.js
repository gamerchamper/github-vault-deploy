const express = require('express');
const siteAccess = require('../services/site-access');

const router = express.Router();

router.get('/status', (req, res) => {
  res.setHeader('Cache-Control', 'private, no-cache, must-revalidate');
  res.json(siteAccess.status(req));
});

router.post('/verify', (req, res) => {
  if (!siteAccess.isRequired()) {
    return res.json({ ok: true, required: false });
  }
  const key = req.body?.key;
  if (!siteAccess.keysMatch(key)) {
    return res.status(403).json({ error: 'Invalid access key' });
  }
  siteAccess.grantSession(req);
  res.json({ ok: true, required: true });
});

module.exports = router;
