const express = require('express');
const router = express.Router();
const { getBandwidthSummary, getBandwidth } = require('../services/bandwidth');

router.get('/', (req, res) => {
  const summary = getBandwidthSummary(req.user.id);
  res.json(summary);
});

router.get('/live', (req, res) => {
  const now = Date.now();
  const period = parseInt(req.query.seconds || '60', 10);
  const since = Math.max(1, period) * 1000;
  const sinceDate = new Date(now - since).toISOString();
  const db = require('../db/database');
  const rows = db.prepare(
    'SELECT COALESCE(SUM(bytes), 0) as total FROM bandwidth_log WHERE user_id = ? AND recorded_at >= ?'
  ).get(req.user.id, sinceDate);
  res.json({ bytes: rows.total, period });
});

module.exports = router;