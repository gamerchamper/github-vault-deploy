const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { ensureSetup } = require('../middleware/setup');
const accounts = require('../services/accounts');
const github = require('../services/github');

const router = express.Router();

router.use(requireAuth, ensureSetup);

router.get('/', (req, res) => {
  try {
    const linked = accounts.listLinkedAccounts(req.user.id);
    res.json({ accounts: linked });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/views', (req, res) => {
  try {
    const viewMode = require('../services/view-mode');
    const backupSync = require('../services/backup-sync');
    res.json({
      views: viewMode.listViews(req.user.id),
      backup_sync: backupSync.getSyncStatus(req.user.id),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/rate-limits', async (req, res) => {
  try {
    const rateLimit = require('../services/github-rate-limit');
    const limits = await accounts.getAccountRateLimits(req.user.id);
    res.json({
      accounts: limits,
      api_dashboard: rateLimit.getApiCallStats(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/backup-status', (req, res) => {
  try {
    const backupSync = require('../services/backup-sync');
    res.json({ backup_sync: backupSync.getSyncStatus(req.user.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/migrate-mysql', async (req, res) => {
  try {
    const { execFile } = require('child_process');
    const path = require('path');
    const scriptPath = path.join(__dirname, '../../scripts/migrate-to-mysql.js');

    const child = execFile(process.execPath, [scriptPath], {
      cwd: path.join(__dirname, '../..'),
      timeout: 5 * 60 * 1000,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);

    child.on('close', code => {
      if (code === 0) {
        res.json({ success: true, output: stdout.split('\n').filter(Boolean) });
      } else {
        res.status(500).json({ success: false, output: stdout.split('\n').filter(Boolean), error: stderr });
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/backup-sync', async (req, res) => {
  try {
    const backupSync = require('../services/backup-sync');
    const accountId = parseInt(req.body.account_id, 10);
    const force = !!req.body.force;
    if (Number.isFinite(accountId)) {
      if (force) {
        backupSync.forceBackupSync(req.user.id, accountId);
      } else {
        backupSync.runBackupSync(req.user.id, accountId, {
          fastResume: backupSync.shouldFastResume(req.user.id, accountId),
        });
      }
    } else if (force) {
      const accounts = require('../services/accounts');
      const linked = accounts.listLinkedAccounts(req.user.id)
        .filter((a) => a.role === 'backup' && a.is_active);
      for (const account of linked) {
        backupSync.forceBackupSync(req.user.id, account.id);
      }
    } else {
      backupSync.startAllBackupSyncs(req.user.id);
    }
    res.json({ success: true, backup_sync: backupSync.getSyncStatus(req.user.id) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/link-token', (req, res) => {
  try {
    const role = req.body.role === 'backup' ? 'backup' : 'storage';
    const link = accounts.createLinkToken(req.user.id, role, req);
    res.json({ success: true, ...link });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/redo-backup', async (req, res) => {
  try {
    const accountId = parseInt(req.params.id, 10);
    const result = await accounts.redoBackupSetup(req.user.id, accountId);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/:id', async (req, res) => {
  try {
    const { role, is_active: isActive } = req.body;
    const updated = accounts.updateAccount(req.user.id, parseInt(req.params.id, 10), {
      role,
      is_active: isActive,
    });
    if (role === 'backup') {
      await accounts.ensureBackupReposForAccount(req.user.id, updated.id);
      const backupSync = require('../services/backup-sync');
      backupSync.runBackupSync(req.user.id, updated.id);
    }
    res.json({ success: true, account: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post('/:id/trust', async (req, res) => {
  try {
    const account = require('../services/accounts').getLinkedAccount(req.user.id, req.params.id);
    if (!account) return res.status(404).json({ error: 'Linked account not found' });
    await require('../services/accounts').ensureCollaboratorsForAccount(req.user.id, req.params.id);
    res.json({ success: true, message: `@${account.username} added as collaborator to all storage repos` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    accounts.unlinkAccount(req.user.id, parseInt(req.params.id, 10));
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get('/:id/repos/available', async (req, res) => {
  try {
    const account = accounts.getLinkedAccount(req.user.id, parseInt(req.params.id, 10));
    if (!account) return res.status(404).json({ error: 'Linked account not found' });
    if (account.role !== 'storage') {
      return res.status(400).json({ error: 'Only storage accounts can add repositories' });
    }

    const octokit = github.createClient(account.access_token);
    const repos = await github.getUserRepos(octokit);
    const db = require('../db/database');
    const configured = db.prepare('SELECT full_name FROM storage_repos WHERE user_id = ?')
      .all(req.user.id).map((r) => r.full_name);

    res.json({
      account: {
        id: account.id,
        username: account.username,
        role: account.role,
      },
      repos: repos.filter((r) => !r.fork).map((r) => ({
        full_name: r.full_name,
        name: r.name,
        owner: r.owner.login,
        private: r.private,
        default_branch: r.default_branch,
        configured: configured.includes(r.full_name),
        linked_account_id: account.id,
        account_username: account.username,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
