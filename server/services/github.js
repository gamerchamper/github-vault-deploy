const { Octokit } = require('@octokit/rest');
const rateLimit = require('./github-rate-limit');
const chunkLookup = require('./chunk-lookup-cache');

function createClient(accessToken) {
  const octokit = new Octokit({ auth: accessToken });
  const tokenKey = rateLimit.keyForToken(accessToken);

  octokit.hook.wrap('request', async (request, options) => {
    return rateLimit.withRetry(tokenKey, async () => {
      const op = (options.method || 'GET') + ' ' + (options.url || '').split('?')[0];
      rateLimit.logApiCall(tokenKey, op);
      try {
        const response = await request(options);
        rateLimit.noteHeaders(tokenKey, response.headers);
        return response;
      } catch (err) {
        if (rateLimit.isRateLimitError(err)) {
          rateLimit.noteHeaders(tokenKey, err.response?.headers);
        }
        throw err;
      }
    });
  });

  return octokit;
}

async function fetchCoreRateLimit(accessToken) {
  if (!accessToken) return null;
  const tokenKey = rateLimit.keyForToken(accessToken);
  rateLimit.logApiCall(tokenKey, 'GET rate_limit check');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch('https://api.github.com/rate_limit', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: controller.signal,
    });

    const headers = Object.fromEntries(res.headers.entries());
    if (!res.ok) {
      rateLimit.noteHeaders(tokenKey, headers);
      rateLimit.touchQuotaUpdated(tokenKey);
      throw new Error(`GitHub rate_limit API returned ${res.status}`);
    }

    const data = await res.json();
    if (data?.resources?.core) {
      rateLimit.setQuotaFromCore(tokenKey, data.resources.core);
    }
    rateLimit.noteHeaders(tokenKey, headers);
  } catch (err) {
    rateLimit.touchQuotaUpdated(tokenKey);
    throw err;
  } finally {
    clearTimeout(timer);
  }

  return rateLimit.getQuotaStatus(tokenKey);
}

async function getTokenScopes(octokit) {
  return cacheGetOrFetch('tokenScopes', async () => {
    const { headers } = await octokit.request('GET /user');
    const raw = headers['x-oauth-scopes'] || headers['X-OAuth-Scopes'] || '';
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
  });
}

async function getUserRepos(octokit, opts = {}) {
  const cacheKey = `userRepos:${opts.accountId || 'primary'}`;
  if (!opts.force) {
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
  }
  return cacheGetOrFetch(cacheKey, async () => {
    const repos = [];
    let page = 1;
    while (true) {
      const { data } = await octokit.repos.listForAuthenticatedUser({
        per_page: 100,
        page,
        sort: 'updated',
      });
      if (data.length === 0) break;
      repos.push(...data);
      if (data.length < 100) break;
      page++;
    }
    return repos;
  });
}

async function createStorageRepo(octokit, name, org = null) {
  if (org) {
    const { data } = await octokit.repos.createInOrg({
      org,
      name,
      description: 'GitHub Vault storage repository',
      private: false,
      visibility: 'public',
      auto_init: true,
    });
    return data;
  }

  const { data } = await octokit.repos.createForAuthenticatedUser({
    name,
    description: 'GitHub Vault storage repository',
    private: false,
    visibility: 'public',
    auto_init: true,
  });
  return data;
}

async function listUserOrgs(octokit) {
  return cacheGetOrFetch('userOrgs', async () => {
    const orgs = [];
    let page = 1;
    while (true) {
      const { data } = await octokit.orgs.listForAuthenticatedUser({ per_page: 100, page });
      if (!data.length) break;
      orgs.push(...data);
      if (data.length < 100) break;
      page += 1;
    }
    return orgs;
  });
}

