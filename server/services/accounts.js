const crypto = require('crypto');
const db = require('../db/database');
const github = require('./github');
const appUrl = require('./app-url');

const VALID_ROLES = new Set(['storage', 'backup']);
const LINK_TOKEN_TTL_MS = 30 * 60 * 1000;

function getUser(userId) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

function listLinkedAccounts(userId) {
  return db.prepare(`
    SELECT id, github_id, username, avatar_url, role, is_active, created_at
    FROM linked_accounts WHERE user_id = ? ORDER BY created_at ASC
  `).all(userId);
}

function getLinkedAccount(userId, accountId) {
  return db.prepare('SELECT * FROM linked_accounts WHERE id = ? AND user_id = ?').get(accountId, userId);
}

function createLinkToken(userId, role, req = null) {
  if (!VALID_ROLES.has(role)) throw new Error('Invalid account role');

  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + LINK_TOKEN_TTL_MS).toISOString();
  db.prepare(`
    INSERT INTO link_tokens (token, user_id, role, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(token, userId, role, expiresAt);

  return {
    token,
    role,
    expires_at: expiresAt,
    expires_in_minutes: LINK_TOKEN_TTL_MS / 60000,
    url: appUrl.publicUrl(req, `/auth/github/link?token=${token}`),
  };
}

function peekLinkToken(token) {
  if (!token || typeof token !== 'string') {
    throw new Error('Missing link token');
  }

  const row = db.prepare(`
    SELECT * FROM link_tokens WHERE token = ? AND used_at IS NULL
  `).get(token);
  if (!row) throw new Error('Invalid or already used link — generate a new one from Storage Repositories');

  if (new Date(row.expires_at) < new Date()) {
    throw new Error('Link expired — open Storage Repositories and copy a fresh link');
  }

  return row;
}

function consumeLinkToken(token) {
  const row = peekLinkToken(token);
  db.prepare('UPDATE link_tokens SET used_at = CURRENT_TIMESTAMP WHERE token = ?').run(token);
  return row;
}

function listAccountsWithTokens(userId) {
  const user = getUser(userId);
  if (!user) return [];

  const primary = {
    id: null,
    user_id: userId,
    github_id: user.github_id,
    username: user.username,
    avatar_url: user.avatar_url,
    access_token: user.access_token,
    role: 'primary',
    is_active: 1,
    is_primary: true,
  };

  const linked = db.prepare(`
    SELECT * FROM linked_accounts WHERE user_id = ? AND is_active = 1 ORDER BY created_at ASC
  `).all(userId).map((a) => ({ ...a, is_primary: false }));

  return [primary, ...linked];
}

function getTokenForRepo(userId, repo) {
  if (!repo?.linked_account_id) {
    const user = getUser(userId);
    if (!user) throw new Error('User not found');
    return user.access_token;
  }
  const account = getLinkedAccount(userId, repo.linked_account_id);
  if (!account?.is_active) throw new Error('Linked account is inactive');
  return account.access_token;
}

function listActiveTokens(userId) {
  const user = getUser(userId);
  if (!user) return [];
  const tokens = [{ token: user.access_token, label: 'primary', userId }];
  const linked = db.prepare(`
    SELECT access_token, role, username FROM linked_accounts
    WHERE user_id = ? AND is_active = 1
  `).all(userId);
  for (const acct of linked) {
    tokens.push({ token: acct.access_token, label: acct.username || acct.role, userId });
  }
  return tokens;
}

function pickBestToken(tokens, { minRemaining = 0 } = {}) {
  const rateLimit = require('./github-rate-limit');
  let best = null;
  let bestRemaining = -1;
  for (const t of tokens) {
    const key = rateLimit.keyForToken(t.token);
    if (rateLimit.isPaused(key)) continue;
    const quota = rateLimit.getQuotaStatus(key);
    if (quota?.exhausted) continue;
    const remaining = quota?.remaining ?? 5000;
    if (remaining < minRemaining) continue;
    if (remaining > bestRemaining) {
      bestRemaining = remaining;
      best = t;
    }
    if (remaining > 800) break;
  }
  return best || tokens[0];
}

function createClientForRepo(userId, repo) {
  const repoToken = getTokenForRepo(userId, repo);
  if (repo?.linked_account_id) {
    return github.createClient(repoToken);
  }
  const tokens = listActiveTokens(userId).map((t) => ({
    token: t.token,
    label: t.label,
    isRepo: t.token === repoToken,
  }));
  const rateLimit = require('./github-rate-limit');
  const repoKey = rateLimit.keyForToken(repoToken);
  const repoQuota = rateLimit.getQuotaStatus(repoKey);
  const repoRemaining = repoQuota?.remaining ?? 5000;
  const repoBlocked = repoQuota?.paused || repoQuota?.exhausted || repoRemaining <= 0;

  if (!repoBlocked && repoRemaining > 200) {
    return github.createClient(repoToken);
  }

  const best = pickBestToken(tokens, { minRemaining: 50 });
  if (best?.token && best.token !== repoToken) {
    return github.createClient(best.token);
  }
  return github.createClient(repoToken);
}

function createClientForUpload(userId, repo) {
  const repoToken = getTokenForRepo(userId, repo);
  // Always use the token that owns this repo. Cross-account fallback returns 404
  // for linked storage repos; rate limits are handled by github.createClient hooks.
  return github.createClient(repoToken);
}

function getBackupReposForPrimary(userId, primaryRepoId, linkedAccountId = null) {
  let sql = `
    SELECT r.* FROM storage_repos r
    JOIN linked_accounts la ON r.linked_account_id = la.id
    WHERE r.user_id = ? AND r.repo_role = 'backup' AND r.mirrors_repo_id = ?
      AND r.is_active = 1 AND la.is_active = 1 AND la.role = 'backup'
  `;
  const params = [userId, primaryRepoId];
  if (linkedAccountId) {
    sql += ' AND r.linked_account_id = ?';
    params.push(linkedAccountId);
  }
  return db.prepare(sql).all(...params);
}

function registerBackupRepo(userId, linkedAccountId, primaryRepoId, info) {
  const [owner, name] = info.full_name.split('/');
  const branch = info.default_branch || 'main';

  const existing = db.prepare(
    'SELECT * FROM storage_repos WHERE user_id = ? AND full_name = ?'
  ).get(userId, info.full_name);

  if (existing) {
    db.prepare(`
      UPDATE storage_repos
      SET owner = ?, name = ?, default_branch = ?, linked_account_id = ?,
          repo_role = 'backup', mirrors_repo_id = ?, is_active = 1
      WHERE id = ?
    `).run(owner, name, branch, linkedAccountId, primaryRepoId, existing.id);
    return db.prepare('SELECT * FROM storage_repos WHERE id = ?').get(existing.id);
  }

  const result = db.prepare(`
    INSERT INTO storage_repos (
      user_id, owner, name, full_name, default_branch, is_metadata,
      linked_account_id, repo_role, mirrors_repo_id
    ) VALUES (?, ?, ?, ?, ?, 0, ?, 'backup', ?)
  `).run(userId, owner, name, info.full_name, branch, linkedAccountId, primaryRepoId);
  return db.prepare('SELECT * FROM storage_repos WHERE id = ?').get(result.lastInsertRowid);
}

async function ensureBackupMirrorRepo(userId, linkedAccountId, primaryRepo) {
  const account = getLinkedAccount(userId, linkedAccountId);
  if (!account) throw new Error('Linked account not found');

  const existing = db.prepare(`
    SELECT * FROM storage_repos
    WHERE user_id = ? AND linked_account_id = ? AND repo_role = 'backup' AND mirrors_repo_id = ?
  `).get(userId, linkedAccountId, primaryRepo.id);
  if (existing) return existing;

  const [primaryOwner, primaryName] = primaryRepo.full_name.split('/');
  const backupOctokit = github.createClient(account.access_token);

  let info;
  let usedFork = false;
  try {
    const existingFork = await github.findFork(
      backupOctokit, primaryOwner, primaryName, account.username
    );
    if (existingFork) {
      info = existingFork;
      usedFork = true;
    } else {
      info = await github.forkRepo(backupOctokit, primaryOwner, primaryName, account.username);
      usedFork = true;
    }
  } catch (err) {
    const msg = err.response?.data?.message || err.message || '';
    const needsAccess = /not fork|cannot fork|access|permission|private/i.test(msg);
    if (needsAccess) {
      throw new Error(
        `Cannot fork ${primaryRepo.full_name}: make it public or add @${account.username} as a collaborator`
      );
    }
    try {
      info = await github.getRepoInfo(backupOctokit, account.username, primaryName);
      usedFork = true;
    } catch {
      const safeName = primaryRepo.name.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 40);
      const repoName = `vault-backup-${safeName}`.slice(0, 100);
      try {
        info = await github.getRepoInfo(backupOctokit, account.username, repoName);
      } catch (getErr) {
        try {
          info = await github.createStorageRepo(backupOctokit, repoName);
        } catch (createErr) {
          const createMsg = createErr.response?.data?.message || createErr.message || '';
          if (/already exists/i.test(createMsg)) {
            info = await github.getRepoInfo(backupOctokit, account.username, repoName);
          } else {
            throw createErr;
          }
        }
      }
    }
  }

  const backupRepo = registerBackupRepo(userId, linkedAccountId, primaryRepo.id, info);
  if (usedFork) {
    try {
      await reconcileChunkBackupsForRepo(userId, primaryRepo.id, backupRepo.id);
    } catch {
      // reconcile after fork may run before GitHub finishes copying
    }
  }
  return backupRepo;
}

const RECONCILE_CONCURRENCY = 2;
const RECONCILE_BATCH_SIZE = 50;

async function reconcileChunkBackupsForRepo(userId, primaryRepoId, backupRepoId, onProgress = null) {
  const workloadGovernor = require('./workload-governor');
  if (workloadGovernor.shouldDeferBackground(userId)) return 0;

  const backupRepo = db.prepare('SELECT * FROM storage_repos WHERE id = ?').get(backupRepoId);
  if (!backupRepo) return 0;

  const [owner, name] = backupRepo.full_name.split('/');
  const octokit = createClientForRepo(userId, backupRepo);
  const { mapConcurrent } = require('./chunk-session');
  let totalReconciled = 0;
  const maxRounds = 6;

  for (let round = 0; round < maxRounds; round++) {
    const chunks = db.prepare(`
      SELECT c.* FROM chunks c
      JOIN files f ON f.id = c.file_id
      WHERE c.repo_id = ?
        AND (f.upload_status IS NULL OR f.upload_status = 'ready')
        AND NOT EXISTS (
          SELECT 1 FROM chunk_backups cb
          WHERE cb.chunk_id = c.id AND cb.repo_id = ?
        )
      LIMIT ?
    `).all(primaryRepoId, backupRepoId, RECONCILE_BATCH_SIZE);
    if (!chunks.length) break;

    let reconciled = 0;
    await mapConcurrent(chunks, RECONCILE_CONCURRENCY, async (chunk) => {
      if (workloadGovernor.shouldDeferBackground(userId)) return;
      const sha = await github.getFileSha(octokit, owner, name, chunk.repo_path, backupRepo.default_branch, { subsystem: 'reconcile' });
      if (!sha) return;

      const existing = db.prepare(
        'SELECT id FROM chunk_backups WHERE chunk_id = ? AND repo_id = ?'
      ).get(chunk.id, backupRepoId);

      if (existing) {
        db.prepare('UPDATE chunk_backups SET sha = ? WHERE id = ?').run(sha, existing.id);
      } else {
        db.prepare('INSERT INTO chunk_backups (chunk_id, repo_id, sha) VALUES (?, ?, ?)')
          .run(chunk.id, backupRepoId, sha);
        db.prepare(
          'UPDATE storage_repos SET chunk_count = chunk_count + 1, total_bytes = total_bytes + ? WHERE id = ?'
        ).run(chunk.size, backupRepoId);
      }
      reconciled += 1;
      if (onProgress) onProgress(totalReconciled + reconciled, chunks.length);
    });

    totalReconciled += reconciled;
    if (reconciled === 0) break;
  }

  return totalReconciled;
}

async function reconcileAllBackupRepos(userId, linkedAccountId, onProgress = null) {
  const pairs = db.prepare(`
    SELECT br.id as backup_id, br.mirrors_repo_id
    FROM storage_repos br
    WHERE br.user_id = ? AND br.linked_account_id = ? AND br.repo_role = 'backup'
  `).all(userId, linkedAccountId);

  let totalReconciled = 0;
  for (const pair of pairs) {
    totalReconciled += await reconcileChunkBackupsForRepo(
      userId, pair.mirrors_repo_id, pair.backup_id, onProgress
    );
  }
  return totalReconciled;
}

async function syncForkBackups(userId, linkedAccountId, onProgress = null) {
  const account = getLinkedAccount(userId, linkedAccountId);
  if (!account) return;

  const pairs = db.prepare(`
    SELECT br.id as backup_id, br.full_name, br.default_branch, br.mirrors_repo_id,
           pr.full_name as upstream_full_name
    FROM storage_repos br
    JOIN storage_repos pr ON br.mirrors_repo_id = pr.id
    WHERE br.user_id = ? AND br.linked_account_id = ? AND br.repo_role = 'backup'
  `).all(userId, linkedAccountId);

  const octokit = github.createClient(account.access_token);

  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    const [owner, name] = pair.full_name.split('/');

    if (onProgress) {
      onProgress({
        phase: 'fork-sync',
        percent: 5 + Math.round(((i + 1) / pairs.length) * 15),
        currentRepo: pair.full_name,
      });
    }

    try {
      await github.mergeUpstream(octokit, owner, name, pair.default_branch || 'main');
    } catch (err) {
      const msg = err.response?.data?.message || err.message || '';
      if (!/up.to.date|already|nothing to merge|behind/i.test(msg)) {
        console.warn(`Fork sync ${pair.full_name}:`, msg);
      }
    }
    await reconcileChunkBackupsForRepo(userId, pair.mirrors_repo_id, pair.backup_id);
  }
}

async function ensureBackupReposForAccount(userId, linkedAccountId) {
  const { getPrimaryStorageRepos } = require('./view-mode');
  const primaryRepos = getPrimaryStorageRepos(userId);
  const created = [];
  for (const primaryRepo of primaryRepos) {
    try {
      created.push(await ensureBackupMirrorRepo(userId, linkedAccountId, primaryRepo));
    } catch (err) {
      const existing = db.prepare(`
        SELECT * FROM storage_repos
        WHERE user_id = ? AND linked_account_id = ? AND repo_role = 'backup' AND mirrors_repo_id = ?
      `).get(userId, linkedAccountId, primaryRepo.id);
      if (existing) {
        created.push(existing);
        continue;
      }
      console.warn(`Backup repo for ${primaryRepo.full_name}:`, err.message);
    }
  }
  return created;
}

async function ensureBackupReposForAllAccounts(userId) {
  const backupAccounts = db.prepare(`
    SELECT id FROM linked_accounts WHERE user_id = ? AND role = 'backup' AND is_active = 1
  `).all(userId);
  for (const { id } of backupAccounts) {
    await ensureBackupReposForAccount(userId, id);
  }
}

async function ensureBackupRepo(userId, linkedAccountId) {
  return ensureBackupReposForAccount(userId, linkedAccountId);
}

async function redoBackupSetup(userId, linkedAccountId) {
  const account = getLinkedAccount(userId, linkedAccountId);
  if (!account) throw new Error('Linked account not found');
  if (account.role !== 'backup') throw new Error('Only backup accounts support re-fork');

  const backupRepoIds = db.prepare(`
    SELECT id FROM storage_repos WHERE user_id = ? AND linked_account_id = ? AND repo_role = 'backup'
  `).all(userId, linkedAccountId).map((row) => row.id);

  for (const repoId of backupRepoIds) {
    db.prepare('DELETE FROM chunk_backups WHERE repo_id = ?').run(repoId);
  }
  db.prepare(`
    DELETE FROM storage_repos WHERE user_id = ? AND linked_account_id = ? AND repo_role = 'backup'
  `).run(userId, linkedAccountId);

  const repos = await ensureBackupReposForAccount(userId, linkedAccountId);
  const backupSync = require('./backup-sync');
  backupSync.runBackupSync(userId, linkedAccountId);

  return {
    username: account.username,
    repos: repos.map((repo) => repo.full_name),
    count: repos.length,
  };
}

async function linkAccount(userId, profile, accessToken, role = 'storage') {
  if (!VALID_ROLES.has(role)) throw new Error('Invalid account role');

  const user = getUser(userId);
  if (!user) throw new Error('User not found');

  const githubId = String(profile.id);
  if (user.github_id === githubId) {
    throw new Error('Cannot link your primary sign-in account');
  }

  const existing = db.prepare('SELECT id FROM linked_accounts WHERE user_id = ? AND github_id = ?')
    .get(userId, githubId);

  let accountId;
  if (existing) {
    db.prepare(`
      UPDATE linked_accounts
      SET access_token = ?, username = ?, avatar_url = ?, role = ?, is_active = 1
      WHERE id = ?
    `).run(accessToken, profile.username, profile.photos?.[0]?.value, role, existing.id);
    accountId = existing.id;
  } else {
    const result = db.prepare(`
      INSERT INTO linked_accounts (user_id, github_id, username, avatar_url, access_token, role)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(userId, githubId, profile.username, profile.photos?.[0]?.value, accessToken, role);
    accountId = result.lastInsertRowid;
  }

  // Add as collaborator to all primary repos so this account can write when primary is rate-limited
  try {
    await ensureCollaboratorsForAccount(userId, accountId);
  } catch (err) {
    console.warn(`Failed to add collaborator for linked account ${accountId}: ${err.message}`);
  }

  if (role === 'backup') {
    await ensureBackupReposForAccount(userId, accountId);
    const backupSync = require('./backup-sync');
    backupSync.runBackupSync(userId, accountId);
  }

  return getLinkedAccount(userId, accountId);
}

