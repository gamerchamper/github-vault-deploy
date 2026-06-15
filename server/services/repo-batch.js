const db = require('../db/database');
const storage = require('./storage');
const github = require('./github');
const accounts = require('./accounts');
const vaultOrg = require('./vault-org');
const tasks = require('./tasks');

const REPO_PREFIX = 'vault-storage';
const REPO_CAPACITY_GB = parseInt(process.env.REPO_CAPACITY_GB || '1', 10);
const MAX_BATCH_SIZE = parseInt(process.env.REPO_BATCH_MAX || '500', 10);
const MAX_NAME_ATTEMPTS = 100;

const cancelledTasks = new Set();
const activeUsers = new Set();

function cancelBatch(taskId) {
  cancelledTasks.add(taskId);
}

function isCancelled(taskId) {
  return cancelledTasks.has(taskId);
}

function repoScopeSql(linkedAccountId, ownerOrg) {
  if (ownerOrg) return { clause: ' AND owner = ?', params: [ownerOrg] };
  if (linkedAccountId) return { clause: ' AND linked_account_id = ?', params: [linkedAccountId] };
  return { clause: ' AND linked_account_id IS NULL', params: [] };
}

function maxStorageRepoSuffix(userId, { linkedAccountId = null, ownerOrg = null } = {}) {
  const scope = repoScopeSql(linkedAccountId, ownerOrg);
  const rows = db.prepare(`
    SELECT name FROM storage_repos
    WHERE user_id = ? AND is_metadata = 0 AND repo_role != 'backup'
      AND name LIKE '${REPO_PREFIX}-%'
      ${scope.clause}
  `).all(userId, ...scope.params);

  let max = 0;
  for (const row of rows) {
    const match = new RegExp(`^${REPO_PREFIX}-(\\d+)$`).exec(row.name);
    if (match) max = Math.max(max, parseInt(match[1], 10));
  }
  return max;
}

async function resolveCreateContext(userId, { linkedAccountId = null } = {}) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!user) throw new Error('User not found');

  let token = user.access_token;
  let ownerOrg = user.vault_org || null;
  let linkId = null;
  let ownerLogin = user.username;

  if (linkedAccountId) {
    const account = accounts.getLinkedAccount(userId, linkedAccountId);
    if (!account) throw new Error('Linked account not found');
    if (account.role !== 'storage') {
      throw new Error('Only storage-linked accounts can create repositories');
    }
    token = account.access_token;
    ownerOrg = null;
    linkId = account.id;
    ownerLogin = account.username;
  }

  const octokit = github.createClient(token);
  if (ownerOrg) await vaultOrg.assertOrgAdmin(octokit, ownerOrg);

  return { user, octokit, ownerOrg, linkId, ownerLogin };
}

async function createStorageRepo(userId, { linkedAccountId = null, startSuffix = null } = {}) {
  const ctx = await resolveCreateContext(userId, { linkedAccountId });
  const { octokit, ownerOrg, linkId, ownerLogin } = ctx;

  let suffix = startSuffix != null
    ? startSuffix
    : maxStorageRepoSuffix(userId, { linkedAccountId: linkId, ownerOrg }) + 1;

  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1, suffix += 1) {
    const repoName = `${REPO_PREFIX}-${suffix}`;
    const owner = ownerOrg || ownerLogin;
    const fullName = `${owner}/${repoName}`;

    const existing = db.prepare(
      'SELECT * FROM storage_repos WHERE user_id = ? AND full_name = ?'
    ).get(userId, fullName);
    if (existing) continue;

    let info;
    try {
      info = await github.getRepoInfo(octokit, owner, repoName);
    } catch {
      try {
        info = ownerOrg
          ? await github.createStorageRepo(octokit, repoName, ownerOrg)
          : await github.createStorageRepo(octokit, repoName);
      } catch (err) {
        const msg = err.response?.data?.message || err.message || '';
        if (/already exists/i.test(msg)) continue;
        throw err;
      }
    }

    return storage.addRepo(userId, info.full_name, info.default_branch || 'main', {
      linkedAccountId: linkId,
      isPublic: !info.private,
    });
  }

  throw new Error(`Could not allocate a free ${REPO_PREFIX}-N name after ${MAX_NAME_ATTEMPTS} attempts`);
}

function resolveBatchCount({ gb, count }) {
  let resolved = parseInt(count, 10);
  const gbVal = parseFloat(gb);
  if (Number.isFinite(gbVal) && gbVal > 0) {
    resolved = Math.ceil(gbVal / REPO_CAPACITY_GB);
  }
  if (!Number.isFinite(resolved) || resolved < 1) {
    throw new Error('Provide a positive gb or count value');
  }
  return Math.min(MAX_BATCH_SIZE, Math.max(1, resolved));
}

function hasActiveBatchTask(userId) {
  const row = db.prepare(`
    SELECT id FROM tasks
    WHERE user_id = ? AND (
      (type = 'repo-batch' AND status IN ('processing', 'pending'))
      OR (type = 'auto-repo' AND status = 'processing')
    )
    LIMIT 1
  `).get(userId);
  return !!row;
}

function accountLabel(userId, linkedAccountId) {
  if (!linkedAccountId) {
    const user = db.prepare('SELECT username, vault_org FROM users WHERE id = ?').get(userId);
    return user?.vault_org ? `org ${user.vault_org}` : `@${user?.username || 'primary'}`;
  }
  const account = accounts.getLinkedAccount(userId, linkedAccountId);
  return account ? `@${account.username}` : 'linked account';
}

