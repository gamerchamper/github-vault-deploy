const crypto = require('crypto');
const db = require('../db/database');
const github = require('./github');
const storage = require('./storage');
const metadata = require('./metadata');
const vaultOrg = require('./vault-org');

async function ensureMasterKey(userId) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (user.master_key) return Buffer.from(user.master_key, 'base64');

  const masterKey = crypto.randomBytes(32);
  db.prepare('UPDATE users SET master_key = ? WHERE id = ?')
    .run(masterKey.toString('base64'), userId);

  return masterKey;
}

async function ensureMetadataRepo(userId) {
  const existing = metadata.getMetadataRepo(userId);
  if (existing) return existing;

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const octokit = github.createClient(user.access_token);

  let created;
  try {
    const info = await github.getRepoInfo(octokit, user.username, metadata.METADATA_REPO_NAME);
    created = info;
  } catch {
    const { data } = await octokit.repos.createForAuthenticatedUser({
      name: metadata.METADATA_REPO_NAME,
      description: 'GitHub Vault — encrypted metadata, thumbnails, and file manifests',
      private: true,
      auto_init: true,
    });
    created = data;
  }

  const result = db.prepare(`
    INSERT INTO storage_repos (user_id, owner, name, full_name, default_branch, is_metadata, is_active)
    VALUES (?, ?, ?, ?, ?, 1, 1)
  `).run(userId, created.owner.login, created.name, created.full_name, created.default_branch || 'main');

  const repo = db.prepare('SELECT * FROM storage_repos WHERE id = ?').get(result.lastInsertRowid);

  const masterKey = await ensureMasterKey(userId);
  await metadata.saveMasterKeyEnvelope(userId, masterKey);

  const index = {
    version: 1,
    description: 'GitHub Vault file index — manifests contain encryption keys for each file',
    files: {},
    created_at: new Date().toISOString(),
  };
  const octokit2 = github.createClient(user.access_token);
  const [owner, name] = repo.full_name.split('/');
  await github.uploadChunk(
    octokit2, owner, name, '.vault/metadata/index.json',
    Buffer.from(JSON.stringify(index, null, 2), 'utf8'),
    repo.default_branch
  );

  return repo;
}

async function ensureStorageRepo(userId) {
  const count = db.prepare(
    'SELECT COUNT(*) as c FROM storage_repos WHERE user_id = ? AND is_metadata = 0'
  ).get(userId);
  if (count.c > 0) return null;

  const org = vaultOrg.getVaultOrg(userId);
  if (org) {
    const result = await vaultOrg.setupVaultOrg(userId, org, { repoCount: 1 });
    return result.repos[0] || null;
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const octokit = github.createClient(user.access_token);
  const repoName = 'vault-storage-1';

  let created;
  try {
    created = await github.getRepoInfo(octokit, user.username, repoName);
  } catch {
    created = await github.createStorageRepo(octokit, repoName);
  }

  return storage.addRepo(userId, created.full_name, created.default_branch || 'main', {
    isPublic: !created.private,
  });
}

async function ensureUserSetup(userId) {
  await ensureMasterKey(userId);
  await ensureMetadataRepo(userId);
  await ensureStorageRepo(userId);
  return { ready: true };
}

module.exports = {
  ensureUserSetup,
  ensureMasterKey,
  ensureMetadataRepo,
  ensureStorageRepo,
};
