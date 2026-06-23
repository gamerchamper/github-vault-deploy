/**
 * Codeberg (Forgejo/Gitea API) storage adapter — mirrors github.js / bitbucket.js surface.
 * @see https://codeberg.org/api/swagger
 */
const rateLimit = require('./codeberg-rate-limit');
const { CODEBERG_BASE } = require('./codeberg-oauth');

const API_BASE = `${CODEBERG_BASE}/api/v1`;
const MAX_BLOB_BYTES = Number(process.env.CODEBERG_MAX_BLOB_MB || 95) * 1024 * 1024;

const repoInfoCache = new Map();
const readCache = new Map();
const REPO_INFO_TTL_MS = Number(process.env.REPO_INFO_CACHE_TTL_MS) || 6 * 60 * 60 * 1000;
const READ_CACHE_TTL = 15 * 60 * 1000;

function createClient(accessToken, opts = {}) {
  const failFastRateLimit = !!opts.failFastRateLimit;
  const tokenKey = rateLimit.keyForToken(accessToken);

  async function request(method, path, { body, headers = {}, resource = 'api' } = {}) {
    return rateLimit.withRetry(tokenKey, async () => {
      const op = `${method} ${path.split('?')[0]}`;
      rateLimit.logApiCall(tokenKey, op);

      const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `token ${accessToken}`,
          Accept: 'application/json',
          ...headers,
        },
        body,
      });

      rateLimit.noteHeaders(tokenKey, Object.fromEntries(res.headers.entries()), { resource });

      const text = await res.text();
      let data = null;
      if (text) {
        try { data = JSON.parse(text); } catch { data = text; }
      }

      if (!res.ok) {
        const err = new Error(data?.message || data?.error || `Codeberg API ${res.status}`);
        err.status = res.status;
        err.response = { status: res.status, data, headers: Object.fromEntries(res.headers.entries()) };
        throw err;
      }
      return { data, headers: Object.fromEntries(res.headers.entries()), status: res.status };
    }, { failFastRateLimit, resource });
  }

  return {
    provider: 'codeberg',
    accessToken,
    tokenKey,
    request,
    failFastRateLimit,
  };
}

async function fetchCoreRateLimit(accessToken) {
  if (!accessToken) return null;
  const tokenKey = rateLimit.keyForToken(accessToken);
  rateLimit.touchQuotaUpdated(tokenKey);
  return rateLimit.getQuotaStatus(tokenKey);
}

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
  if (cached) return cached;
  const data = await fetcher();
  cacheSet(key, data);
  return data;
}

function splitFullName(fullName) {
  const idx = fullName.indexOf('/');
  if (idx < 0) throw new Error(`Invalid repo full_name: ${fullName}`);
  return { owner: fullName.slice(0, idx), repo: fullName.slice(idx + 1) };
}