function updateAccount(userId, accountId, { role, is_active: isActive }) {
  const account = getLinkedAccount(userId, accountId);
  if (!account) throw new Error('Linked account not found');

  if (role !== undefined) {
    if (!VALID_ROLES.has(role)) throw new Error('Invalid account role');
    db.prepare('UPDATE linked_accounts SET role = ? WHERE id = ? AND user_id = ?').run(role, accountId, userId);
  }

  if (isActive !== undefined) {
    db.prepare('UPDATE linked_accounts SET is_active = ? WHERE id = ? AND user_id = ?')
      .run(isActive ? 1 : 0, accountId, userId);
  }

  return db.prepare(`
    SELECT id, github_id, username, avatar_url, role, is_active, created_at
    FROM linked_accounts WHERE id = ? AND user_id = ?
  `).get(accountId, userId);
}

function unlinkAccount(userId, accountId) {
  const account = getLinkedAccount(userId, accountId);
  if (!account) throw new Error('Linked account not found');

  const storageChunks = db.prepare(`
    SELECT COUNT(*) as count FROM chunks c
    JOIN storage_repos r ON c.repo_id = r.id
    WHERE r.user_id = ? AND r.linked_account_id = ? AND r.repo_role != 'backup'
  `).get(userId, accountId);

  if (storageChunks.count > 0) {
    throw new Error('Cannot unlink account with active storage chunks. Move or delete files first.');
  }

  const backupChunks = db.prepare(`
    SELECT COUNT(*) as count FROM chunk_backups cb
    JOIN storage_repos r ON cb.repo_id = r.id
    WHERE r.user_id = ? AND r.linked_account_id = ?
  `).get(userId, accountId);

  if (backupChunks.count > 0) {
    throw new Error('Cannot unlink account while backup copies exist for stored files.');
  }

  db.prepare('DELETE FROM storage_repos WHERE user_id = ? AND linked_account_id = ?').run(userId, accountId);
  db.prepare('DELETE FROM linked_accounts WHERE id = ? AND user_id = ?').run(accountId, userId);
}

