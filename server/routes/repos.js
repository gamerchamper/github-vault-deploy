const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { ensureSetup } = require('../middleware/setup');
const storage = require('../services/storage');
const github = require('../services/github');
const storageProvider = require('../services/storage-provider');
const capacity = require('../services/capacity');
const vaultOrg = require('../services/vault-org');
const accounts = require('../services/accounts');
const repoBatch = require('../services/repo-batch');
const db = require('../db/database');

const router = express.Router();
const REPO_CAPACITY_GB = repoBatch.REPO_CAPACITY_GB;

router.use(requireAuth, ensureSetup);

router.get('/available', async (req, res) => {
  try {
    const configured = db.prepare('SELECT full_name FROM storage_repos WHERE user_id = ?')
      .all(req.user.id).map((r) => r.full_name);

    const available = [];
    for (const account of accounts.listAccountsWithTokens(req.user.id)) {
      if (!account.is_primary && account.role !== 'storage') continue;

      const provider = storageProvider.normalizeProvider(account.provider || 'github');
      const mod = storageProvider.getModule(provider);
      if (typeof mod?.createClient !== 'function' || typeof mod?.getUserRepos !== 'function') {
        console.warn('repos_available_skip_account', {
          userId: req.user.id,
          accountId: account.id,
          provider,
          reason: 'storage module not loaded',
        });
        continue;
      }

      try {
        const client = mod.createClient(account.access_token);
        const repos = await mod.getUserRepos(client, {
          accountId: account.is_primary ? null : account.id,
        });

        for (const repo of repos.filter((r) => !r.fork)) {
          available.push({
            full_name: repo.full_name,
            name: repo.name,
            owner: repo.owner.login,
            private: repo.private,
            default_branch: repo.default_branch,
            configured: configured.includes(repo.full_name),
            linked_account_id: account.is_primary ? null : account.id,
            account_username: account.username,
            is_primary_account: !!account.is_primary,
            provider,
          });
        }
      } catch (err) {
        console.warn('repos_available_account_failed', {
          userId: req.user.id,
          accountId: account.id,
          username: account.username,
          provider,
          error: err.message,
        });
      }
    }

    res.json({ repos: available });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/configured', async (req, res) => {
  try {
    const stats = await storage.getStorageStats(req.user.id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const withCapacity = await capacity.getReposCapacityForUser(req.user.id, stats.repos);

    const linked = accounts.listLinkedAccounts(req.user.id);
    const accountMap = Object.fromEntries(linked.map((a) => [a.id, a]));

    res.json({
      repos: withCapacity.map(({ repo, capacity: cap }) => ({
        ...repo,
        ...cap,
        is_metadata: !!repo.is_metadata,
        is_backup: repo.repo_role === 'backup',
        is_public: !!repo.is_public,
        private: repo.private != null ? !!repo.private : !repo.is_public,
        account_username: repo.linked_account_id
          ? accountMap[repo.linked_account_id]?.username
          : user.username,
        provider: repo.provider || 'github',
      })),
      total: capacity.aggregateCapacity(withCapacity),
      repo_capacity_bytes: capacity.REPO_CAPACITY_BYTES,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/capacity', async (req, res) => {
  try {
    const stats = await storage.getStorageStats(req.user.id);
    const withCapacity = await capacity.getReposCapacity(null, stats.repos);

    res.json({
      repos: withCapacity.map(({ repo, capacity: cap }) => ({
        id: repo.id,
        full_name: repo.full_name,
        name: repo.name,
        is_active: !!repo.is_active,
        is_metadata: !!repo.is_metadata,
        ...cap,
      })),
      total: capacity.aggregateCapacity(withCapacity),
      repo_capacity_bytes: capacity.REPO_CAPACITY_BYTES,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/add', async (req, res) => {
  try {
    const { full_name, linked_account_id: linkedAccountId } = req.body;
    if (!full_name) return res.status(400).json({ error: 'full_name required' });

    let token;
    let provider = 'github';
    if (linkedAccountId) {
      const account = accounts.getLinkedAccount(req.user.id, linkedAccountId);
      if (!account) return res.status(404).json({ error: 'Linked account not found' });
      if (account.role !== 'storage') {
        return res.status(400).json({ error: 'Only storage-linked accounts can add repositories' });
      }
      token = account.access_token;
      provider = account.provider || 'github';
    } else {
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
      token = user.access_token;
    }

    const mod = storageProvider.getModule(provider);
    const client = mod.createClient(token);
    const [owner, name] = full_name.split('/');
    const info = await mod.getRepoInfo(client, owner, name);

    const repo = storage.addRepo(req.user.id, full_name, info.default_branch, {
      linkedAccountId: linkedAccountId || null,
      isPublic: !info.private,
      provider,
    });
    res.json({ success: true, repo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/org', (req, res) => {
  try {
    const org = vaultOrg.getVaultOrg(req.user.id);
    const configured = org ? vaultOrg.listConfiguredOrgRepos(req.user.id, org) : [];
    res.json({ org, configured });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/orgs', async (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
    const octokit = github.createClient(user.access_token);
    const scopes = await github.getTokenScopes(octokit);
    const needsReauth = !scopes.includes('read:org');

    const vault = vaultOrg.getVaultOrg(req.user.id);
    let orgs = [];

    if (!needsReauth) {
      const listed = await github.listUserOrgs(octokit);
      orgs = await Promise.all(listed.map(async (org) => ({
        login: org.login,
        name: org.name || org.login,
        avatar_url: org.avatar_url,
        role: await github.getOrgRole(octokit, org.login),
        is_vault_org: vault === org.login,
        source: 'github',
      })));
    }

    const knownOwners = db.prepare(`
      SELECT DISTINCT owner FROM storage_repos
      WHERE user_id = ? AND owner != ? AND is_metadata = 0
    `).all(req.user.id, user.username).map((r) => r.owner);

    for (const owner of knownOwners) {
      if (orgs.some((o) => o.login === owner)) continue;
      let role = null;
      if (!needsReauth) role = await github.getOrgRole(octokit, owner);
      orgs.push({
        login: owner,
        name: owner,
        role: role || 'unknown',
        is_vault_org: vault === owner,
        source: 'configured',
      });
    }

    res.json({
      orgs,
      vault_org: vault,
      needs_reauth: needsReauth,
      scopes,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/org/setup', async (req, res) => {
  try {
    const { org, repoCount } = req.body;
    if (!org) return res.status(400).json({ error: 'org required' });

    const result = await vaultOrg.setupVaultOrg(req.user.id, org, { repoCount });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/org', (req, res) => {
  try {
    vaultOrg.setVaultOrg(req.user.id, null);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/make-public', async (req, res) => {
  try {
    const repos = db.prepare(`
      SELECT * FROM storage_repos
      WHERE user_id = ? AND is_metadata = 0 AND is_active = 1
        AND (repo_role IS NULL OR repo_role = 'primary')
    `).all(req.user.id);

    if (!repos.length) {
      return res.json({ success: true, results: [], made_public: 0, total: 0 });
    }

    const results = [];
    for (const repo of repos) {
      const [owner, name] = repo.full_name.split('/');
      try {
        const octokit = accounts.createClientForRepo(req.user.id, repo);
        const info = await github.setRepoPublic(octokit, owner, name);
        db.prepare('UPDATE storage_repos SET is_public = ? WHERE id = ?').run(info.private ? 0 : 1, repo.id);
        results.push({
          full_name: repo.full_name,
          ok: true,
          private: !!info.private,
        });
      } catch (err) {
        results.push({
          full_name: repo.full_name,
          ok: false,
          error: err.response?.data?.message || err.message,
        });
      }
    }

    res.json({
      success: results.every((r) => r.ok),
      results,
      made_public: results.filter((r) => r.ok && !r.private).length,
      total: results.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/create', async (req, res) => {
  try {
    const repo = await repoBatch.createStorageRepo(req.user.id, {
      linkedAccountId: req.body.linked_account_id || null,
    });
    res.json({ success: true, repo });
  } catch (err) {
    const status = /not found/i.test(err.message) ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

router.post('/create-batch', async (req, res) => {
  try {
    const linkedAccountId = req.body.linked_account_id
      ? parseInt(req.body.linked_account_id, 10)
      : null;
    const result = repoBatch.startBatchCreate(req.user.id, {
      gb: req.body.gb,
      count: req.body.count,
      linkedAccountId: Number.isFinite(linkedAccountId) ? linkedAccountId : null,
      source: 'manual',
    });
    res.json({
      success: true,
      taskId: result.taskId,
      requested: result.requested,
      repo_capacity_gb: result.repo_capacity_gb,
      capacity_gb_requested: result.capacity_gb_requested,
    });
  } catch (err) {
    const status = /already running/i.test(err.message) ? 409 : 400;
    res.status(status).json({ error: err.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    storage.removeRepo(req.user.id, parseInt(req.params.id, 10));
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.patch('/:id/toggle', (req, res) => {
  try {
    storage.toggleRepo(req.user.id, parseInt(req.params.id, 10), req.body.active);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
