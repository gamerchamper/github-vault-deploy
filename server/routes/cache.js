const express = require('express');
const diskCache = require('../services/disk-cache');

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

router.get('/stats', requireAuth, (req, res) => {
  res.json(diskCache.getStats(req.user.id));
});

router.delete('/', requireAuth, (req, res) => {
  try {
    require('../services/hls-stream').clearForUser(req.user.id);
    require('../services/chunk-session').clearForUser(req.user.id);
    res.json(diskCache.clearAll(req.user.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/config', requireAuth, (req, res) => {
  try {
    const { maxGb } = req.body;
    if (maxGb == null) return res.status(400).json({ error: 'maxGb is required' });
    const stats = diskCache.setMaxGb(maxGb);
    res.json(stats);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