function isBackupRepoRateLimited(userId, repo) {
  const rateLimit = require('./github-rate-limit');
  try {
    const token = getTokenForRepo(userId, repo);
    const tokenKey = rateLimit.keyForToken(token);
    const status = rateLimit.getQuotaStatus(tokenKey);
    return status.paused || status.exhausted || rateLimit.isPaused(tokenKey);
  } catch {
    return false;
  }
}

async function mirrorChunk(userId, chunkId, encrypted, repoPath, primaryRepoId, linkedAccountId = null) {
  const backupRepos = getBackupReposForPrimary(userId, primaryRepoId, linkedAccountId);
  if (!backupRepos.length) return;

  for (const repo of backupRepos) {
    if (isBackupRepoRateLimited(userId, repo)) continue;

    const existing = db.prepare('SELECT id FROM chunk_backups WHERE chunk_id = ? AND repo_id = ?')
      .get(chunkId, repo.id);
    if (existing) continue;

    const [owner, repoName] = repo.full_name.split('/');
    const octokit = createClientForRepo(userId, repo);

    // Chunk may already exist on backup GitHub without a DB row (interrupted sync, reconcile gap)
    const remoteSha = await github.getFileSha(
      octokit, owner, repoName, repoPath, repo.default_branch, { subsystem: 'backup-sync' }
    );
    if (remoteSha) {
      db.prepare('INSERT OR IGNORE INTO chunk_backups (chunk_id, repo_id, sha) VALUES (?, ?, ?)')
        .run(chunkId, repo.id, remoteSha);
      continue;
    }

    const sha = await github.uploadChunk(
      octokit, owner, repoName, repoPath, encrypted, repo.default_branch
    );

    db.prepare('INSERT INTO chunk_backups (chunk_id, repo_id, sha) VALUES (?, ?, ?)')
      .run(chunkId, repo.id, sha);
    db.prepare(
      'UPDATE storage_repos SET chunk_count = chunk_count + 1, total_bytes = total_bytes + ? WHERE id = ?'
    ).run(encrypted.length, repo.id);
  }
}

