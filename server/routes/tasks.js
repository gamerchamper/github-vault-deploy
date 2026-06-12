const express = require('express');
const tasks = require('../services/tasks');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.get('/', requireAuth, (req, res) => {
  const activeOnly = req.query.active !== '0';
  const includeResumable = req.query.resumable === '1';
  res.json({ tasks: tasks.list(req.user.id, { activeOnly, includeResumable }) });
});

router.delete('/failed', requireAuth, (req, res) => {
  const removed = tasks.removeFailed(req.user.id);
  res.json({ success: true, removed });
});

router.delete('/:id', requireAuth, (req, res) => {
  const ok = tasks.remove(req.params.id, req.user.id);
  if (!ok) return res.status(404).json({ error: 'Task not found' });
  res.json({ success: true });
});

router.get('/:id', requireAuth, (req, res) => {
  const task = tasks.get(req.params.id, req.user.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(task);
});

router.post('/:id/pause', requireAuth, (req, res) => {
  try {
    const task = tasks.pause(req.params.id, req.user.id, req.body.reason);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/resume', requireAuth, (req, res) => {
  try {
    const task = tasks.resumeTask(req.params.id, req.user.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/cancel', requireAuth, async (req, res) => {
  try {
    const task = await tasks.cancelTask(req.params.id, req.user.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    res.json(task);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

module.exports = router;
