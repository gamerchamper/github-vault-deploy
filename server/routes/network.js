const router = require('express').Router();
const { requireAuth } = require('../middleware/auth');
const { ensureSetup } = require('../middleware/setup');
const localNetwork = require('../services/local-network');

router.use(requireAuth, ensureSetup);

router.get('/local-upload', (req, res) => {
  try {
    res.json(localNetwork.getLocalUploadStatus(req));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