function deferMirrorChunk() {
  // Backup mirroring is handled by backup-sync after uploads complete.
}

async function downloadChunkFromPrimary(userId, chunk) {
  const primaryRepo = db.prepare('SELECT * FROM storage_repos WHERE id = ?').get(chunk.repo_id);
  if (!primaryRepo) throw new Error('Primary storage repo not found');
  return downloadChunkData(userId, chunk, primaryRepo, chunk.repo_path, primaryRepo.default_branch);
}

async function downloadChunkForView(userId, chunk, view) {
  if (!view || view.type === 'primary') {
    return downloadChunkWithFallback(userId, chunk);
  }

  if (view.type === 'backup') {
    const forkBackup = db.prepare(`
      SELECT * FROM storage_repos
      WHERE linked_account_id = ? AND repo_role = 'backup' AND mirrors_repo_id = ?
      LIMIT 1
    `).get(view.accountId, chunk.repo_id);
    if (forkBackup) {
      try {
        return await downloadChunkData(
          userId, chunk, forkBackup, chunk.repo_path, forkBackup.default_branch
        );
      } catch {
        // try chunk_backups record next
      }
    }

    const backup = db.prepare(`
      SELECT cb.*, r.full_name, r.default_branch, r.linked_account_id, r.id as repo_id
      FROM chunk_backups cb
      JOIN storage_repos r ON cb.repo_id = r.id
      WHERE cb.chunk_id = ? AND r.linked_account_id = ? AND r.repo_role = 'backup'
      LIMIT 1
    `).get(chunk.id, view.accountId);
    if (!backup) throw new Error('Chunk not backed up on this account yet');
    return downloadChunkData(userId, chunk, backup, chunk.repo_path, backup.default_branch);
  }

  if (view.type === 'storage') {
    const repo = db.prepare('SELECT * FROM storage_repos WHERE id = ?').get(chunk.repo_id);
    if (!repo || repo.linked_account_id !== view.accountId) {
      throw new Error('Chunk is not stored on this storage account');
    }
    return downloadChunkData(userId, chunk, repo, chunk.repo_path, repo.default_branch);
  }

  return downloadChunkWithFallback(userId, chunk);
}

