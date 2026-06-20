const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { ensureSetup } = require('../middleware/setup');
const userSettings = require('../services/user-settings');
const autoRepo = require('../services/auto-repo');
const siteAccess = require('../services/site-access');

const router = express.Router();

router.use(requireAuth, ensureSetup);

router.get('/', (req, res) => {
  res.json({ settings: userSettings.getSettings(req.user.id) });
});

router.patch('/', (req, res) => {
  try {
    const settings = userSettings.updateSettings(req.user.id, req.body || {});
    const task = autoRepo.syncFromSettings(req.user.id, settings);
    res.json({
      success: true,
      settings,
      autoRepoTaskId: task?.id || null,
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/site-access', (req, res) => {
  res.json({ site_access: siteAccess.getAdminStatus() });
});

router.put('/site-access', (req, res) => {
  try {
    const body = req.body || {};
    if (body.enabled === false || body.key === '' || body.key === null) {
      siteAccess.clearConfiguredKey();
      return res.json({ success: true, site_access: siteAccess.getAdminStatus() });
    }
    if (body.use_environment === true) {
      siteAccess.resetToEnvironment();
      return res.json({ success: true, site_access: siteAccess.getAdminStatus() });
    }
    if (body.key === undefined) {
      return res.status(400).json({ error: 'key is required' });
    }
    siteAccess.setConfiguredKey(body.key);
    res.json({ success: true, site_access: siteAccess.getAdminStatus() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
