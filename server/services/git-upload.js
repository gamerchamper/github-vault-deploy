const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const github = require('./github');
const accounts = require('./accounts');

const execFileAsync = promisify(execFile);
const diskCache = require('./disk-cache');
const dataDir = path.join(diskCache.cacheDir, 'git-workspaces');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const workspaces = new Map();
const repoLocks = new Map();

function workspaceKey(userId, fileId) {
  return `${userId}:${fileId}`;
}

function repoDir(base, fullName) {
  return path.join(base, fullName.replace('/', '__'));
}

function sharedRepoDir(userId, fullName) {
  return path.join(dataDir, String(userId), '_repos', fullName.replace('/', '__'));
}

function stagingRoot(ws, repo) {
  return repoDir(path.join(ws.base, 'staging'), repo.full_name);
}

async function withRepoLock(key, fn) {
  while (repoLocks.has(key)) {
    await repoLocks.get(key);
  }
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  repoLocks.set(key, gate);
  try {
    return await fn();
  } finally {
    repoLocks.delete(key);
    release();
  }
}

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function isGitAvailable() {
  try {
    await execFileAsync('git', ['--version']);
    return true;
  } catch {
    return false;
  }
}

function getWorkspace(userId, fileId) {
  const key = workspaceKey(userId, fileId);
  if (!workspaces.has(key)) {
    workspaces.set(key, {
      base: path.join(dataDir, String(userId), fileId),
      repos: new Map(),
    });
  }
  return workspaces.get(key);
}

async function ensureSharedRepoClone(userId, repo, token, onLog) {
  const dir = sharedRepoDir(userId, repo.full_name);
  if (fs.existsSync(path.join(dir, '.git'))) return dir;

  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });

  const branch = repo.default_branch || 'main';
  const url = `https://x-access-token:${token}@github.com/${repo.full_name}.git`;

  if (onLog) onLog(`Cloning ${repo.full_name} (${branch}) for push...`);
  await execFileAsync('git', [
    'clone', '--depth', '1', '--branch', branch, '--single-branch', url, dir,
  ], { timeout: 600000, maxBuffer: 10 * 1024 * 1024 });
  if (onLog) onLog(`Cloned ${repo.full_name}`);

  return dir;
}

async function writeChunk(userId, fileId, repo, chunkIndex, repoPath, encrypted, onLog) {
  const token = accounts.getTokenForRepo(userId, repo);
  const ws = getWorkspace(userId, fileId);
  const staging = stagingRoot(ws, repo);
  const full = path.join(staging, repoPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, encrypted);
  ws.repos.set(repo.id, { repo, token });
  if (onLog) {
    onLog(`Staged chunk ${chunkIndex} (${formatBytes(encrypted.length)}) → ${repo.full_name}`, {
      chunkIndex,
      repo: repo.full_name,
      bytes: encrypted.length,
    });
  }
  return { repo_path: repoPath, dir: staging, repo: repo.full_name };
}

function formatBytes(n) {
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(2)} GB`;
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

async function pushWorkspace(userId, fileId, onProgress, onLog) {
  const key = workspaceKey(userId, fileId);
  const ws = workspaces.get(key);
  if (!ws) return;

  const repos = [...ws.repos.values()];
  for (let i = 0; i < repos.length; i++) {
    const { repo, token } = repos[i];
    const staging = stagingRoot(ws, repo);
    if (!fs.existsSync(staging)) continue;

    const lockKey = `${userId}:${repo.full_name}`;
    await withRepoLock(lockKey, async () => {
      if (onProgress) {
        onProgress({
          phase: 'git-push',
          percent: 88 + Math.round(((i + 1) / repos.length) * 6),
          currentRepo: repo.full_name,
          lastLog: `Pushing ${repo.full_name} (${i + 1}/${repos.length})...`,
        });
      }

      const cloneDir = await ensureSharedRepoClone(userId, repo, token, onLog);
      if (onLog) onLog(`Copying staged chunks into ${repo.full_name}...`);
      copyDirRecursive(staging, cloneDir);

      await execFileAsync('git', ['config', 'user.email', 'vault@localhost'], { cwd: cloneDir });
      await execFileAsync('git', ['config', 'user.name', 'GitHub Vault'], { cwd: cloneDir });
      await execFileAsync('git', ['add', '-A'], { cwd: cloneDir });

      try {
        await execFileAsync('git', ['diff', '--cached', '--quiet'], { cwd: cloneDir });
        if (onLog) onLog(`No changes to push for ${repo.full_name}`);
        return;
      } catch {
        // staged changes exist
      }

      await execFileAsync('git', ['commit', '-m', `vault: upload chunks (${fileId.slice(0, 8)})`], { cwd: cloneDir });
      await execFileAsync('git', ['push', 'origin', repo.default_branch || 'main'], {
        cwd: cloneDir,
        timeout: 600000,
      });
      if (onLog) onLog(`Pushed ${repo.full_name}`);
    });
  }
}

async function resolveChunkShas(userId, fileId) {
  const db = require('../db/database');
  const chunks = db.prepare(`
    SELECT c.*, r.full_name, r.default_branch, r.id as repo_id, r.linked_account_id
    FROM chunks c JOIN storage_repos r ON c.repo_id = r.id
    WHERE c.file_id = ? AND (c.sha IS NULL OR c.sha = '' OR c.sha = 'pending')
    ORDER BY c.chunk_index
  `).all(fileId);

  const updateChunk = db.prepare('UPDATE chunks SET sha = ? WHERE id = ?');
  const updateRepo = db.prepare(
    'UPDATE storage_repos SET chunk_count = chunk_count + 1, total_bytes = total_bytes + ? WHERE id = ?'
  );

  for (const chunk of chunks) {
    const repo = db.prepare('SELECT * FROM storage_repos WHERE id = ?').get(chunk.repo_id);
    const octokit = accounts.createClientForRepo(userId, repo);
    const [owner, repoName] = chunk.full_name.split('/');
    const sha = await github.getFileSha(
      octokit, owner, repoName, chunk.repo_path, chunk.default_branch
    );
    if (!sha) throw new Error(`Chunk not found on GitHub after push: ${chunk.repo_path}`);
    updateChunk.run(sha, chunk.id);
    updateRepo.run(chunk.size, chunk.repo_id);
  }
}

function cleanupWorkspace(userId, fileId) {
  const key = workspaceKey(userId, fileId);
  const ws = workspaces.get(key);
  if (ws?.base && fs.existsSync(ws.base)) {
    fs.rmSync(ws.base, { recursive: true, force: true });
  }
  workspaces.delete(key);
}

module.exports = {
  isGitAvailable,
  writeChunk,
  pushWorkspace,
  resolveChunkShas,
  cleanupWorkspace,
};