async function downloadChunkData(userId, chunk, repo, repoPath, branch) {
  const chunkCache = require('./chunk-cache');
  const cached = chunkCache.get(userId, chunk.id);
  if (cached) return cached;

  const [owner, repoName] = repo.full_name.split('/');
  const octokit = createClientForRepo(userId, repo);
  const data = await github.downloadChunk(octokit, owner, repoName, repoPath, branch, { subsystem: 'download' });
  chunkCache.put(userId, chunk.id, data);
  return data;
}

async function downloadChunkWithFallback(userId, chunk) {
  const primaryRepo = db.prepare('SELECT * FROM storage_repos WHERE id = ?').get(chunk.repo_id);
  if (!primaryRepo) throw new Error('Storage repo not found');

  try {
    return await downloadChunkData(
      userId, chunk, primaryRepo, chunk.repo_path, primaryRepo.default_branch
    );
  } catch (primaryErr) {
    const backups = db.prepare(`
      SELECT cb.*, r.full_name, r.default_branch, r.linked_account_id, r.id as repo_id
      FROM chunk_backups cb
      JOIN storage_repos r ON cb.repo_id = r.id
      WHERE cb.chunk_id = ?
    `).all(chunk.id);

    for (const backup of backups) {
      try {
        return await downloadChunkData(
          userId,
          chunk,
          backup,
          chunk.repo_path,
          backup.default_branch
        );
      } catch {
        // try next backup
      }
    }
    throw primaryErr;
  }
}

