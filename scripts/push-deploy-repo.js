#!/usr/bin/env node
/**
 * Push project source to a GitHub repo for deployment on another server.
 * Uses the GitHub Git API (no local git required).
 *
 * Excludes: data/, uploads/, .env, .env.example, node_modules/, build artifacts.
 *
 * Setup (one-time):
 *   1. Create a PAT at https://github.com/settings/tokens with "repo" scope
 *   2. Create an empty repo on your primary account (or pass --create-repo)
 *
 * Usage:
 *   set GITHUB_DEPLOY_TOKEN=ghp_...
 *   set DEPLOY_REPO=youruser/github-vault-deploy
 *   npm run deploy:push
 *
 *   node scripts/push-deploy-repo.js --repo youruser/github-vault-deploy --token ghp_...
 *   node scripts/push-deploy-repo.js --dry-run
 *
 * On the other server:
 *   git clone https://github.com/youruser/github-vault-deploy.git
 *   cd github-vault-deploy && cp .env.example .env   # edit secrets
 *   npm install && npm start
 */

const fs = require('fs');
const path = require('path');
const { Octokit } = require('@octokit/rest');

const ROOT = path.resolve(__dirname, '..');
const MAX_FILE_BYTES = 95 * 1024 * 1024;
const BLOB_CONCURRENCY = 6;

const EXCLUDE_DIR_NAMES = new Set([
  'node_modules',
  'data',
  'uploads',
  '.git',
  'coverage',
  'playwright-report',
  'test-results',
  'dist',
  '.cursor',
]);

const EXCLUDE_FILE_NAMES = new Set([
  '.env',
  '.env.example',
  'deploy.env',
]);

const EXCLUDE_SUFFIXES = [
  '.db',
  '.db-shm',
  '.db-wal',
  '.log',
  '.zip',
  '.tar',
  '.gz',
  '.7z',
];

function parseArgs(argv) {
  const opts = {
    repo: process.env.DEPLOY_REPO || process.env.GITHUB_DEPLOY_REPO || null,
    token: process.env.GITHUB_DEPLOY_TOKEN || process.env.GITHUB_TOKEN || null,
    branch: process.env.DEPLOY_BRANCH || 'main',
    message: null,
    dryRun: false,
    createRepo: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--create-repo') opts.createRepo = true;
    else if (arg === '--repo') opts.repo = argv[++i];
    else if (arg === '--token') opts.token = argv[++i];
    else if (arg === '--branch') opts.branch = argv[++i];
    else if (arg === '--message' || arg === '-m') opts.message = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return opts;
}

function printHelp() {
  console.log(`Push GitHub Vault source to a deploy repo (GitHub API, no git CLI).

Options:
  --repo <owner/name>   Target repo (or DEPLOY_REPO env var)
  --token <pat>         GitHub PAT with repo scope (or GITHUB_DEPLOY_TOKEN)
  --branch <name>       Branch to update (default: main)
  --message, -m <text>  Commit message
  --create-repo         Create the repo on your account if missing
  --dry-run             List files only; do not upload
  --help, -h            Show this help

Excluded from upload:
  data/, uploads/, node_modules/, .env, .env.example, *.db, logs, dist/
`);
}

function shouldSkip(relPosix) {
  const parts = relPosix.split('/');
  if (parts.some((part) => EXCLUDE_DIR_NAMES.has(part))) return true;
  const base = parts[parts.length - 1];
  if (EXCLUDE_FILE_NAMES.has(base)) return true;
  if (EXCLUDE_SUFFIXES.some((suffix) => base.endsWith(suffix))) return true;
  return false;
}

function collectFiles(dir = ROOT, rel = '') {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    const relPosix = relPath.replace(/\\/g, '/');
    if (shouldSkip(relPosix)) continue;

    const absPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(absPath, relPath));
      continue;
    }
    if (!entry.isFile()) continue;

    const stat = fs.statSync(absPath);
    if (stat.size > MAX_FILE_BYTES) {
      throw new Error(
        `File too large for GitHub API (${(stat.size / 1024 / 1024).toFixed(1)} MB): ${relPosix}`
      );
    }
    files.push({ relPath: relPosix, absPath, size: stat.size });
  }

  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return files;
}

function splitRepo(fullName) {
  const trimmed = String(fullName || '').trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) {
    throw new Error(`Invalid repo name "${fullName}" — expected owner/name`);
  }
  return { owner: trimmed.slice(0, slash), repo: trimmed.slice(slash + 1) };
}

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function ensureRepo(octokit, owner, repo, createRepo) {
  try {
    const { data } = await octokit.repos.get({ owner, repo });
    return data.default_branch || 'main';
  } catch (err) {
    if (err.status !== 404) throw err;
    if (!createRepo) {
      throw new Error(
        `Repository ${owner}/${repo} not found. Create it on GitHub or pass --create-repo.`
      );
    }
    console.log(`Creating repository ${owner}/${repo}...`);
    const { data } = await octokit.repos.createForAuthenticatedUser({
      name: repo,
      description: 'GitHub Vault deployment mirror',
      private: true,
      auto_init: true,
    });
    return data.default_branch || 'main';
  }
}