async function runBatchCreate(userId, taskId, { count, linkedAccountId = null, source = 'manual', persistent = false } = {}) {
  activeUsers.add(userId);
  const repos = [];
  const errors = [];
  let nextSuffix = maxStorageRepoSuffix(userId, {
    linkedAccountId,
    ownerOrg: linkedAccountId ? null : db.prepare('SELECT vault_org FROM users WHERE id = ?').get(userId)?.vault_org,
  }) + 1;

  tasks.update(taskId, userId, {
    status: 'processing',
    phase: 'creating',
    percent: 0,
    done: 0,
    total: count,
    currentRepo: `Creating repo 0/${count}`,
    linkedAccountId,
    source,
  });

  for (let i = 0; i < count; i += 1) {
    if (isCancelled(taskId)) {
      tasks.appendLog(taskId, userId, `Cancelled after ${repos.length}/${count} repos`);
      const cancelPatch = {
        error: 'Cancelled',
        resumable: false,
        done: repos.length,
        total: count,
        percent: count ? Math.round((repos.length / count) * 100) : 100,
      };
      if (persistent) {
        tasks.update(taskId, userId, {
          ...cancelPatch,
          status: 'pending',
          phase: 'countdown',
          currentRepo: null,
          lastLog: `Cancelled — ${repos.length}/${count} repos created`,
        });
      } else {
        tasks.update(taskId, userId, {
          ...cancelPatch,
          status: 'error',
          phase: 'cancelled',
        });
      }
      cancelledTasks.delete(taskId);
      activeUsers.delete(userId);
      return { repos, errors, cancelled: true };
    }

    try {
      const repo = await createStorageRepo(userId, {
        linkedAccountId,
        startSuffix: nextSuffix,
      });
      repos.push(repo);
      nextSuffix = parseInt(repo.name.replace(`${REPO_PREFIX}-`, ''), 10) + 1;
      const done = repos.length;
      tasks.appendLog(taskId, userId, `Created ${repo.full_name} (${done}/${count})`);
      tasks.update(taskId, userId, {
        phase: 'creating',
        percent: Math.round((done / count) * 100),
        done,
        total: count,
        currentRepo: repo.full_name,
        currentName: repo.name,
        errorCount: errors.length,
      });
    } catch (err) {
      const message = err.response?.data?.message || err.message;
      errors.push({ index: i + 1, error: message });
      tasks.appendLog(taskId, userId, `Failed repo ${i + 1}/${count}: ${message}`, { error: true });
      tasks.update(taskId, userId, { errorCount: errors.length });
      nextSuffix += 1;
    }
  }

  cancelledTasks.delete(taskId);
  activeUsers.delete(userId);

  const capacityGbAdded = repos.length * REPO_CAPACITY_GB;
  const partial = errors.length > 0 && repos.length > 0;
  const failed = repos.length === 0 && errors.length > 0;

  const summary = failed
    ? (errors[0]?.error || 'Repository creation failed')
    : partial
      ? `Created ${repos.length}/${count} repos (+${capacityGbAdded} GB) — ${errors.length} failed`
      : `Created ${repos.length} repo${repos.length === 1 ? '' : 's'} (+${capacityGbAdded} GB)`;

  if (persistent) {
    tasks.update(taskId, userId, {
      status: 'pending',
      phase: 'countdown',
      percent: 0,
      done: 0,
      total: count,
      error: failed ? summary : null,
      resumable: false,
      currentRepo: null,
      currentName: null,
      capacityGbAdded,
      errors,
      partial,
      lastLog: summary,
      source,
      errorCount: errors.length,
    });
  } else {
    tasks.update(taskId, userId, {
      status: failed ? 'error' : 'done',
      phase: failed ? 'failed' : 'complete',
      percent: 100,
      done: repos.length,
      total: count,
      error: failed ? (errors[0]?.error || 'Repository creation failed') : null,
      resumable: false,
      currentRepo: failed
        ? null
        : `Added ${capacityGbAdded} GB (${repos.length} repo${repos.length === 1 ? '' : 's'})`,
      capacityGbAdded,
      errors,
      partial,
    });
  }

  return { repos, errors, capacity_gb_added: capacityGbAdded };
}

function startBatchCreate(userId, options = {}) {
  if (activeUsers.has(userId) || hasActiveBatchTask(userId)) {
    throw new Error('A storage repo batch is already running for this account');
  }

  const count = resolveBatchCount(options);
  const linkedAccountId = options.linkedAccountId || null;
  const label = accountLabel(userId, linkedAccountId);
  const title = `Creating ${count} storage repo${count === 1 ? '' : 's'} (${label})`;

  const task = tasks.create(userId, {
    type: 'repo-batch',
    title,
    payload: {
      total: count,
      done: 0,
      linkedAccountId,
      source: options.source || 'manual',
      resumable: false,
    },
  });

  activeUsers.add(userId);
  setImmediate(() => {
    runBatchCreate(userId, task.id, {
      count,
      linkedAccountId,
      source: options.source || 'manual',
    }).catch((err) => {
      activeUsers.delete(userId);
      cancelledTasks.delete(task.id);
      tasks.update(task.id, userId, {
        status: 'error',
        phase: 'failed',
        error: err.message,
        resumable: false,
      });
    });
  });

  return {
    taskId: task.id,
    requested: count,
    repo_capacity_gb: REPO_CAPACITY_GB,
    capacity_gb_requested: count * REPO_CAPACITY_GB,
  };
}

module.exports = {
  REPO_CAPACITY_GB,
  MAX_BATCH_SIZE,
  cancelBatch,
  createStorageRepo,
  maxStorageRepoSuffix,
  hasActiveBatchTask,
  accountLabel,
  runBatchCreate,
  startBatchCreate,
};