const ROLE_LABELS = {
  primary: 'Primary',
  storage: 'Storage',
  backup: 'Backup',
};

async function getAccountRateLimits(userId) {
  const rateLimit = require('./github-rate-limit');
  const accounts = listAccountsWithTokens(userId);
  const seen = new Set();
  const unique = [];

  for (const account of accounts) {
    if (!account.access_token || !account.is_active) continue;
    const tokenKey = rateLimit.keyForToken(account.access_token);
    if (seen.has(tokenKey)) continue;
    seen.add(tokenKey);
    unique.push({ account, tokenKey, token: account.access_token });
  }

  for (const { tokenKey, token } of unique) {
    await rateLimit.refreshQuotaIfNeeded(tokenKey, token);
  }

  return unique.map(({ account, tokenKey }) => {
    const quota = rateLimit.getQuotaStatus(tokenKey);
    const roleLabel = ROLE_LABELS[account.role] || account.role;
    return {
      id: account.id,
      username: account.username,
      role: account.role,
      role_label: roleLabel,
      label: account.role === 'primary'
        ? `Primary (@${account.username})`
        : `@${account.username} (${roleLabel})`,
      avatar_url: account.avatar_url || null,
      is_primary: !!account.is_primary,
      ...quota,
      thresholds: {
        concurrency_full: 16,
        concurrency_at_1000: 12,
        concurrency_at_400: 8,
        concurrency_at_150: 4,
        concurrency_at_50: 2,
        concurrency_exhausted: 1,
        current: quota.recommended_concurrency,
      },
    };
  });
}

