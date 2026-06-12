const db = require('../db/database');
const github = require('./github');
const storage = require('./storage');

const DEFAULT_REPO_COUNT = 3;
const REPO_PREFIX = 'vault-storage';

function getVaultOrg(userId) {
  const row = db.prepare('SELECT vault_org FROM users WHERE id = ?').get(userId);
  return row?.vault_org || null;
}

function setVaultOrg(userId, orgLogin) {
  db.prepare('UPDATE users SET vault_org = ? WHERE id = ?').run(orgLogin || null, userId);
  return orgLogin || null;
}

function listConfiguredOrgRepos(userId, orgLogin) {
  return db.prepare(
    'SELECT * FROM storage_repos WHERE user_id = ? AND owner = ? AND is_metadata = 0 ORDER BY name ASC'
  ).all(userId, orgLogin);
}

async function assertOrgAdmin(octokit, orgLogin) {
  const org = await github.getOrg(octokit, orgLogin);
  if (!org) {
    throw new Error(`Organization "${orgLogin}" was not found. Create it on GitHub first, then try again.`);
  }

  const role = await github.getOrgRole(octokit, orgLogin);
  if (role !== 'admin') {
    throw new Error(`You need owner/admin access to "${orgLogin}" to set up vault storage there.`);
  }

  return org;
}

async function ensureOrgStorageRepo(octokit, userId, orgLogin, repoName) {
  const fullName = `${orgLogin}/${repoName}`;

  const existing = db.prepare(
    'SELECT * FROM storage_repos WHERE user_id = ? AND full_name = ?'
  ).get(userId, fullName);
  if (existing) return existing;

  let info;
  try {
    info = await github.getRepoInfo(octokit, orgLogin, repoName);
  } catch {
    info = await github.createStorageRepo(octokit, repoName, orgLogin);
  }

  return storage.addRepo(userId, info.full_name, info.default_branch || 'main', {
    isPublic: !info.private,
  });
}

async function setupVaultOrg(userId, orgLogin, options = {}) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('User not found');

  const org = String(orgLogin || '').trim().toLowerCase();
  if (!org || !/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/.test(org)) {
    throw new Error('Invalid organization name');
  }

  const octokit = github.createClient(user.access_token);
  await assertOrgAdmin(octokit, org);

  const repoCount = Math.min(20, Math.max(1, parseInt(options.repoCount, 10) || DEFAULT_REPO_COUNT));
  const created = [];

  for (let i = 1; i <= repoCount; i++) {
    const repo = await ensureOrgStorageRepo(octokit, userId, org, `${REPO_PREFIX}-${i}`);
    created.push(repo);
  }

  setVaultOrg(userId, org);

  return {
    org,
    repos: created,
    configured: listConfiguredOrgRepos(userId, org),
  };
}

module.exports = {
  getVaultOrg,
  setVaultOrg,
  listConfiguredOrgRepos,
  setupVaultOrg,
  assertOrgAdmin,
  DEFAULT_REPO_COUNT,
};
