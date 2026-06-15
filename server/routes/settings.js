const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { ensureSetup } = require('../middleware/setup');
const userSettings = require('../services/user-settings');

const router = express.Router();

router.use(requireAuth, ensureSetup);

router.get('/', (req, res) => {
  res.json({ settings: userSettings.getSettings(req.user.id) });
});

router.patch('/', (req, res) => {
  try {
    const settings = userSettings.updateSettings(req.user.id, req.body || {});
    res.json({ success: true, settings });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
