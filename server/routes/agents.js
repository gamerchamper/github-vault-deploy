const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { ensureSetup } = require('../middleware/setup');
const syncAgents = require('../services/sync-agents');

const router = express.Router();

router.use(requireAuth, ensureSetup);

router.post('/register', (req, res) => {
  try {
    const agent = syncAgents.registerOrUpdate(req.user.id, req.user.apiKey?.id, req.body);
    res.json({ agent });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/heartbeat', (req, res) => {
  try {
    const result = syncAgents.heartbeat(req.user.id, req.user.apiKey?.id, req.body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/', (req, res) => {
  res.json({ agents: syncAgents.listAgents(req.user.id) });
});

router.put('/:id/config', (req, res) => {
  try {
    const agent = syncAgents.setDesiredConfig(req.user.id, req.params.id, req.body);
    res.json({ agent });
  } catch (err) {
    const code = err.message === 'Agent not found' ? 404 : 400;
    res.status(code).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  const ok = syncAgents.removeAgent(req.user.id, req.params.id);
  if (!ok) return res.status(404).json({ error: 'Agent not found' });
  res.json({ success: true });
});

module.exports = router;