function isMissingBranchRef(err) {
  const status = err?.status;
  if (status === 404 || status === 409) return true;
  const msg = String(err?.response?.data?.message || err?.message || '').toLowerCase();
  return /not found|empty/i.test(msg);
}

async function bootstrapEmptyRepo(octokit, owner, repo) {
  console.log('Repository has no commits — bootstrapping via Contents API...');
  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: '.deploy/bootstrap.txt',
    message: 'deploy: initialize repository',
    content: Buffer.from(
      'Bootstrap commit by push-deploy-repo.js (replaced on first full deploy).\n'
    ).toString('base64'),
    encoding: 'base64',
  });
}

async function ensureRepoHasCommits(octokit, owner, repo, branch) {
  let { parentSha } = await getBaseCommit(octokit, owner, repo, branch);
  if (parentSha) return parentSha;

  await bootstrapEmptyRepo(octokit, owner, repo);
  ({ parentSha } = await getBaseCommit(octokit, owner, repo, branch));
  if (!parentSha) {
    throw new Error('Failed to initialize empty repository on GitHub');
  }
  return parentSha;
}

async function getBaseCommit(octokit, owner, repo, branch) {
  try {
    const { data: ref } = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${branch}`,
    });
    const commitSha = ref.object.sha;
    const { data: commit } = await octokit.git.getCommit({
      owner,
      repo,
      commit_sha: commitSha,
    });
    return { parentSha: commitSha, baseTreeSha: commit.tree.sha };
  } catch (err) {
    if (isMissingBranchRef(err)) return { parentSha: null, baseTreeSha: null };
    throw err;
  }
}

async function createBlobs(octokit, owner, repo, files) {
  let done = 0;
  const total = files.length;

  return mapPool(files, BLOB_CONCURRENCY, async (file) => {
    const content = fs.readFileSync(file.absPath);
    const { data } = await octokit.git.createBlob({
      owner,
      repo,
      content: content.toString('base64'),
      encoding: 'base64',
    });
    done++;
    if (done % 25 === 0 || done === total) {
      process.stdout.write(`\rBlobs: ${done}/${total}`);
    }
    return {
      path: file.relPath,
      mode: '100644',
      type: 'blob',
      sha: data.sha,
    };
  });
}

async function pushCommit(octokit, owner, repo, branch, files, message) {
  const defaultBranch = await ensureRepo(octokit, owner, repo, false);
  const targetBranch = branch || defaultBranch;
  const parentSha = await ensureRepoHasCommits(octokit, owner, repo, targetBranch);

  console.log(`Creating ${files.length} blobs...`);
  const treeEntries = await createBlobs(octokit, owner, repo, files);
  console.log('');

  const { data: tree } = await octokit.git.createTree({
    owner,
    repo,
    tree: treeEntries,
  });

  const commitMessage = message || `deploy: ${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}`;
  const { data: commit } = await octokit.git.createCommit({
    owner,
    repo,
    message: commitMessage,
    tree: tree.sha,
    parents: [parentSha],
  });

  try {
    await octokit.git.updateRef({
      owner,
      repo,
      ref: `heads/${targetBranch}`,
      sha: commit.sha,
    });
  } catch (err) {
    if (!isMissingBranchRef(err)) throw err;
    await octokit.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${targetBranch}`,
      sha: commit.sha,
    });
  }

  return { commitSha: commit.sha, branch: targetBranch };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const files = collectFiles();
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  console.log(`Project root: ${ROOT}`);
  console.log(`Files to upload: ${files.length} (${(totalBytes / 1024 / 1024).toFixed(2)} MB)`);

  if (opts.dryRun) {
    for (const file of files) {
      console.log(`  ${file.relPath} (${file.size} bytes)`);
    }
    console.log('Dry run complete — no changes made.');
    return;
  }

  if (!opts.repo) {
    console.error('Missing --repo or DEPLOY_REPO (example: youruser/github-vault-deploy)');
    process.exit(1);
  }
  if (!opts.token) {
    console.error('Missing --token or GITHUB_DEPLOY_TOKEN (PAT with repo scope)');
    process.exit(1);
  }

  const { owner, repo } = splitRepo(opts.repo);
  const octokit = new Octokit({ auth: opts.token });

  const me = await octokit.users.getAuthenticated();
  if (owner.toLowerCase() !== me.data.login.toLowerCase()) {
    console.warn(
      `Warning: repo owner "${owner}" differs from authenticated user "${me.data.login}".`
      + ' Ensure your token can write to this repo.'
    );
  }

  await ensureRepo(octokit, owner, repo, opts.createRepo);
  const { commitSha, branch } = await pushCommit(
    octokit, owner, repo, opts.branch, files, opts.message
  );

  console.log(`\nDeployed to https://github.com/${owner}/${repo}/tree/${branch}`);
  console.log(`Commit: ${commitSha}`);
  console.log('\nOn your other server:');
  console.log(`  git clone https://github.com/${owner}/${repo}.git`);
  console.log('  cd ' + repo);
  console.log('  # Create .env with OAuth credentials (see README Setup section)');
  console.log('  npm install');
  console.log('  npm start');
}

main().catch((err) => {
  const msg = err?.response?.data?.message || err.message || String(err);
  console.error(`\nDeploy failed: ${msg}`);
  if (err?.status) console.error(`GitHub status: ${err.status}`);
  process.exit(1);
});