function repoPath(owner, repo) {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function normalizeRepo(r) {
  const owner = r.owner?.login || r.full_name?.split('/')[0] || '';
  const name = r.name;
  const fullName = r.full_name || `${owner}/${name}`;
  return {
    id: r.id,
    full_name: fullName,
    name,
    owner: { login: owner },
    private: r.private,
    default_branch: r.default_branch || 'main',
    fork: !!r.fork,
    provider: 'codeberg',
  };
}

async function getUserRepos(client, opts = {}) {
  const cacheKey = `cb:userRepos:${opts.accountId || 'primary'}`;
  if (!opts.force) {
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
  }

  const repos = [];
  let page = 1;
  while (true) {
    const { data } = await client.request('GET', `/user/repos?page=${page}&limit=50&sort=updated`);
    const batch = Array.isArray(data) ? data : [];
    if (!batch.length) break;
    repos.push(...batch.map(normalizeRepo));
    if (batch.length < 50) break;
    page += 1;
  }

  cacheSet(cacheKey, repos);
  return repos;
}

async function createStorageRepo(client, name, org = null) {
  const payload = {
    name,
    auto_init: true,
    private: false,
    description: 'GitHub Vault storage repository (Codeberg)',
  };

  const path = org
    ? `/orgs/${encodeURIComponent(org)}/repos`
    : '/user/repos';

  const { data } = await client.request('POST', path, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return normalizeRepo(data);
}

async function getRepoInfo(client, owner, repo) {
  const key = `${owner}/${repo}`;
  const cached = repoInfoCache.get(key);
  if (cached && Date.now() - cached.ts < REPO_INFO_TTL_MS) return cached.data;

  const { data } = await client.request('GET', repoPath(owner, repo));
  const normalized = normalizeRepo(data);
  repoInfoCache.set(key, { data: normalized, ts: Date.now() });
  return normalized;
}

async function getFileSha(client, owner, repo, path, branch, opts = {}) {
  const cleanPath = String(path || '').replace(/^\//, '');
  const ref = branch || 'main';
  try {
    const { data } = await client.request(
      'GET',
      `${repoPath(owner, repo)}/contents/${cleanPath}?ref=${encodeURIComponent(ref)}`,
      { resource: opts.subsystem === 'lookup' ? 'raw' : 'api' },
    );
    if (Array.isArray(data)) return null;
    return data?.sha || null;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function uploadChunk(client, owner, repo, path, content, branch, existingSha) {
  if (content.length > MAX_BLOB_BYTES) {
    throw new Error(
      `File too large for Codeberg API (${content.length} bytes). Keep chunks under ${MAX_BLOB_BYTES} bytes.`
    );
  }

  return rateLimit.runWithSubsystem('upload', async () => {
    const cleanPath = String(path || '').replace(/^\//, '');
    const ref = branch || 'main';
    const payload = {
      message: `vault: store chunk ${cleanPath}`,
      content: Buffer.from(content).toString('base64'),
      branch: ref,
    };
    if (existingSha) payload.sha = existingSha;

    const { data } = await client.request(
      'POST',
      `${repoPath(owner, repo)}/contents/${cleanPath}`,
      {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
    );
    return data?.content?.sha || data?.commit?.sha || existingSha || cleanPath;
  });
}

async function downloadChunk(client, owner, repo, path, branch, opts = {}) {
  void opts;
  const cleanPath = String(path || '').replace(/^\//, '');
  const ref = branch || 'main';
  const rawUrl = rawUrlForRepo(`${owner}/${repo}`, ref, cleanPath);

  const tokenKey = client.tokenKey;
  return rateLimit.withRetry(tokenKey, async () => {
    rateLimit.logApiCall(tokenKey, `GET raw ${owner}/${repo}/${cleanPath}`);
    const res = await fetch(rawUrl, {
      headers: { Authorization: `token ${client.accessToken}` },
    });
    rateLimit.noteHeaders(tokenKey, Object.fromEntries(res.headers.entries()), { resource: 'raw' });
    if (res.status === 404) {
      const err = new Error('Not found');
      err.status = 404;
      throw err;
    }
    if (!res.ok) {
      const err = new Error(`Download failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return Buffer.from(await res.arrayBuffer());
  }, { resource: 'raw' });
}

async function downloadBlobBySha(client, owner, repo, sha, opts = {}) {
  void sha;
  void opts;
  throw new Error('Codeberg download by SHA not supported — use path-based download');
}

async function deleteChunk(client, owner, repo, path, sha, branch) {
  const cleanPath = String(path || '').replace(/^\//, '');
  const ref = branch || 'main';
  let fileSha = sha;
  if (!fileSha) {
    fileSha = await getFileSha(client, owner, repo, cleanPath, ref);
  }
  if (!fileSha) return;

  await client.request(
    'DELETE',
    `${repoPath(owner, repo)}/contents/${cleanPath}`,
    {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `vault: remove chunk ${cleanPath}`,
        sha: fileSha,
        branch: ref,
      }),
    },
  );
}

async function setRepoPublic(client, owner, repo) {
  const { data } = await client.request('PATCH', repoPath(owner, repo), {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ private: false }),
  });
  return normalizeRepo(data);
}

function rawUrlForRepo(fullName, branch, repoPathStr) {
  const { owner, repo } = splitFullName(fullName);
  const path = String(repoPathStr || '').split('/').map(encodeURIComponent).join('/');
  return `${CODEBERG_BASE}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/raw/branch/${encodeURIComponent(branch || 'main')}/${path}`;
}

async function addCollaborator(client, owner, repo, username, permission = 'write') {
  const perm = permission === 'push' || permission === 'write' ? 'write' : 'read';
  await client.request(
    'PUT',
    `${repoPath(owner, repo)}/collaborators/${encodeURIComponent(username)}?permission=${perm}`,
    { headers: { 'Content-Type': 'application/json' } },
  );
  return { invited: true };
}

async function findFork() {
  return null;
}

async function forkRepo() {
  throw new Error('Codeberg backup via fork is not supported yet — use mirror upload');
}

async function mergeUpstream() {
  return { merged: false, message: 'Not applicable for Codeberg' };
}

async function listUserOrgs(client) {
  const cacheKey = 'cb:userOrgs';
  const cached = cacheGet(cacheKey);
  if (cached) return cached;
  const { data } = await client.request('GET', '/user/orgs?page=1&limit=50');
  const orgs = (Array.isArray(data) ? data : []).map((org) => ({
    login: org.username || org.name,
    id: org.id,
    avatar_url: org.avatar_url,
  }));
  cacheSet(cacheKey, orgs);
  return orgs;
}

async function getOrg(client, org) {
  try {
    return await cacheGetOrFetch(`cb:org:${org}`, async () => {
      const { data } = await client.request('GET', `/orgs/${encodeURIComponent(org)}`);
      return data;
    });
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function getOrgRole() {
  return null;
}

async function getTokenScopes() {
  return ['read:user', 'read:repository', 'write:repository', 'read:organization'];
}

function getRepoCacheStats() {
  return {
    read_cache_size: readCache.size,
    repo_info_cache_size: repoInfoCache.size,
    provider: 'codeberg',
  };
}

function pruneCaches() {
  const now = Date.now();
  let readPruned = 0;
  let repoPruned = 0;
  for (const [key, entry] of readCache) {
    if (now - entry.ts > READ_CACHE_TTL) { readCache.delete(key); readPruned++; }
  }
  for (const [key, entry] of repoInfoCache) {
    if (now - entry.ts > REPO_INFO_TTL_MS) { repoInfoCache.delete(key); repoPruned++; }
  }
  return { read_pruned: readPruned, repo_pruned: repoPruned };
}

module.exports = {
  PROVIDER: 'codeberg',
  API_BASE,
  MAX_BLOB_BYTES,
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
  downloadBlobBySha,
  deleteChunk,
  getRepoInfo,
  setRepoPublic,
  findFork,
  forkRepo,
  mergeUpstream,
  addCollaborator,
  rawUrlForRepo,
  splitFullName,
  getRepoCacheStats,
  pruneCaches,
};