async function ensureCollaboratorsForAccount(userId, accountId) {
  const account = getLinkedAccount(userId, accountId);
  if (!account?.is_active) return;
  const primaryOctokit = github.createClient(getUser(userId).access_token);

  const primaryRepos = db.prepare(`
    SELECT full_name, owner, name FROM storage_repos
    WHERE user_id = ? AND is_active = 1 AND is_metadata = 0
      AND (linked_account_id IS NULL OR linked_account_id = ?)
  `).all(userId, accountId);

  for (const repo of primaryRepos) {
    try {
      await github.addCollaborator(primaryOctokit, repo.owner, repo.name, account.username, 'push');
      console.log(`[collaborator] Added @${account.username} to ${repo.full_name}`);
    } catch (err) {
      if (err.status === 409) {
        // Already a collaborator
        continue;
      }
      if (err.status === 404) {
        console.warn(`[collaborator] Repo ${repo.full_name} not found, skipping`);
        continue;
      }
      console.warn(`[collaborator] Failed to add @${account.username} to ${repo.full_name}: ${err.message}`);
    }
  }
}

function removeCollaborator(primaryUsernamer, account, repo) {
  // Note: removal requires the primary account to remove the collaborator
  // This is handled via GitHub UI for now
}

module.exports = {
  listLinkedAccounts,
  listAccountsWithTokens,
  getAccountRateLimits,
  getLinkedAccount,
  createLinkToken,
  peekLinkToken,
  consumeLinkToken,
  getTokenForRepo,
  createClientForRepo,
  createClientForUpload,
  listActiveTokens,
  pickBestToken,
  getBackupReposForPrimary,
  linkAccount,
  updateAccount,
  unlinkAccount,
  mirrorChunk,
  deferMirrorChunk,
  downloadChunkFromPrimary,
  downloadChunkForView,
  downloadChunkWithFallback,
  ensureBackupRepo,
  ensureBackupReposForAccount,
  ensureBackupReposForAllAccounts,
  ensureBackupMirrorRepo,
  reconcileChunkBackupsForRepo,
  reconcileAllBackupRepos,
  syncForkBackups,
  redoBackupSetup,
  ensureCollaboratorsForAccount,
  VALID_ROLES,
};