async function getOrg(octokit, org) {
  try {
    return await cacheGetOrFetch(`org:${org}`, async () => {
      const { data } = await octokit.orgs.get({ org });
      return data;
    });
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function getOrgRole(octokit, org) {
  try {
    return await cacheGetOrFetch(`orgRole:${org}`, async () => {
      const { data } = await octokit.orgs.getMembershipForAuthenticatedUser({ org });
      return data.role;
    });
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function getFileSha(octokit, owner, repo, path, branch, opts = {}) {
  return chunkLookup.getFileSha(octokit, owner, repo, path, branch, opts);
}

function isContentsConflict(err) {
  const msg = err.response?.data?.message || err.message || '';
  return err.status === 409
    || err.status === 422
    || /sha.*wasn't supplied/i.test(msg)
    || /expected [a-f0-9]{40}/i.test(msg);
}

async function uploadChunk(octokit, owner, repo, path, content, branch, existingSha) {
  return rateLimit.runWithSubsystem('upload', async () => {
  let sha = existingSha;
  const maxAttempts = 6;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const params = {
        owner,
        repo,
        path,
        message: `vault: store chunk ${path}`,
        content: content.toString('base64'),
        branch,
      };
      if (sha) params.sha = sha;

      const { data } = await octokit.repos.createOrUpdateFileContents(params);
      return data.content.sha;
    } catch (err) {
      if (!isContentsConflict(err) || attempt === maxAttempts - 1) {
        const msg = err.response?.data?.message || err.message || 'GitHub upload failed';
        if (/too large/i.test(msg)) {
          throw new Error(
            `${msg} Use Git upload mode for large files, or keep API chunks under 95 MB.`
          );
        }
        throw err;
      }
      const msg = err.response?.data?.message || err.message || '';
      if (err.status === 422 || /sha.*wasn't supplied/i.test(msg)) {
        chunkLookup.clearBlobMissing(chunkLookup.blobKey(owner, repo, path, branch));
      }
      sha = await getFileSha(octokit, owner, repo, path, branch, { subsystem: 'upload', bypassMissing: true });
      await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
    }
  }
  });
}

async function downloadChunk(octokit, owner, repo, path, branch, opts = {}) {
  return chunkLookup.downloadBlob(octokit, owner, repo, path, branch, opts);
}

async function deleteChunk(octokit, owner, repo, path, sha, branch) {
  await octokit.repos.deleteFile({
    owner,
    repo,
    path,
    message: `vault: remove chunk ${path}`,
    sha,
    branch,
  });
}

const repoInfoCache = new Map();
const repoInfoPending = new Map();
let repoCacheHits = 0;
let repoCacheMisses = 0;
let repoCacheApiCalls = 0;

const readCache = new Map();
const READ_CACHE_TTL = 15 * 60 * 1000;
const REPO_INFO_TTL_MS = Number(process.env.REPO_INFO_CACHE_TTL_MS) || 6 * 60 * 60 * 1000;
const readCachePending = new Map();

function cacheGet(key) {
  const entry = readCache.get(key);
  if (entry && Date.now() - entry.ts < READ_CACHE_TTL) return entry.data;
  return null;
}

function cacheSet(key, data) {
  readCache.set(key, { data, ts: Date.now() });
}

async function cacheGetOrFetch(key, fetcher) {
  const cached = cacheGet(key);
  if ( cached) return cached;

  const pending = readCachePending.get(key);
  if (pending) { try { return await pending; } catch { /* fall through */ } }

  const promise = fetcher().then((data) => {
    cacheSet(key, data);
    return data;
  }).finally(() => { readCachePending.delete(key); });

  readCachePending.set(key, promise);
  return promise;
}

async function getRepoInfo(octokit, owner, repo) {
  const key = `${owner}/${repo}`;
  const cached = repoInfoCache.get(key);
  if (cached && Date.now() - cached.ts < REPO_INFO_TTL_MS) {
    repoCacheHits++;
    if (repoCacheHits % 10 === 1) console.log(`[cache] HIT ${key} (hits=${repoCacheHits})`);
    return cached.data;
  }
  if (cached) repoInfoCache.delete(key);

  repoCacheMisses++;
  const pending = repoInfoPending.get(key);
  if (pending) {
    repoCacheMisses--;
    if (repoCacheMisses % 10 === 1) console.log(`[cache] WAIT ${key} (waiting for in-flight)`);
    try { return await pending; } catch { /* fall through */ }
  }

  repoCacheApiCalls++;
  console.log(`[cache] MISS ${key} — making API call (misses=${repoCacheMisses}, calls=${repoCacheApiCalls})`);
  const promise = octokit.repos.get({ owner, repo }).then(({ data }) => {
    repoInfoCache.set(key, { data, ts: Date.now() });
    return data;
  }).finally(() => { repoInfoPending.delete(key); });

  repoInfoPending.set(key, promise);
  return promise;
}

function getRepoCacheStats() {
  return {
    hits: repoCacheHits,
    misses: repoCacheMisses,
    api_calls: repoCacheApiCalls,
    read_cache_size: readCache.size,
    repo_info_cache_size: repoInfoCache.size,
  };
}

function pruneCaches() {
  const now = Date.now();
  let readPruned = 0;
  let repoPruned = 0;

  for (const [key, entry] of readCache) {
    if (now - entry.ts > READ_CACHE_TTL) {
      readCache.delete(key);
      readPruned += 1;
    }
  }

  for (const [key, entry] of repoInfoCache) {
    if (now - entry.ts > REPO_INFO_TTL_MS) {
      repoInfoCache.delete(key);
      repoPruned += 1;
    }
  }

  return { read_pruned: readPruned, repo_pruned: repoPruned };
}

async function setRepoPublic(octokit, owner, repo) {
  const { data } = await octokit.repos.update({
    owner,
    repo,
    private: false,
    visibility: 'public',
  });
  return data;
}

async function findFork(octokit, owner, repo, forkOwner) {
  const cacheKey = `fork:${owner}/${repo}:${forkOwner}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  // Try public API first — unauthenticated, works for public repos
  try {
    const resp = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/forks?per_page=100`,
      { headers: { Accept: 'application/vnd.github+json' }, timeout: 10000 }
    );
    if (resp.ok) {
      const forks = await resp.json();
      const match = forks.find((f) => f.owner?.login === forkOwner);
      cacheSet(cacheKey, match || null);
      return match || null;
    }
  } catch { /* fall through to authenticated API */ }

  let page = 1;
  while (true) {
    const { data } = await octokit.repos.listForks({ owner, repo, per_page: 100, page });
    const match = data.find((fork) => fork.owner.login === forkOwner);
    if (match) { cacheSet(cacheKey, match); return match; }
    if (data.length < 100) break;
    page += 1;
  }
  cacheSet(cacheKey, null);
  return null;
}

async function forkRepo(octokit, owner, repo, forkOwner) {
  const existing = await findFork(octokit, owner, repo, forkOwner);
  if (existing) return existing;

  const { data } = await octokit.repos.createFork({
    owner,
    repo,
    default_branch_only: false,
  });

  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      const [fOwner, fName] = data.full_name.split('/');
      return await getRepoInfo(octokit, fOwner, fName);
    } catch {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return data;
}

async function mergeUpstream(octokit, owner, repo, branch = 'main') {
  const { data } = await octokit.repos.mergeUpstream({ owner, repo, branch });
  return data;
}

async function addCollaborator(octokit, owner, repo, username, permission = 'push') {
  const { data } = await octokit.repos.addCollaborator({
    owner,
    repo,
    username,
    permission,
  });
  return data;
}

module.exports = {
  createClient,
  fetchCoreRateLimit,
  getTokenScopes,
  getUserRepos,
  listUserOrgs,
  getOrg,
  getOrgRole,
  createStorageRepo,
  uploadChunk,
  getFileSha,
  downloadChunk,
  deleteChunk,
  getRepoInfo,
  setRepoPublic,
  findFork,
  forkRepo,
  mergeUpstream,
  addCollaborator,
  getRepoCacheStats,
  pruneCaches,
};
