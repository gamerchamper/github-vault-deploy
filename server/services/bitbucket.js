/**
 * Bitbucket Cloud storage adapter — mirrors github.js surface for vault operations.
 * @see https://developer.atlassian.com/cloud/bitbucket/rest/
 */
const rateLimit = require('./bitbucket-rate-limit');

const API_BASE = 'https://api.bitbucket.org/2.0';
const MAX_BLOB_BYTES = Number(process.env.BITBUCKET_MAX_BLOB_MB || 95) * 1024 * 1024;

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
          Authorization: `Bearer ${accessToken}`,
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
        const err = new Error(data?.error?.message || data?.message || `Bitbucket API ${res.status}`);
        err.status = res.status;
        err.response = { status: res.status, data, headers: Object.fromEntries(res.headers.entries()) };
        throw err;
      }
      return { data, headers: Object.fromEntries(res.headers.entries()), status: res.status };
    }, { failFastRateLimit, resource });
  }

  return {
    provider: 'bitbucket',
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
  return { workspace: fullName.slice(0, idx), repoSlug: fullName.slice(idx + 1) };
}

function repoPath(workspace, repoSlug) {
  return `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}`;
}

async function getUserRepos(client, opts = {}) {
  const cacheKey = `bb:userRepos:${opts.accountId || 'primary'}`;
  if (!opts.force) {
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
  }

  const { data: user } = await client.request('GET', '/user');
  const username = user.username;

  const repos = [];
  let url = `/repositories/${encodeURIComponent(username)}?role=member&pagelen=100`;
  while (url) {
    const { data } = await client.request('GET', url);
    for (const r of data.values || []) {
      repos.push(normalizeRepo(r));
    }
    url = data.next ? data.next.replace(API_BASE, '') : null;
  }

  cacheSet(cacheKey, repos);
  return repos;
}

function normalizeRepo(r) {
  const workspace = r.workspace?.slug || r.full_name?.split('/')[0] || r.owner?.username;
  const name = r.slug || r.name;
  const fullName = r.full_name || `${workspace}/${name}`;
  return {
    id: r.uuid,
    full_name: fullName,
    name,
    owner: { login: workspace },
    private: r.is_private,
    default_branch: r.mainbranch?.name || 'main',
    fork: false,
    provider: 'bitbucket',
  };
}

async function createStorageRepo(client, name, workspace = null) {
  const { data: user } = await client.request('GET', '/user');
  const ws = workspace || user.username;
  const { data } = await client.request('POST', `/repositories/${encodeURIComponent(ws)}/${encodeURIComponent(name)}`, {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scm: 'git',
      is_private: false,
      description: 'GitHub Vault storage repository (Bitbucket)',
    }),
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
      `${repoPath(owner, repo)}/src/${encodeURIComponent(ref)}/${cleanPath}?format=meta`,
      { resource: opts.subsystem === 'lookup' ? 'raw' : 'api' },
    );
    return data?.commit?.hash || data?.path || null;
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

async function uploadChunk(client, owner, repo, path, content, branch, existingSha) {
  if (content.length > MAX_BLOB_BYTES) {
    throw new Error(
      `File too large for Bitbucket API (${content.length} bytes). Keep chunks under ${MAX_BLOB_BYTES} bytes.`
    );
  }

  return rateLimit.runWithSubsystem('upload', async () => {
    const cleanPath = String(path || '').replace(/^\//, '');
    const ref = branch || 'main';
    const form = new FormData();
    form.append('branch', ref);
    form.append('message', `vault: store chunk ${cleanPath}`);
    form.append(cleanPath, new Blob([content]), cleanPath.split('/').pop());

    const url = `${API_BASE}${repoPath(owner, repo)}/src`;
    const tokenKey = client.tokenKey;
    return rateLimit.withRetry(tokenKey, async () => {
      rateLimit.logApiCall(tokenKey, `POST ${repoPath(owner, repo)}/src`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${client.accessToken}` },
        body: form,
      });
      rateLimit.noteHeaders(tokenKey, Object.fromEntries(res.headers.entries()));
      if (!res.ok) {
        const text = await res.text();
        let data = null;
        try { data = JSON.parse(text); } catch { data = { message: text }; }
        const err = new Error(data?.error?.message || data?.message || `Upload failed (${res.status})`);
        err.status = res.status;
        err.response = { status: res.status, data };
        throw err;
      }
      const sha = await getFileSha(client, owner, repo, cleanPath, ref, { subsystem: 'upload' });
      return sha || existingSha || cleanPath;
    }, { failFastRateLimit: client.failFastRateLimit });
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
      headers: { Authorization: `Bearer ${client.accessToken}` },
    });
    rateLimit.noteHeaders(tokenKey, Object.fromEntries(res.headers.entries()), { resource: 'raw' });
    if (res.status === 404) {
      const err = new Error('Not found');
      err.status = 404;
      throw err;
    }
    if (!res.ok) {
      const apiPath = `${repoPath(owner, repo)}/src/${encodeURIComponent(ref)}/${cleanPath}`;
      const apiRes = await fetch(`${API_BASE}${apiPath}`, {
        headers: { Authorization: `Bearer ${client.accessToken}`, Accept: 'application/octet-stream' },
      });
      rateLimit.noteHeaders(tokenKey, Object.fromEntries(apiRes.headers.entries()), { resource: 'raw' });
      if (!apiRes.ok) {
        const err = new Error(`Download failed (${apiRes.status})`);
        err.status = apiRes.status;
        throw err;
      }
      return Buffer.from(await apiRes.arrayBuffer());
    }
    return Buffer.from(await res.arrayBuffer());
  }, { resource: 'raw' });
}

async function downloadBlobBySha(client, owner, repo, sha, opts = {}) {
  void sha;
  void opts;
  throw new Error('Bitbucket download by SHA not supported — use path-based download');
}

async function deleteChunk(client, owner, repo, path, sha, branch) {
  void sha;
  const cleanPath = String(path || '').replace(/^\//, '');
  const ref = branch || 'main';
  const form = new FormData();
  form.append('branch', ref);
  form.append('message', `vault: remove chunk ${cleanPath}`);
  form.append('files', cleanPath);

  const url = `${API_BASE}${repoPath(owner, repo)}/src`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${client.accessToken}` },
    body: form,
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`Bitbucket delete failed: ${text.slice(0, 200)}`);
  }
}

async function setRepoPublic(client, owner, repo) {
  const { data } = await client.request('PUT', repoPath(owner, repo), {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ is_private: false }),
  });
  return normalizeRepo(data);
}

function rawUrlForRepo(fullName, branch, repoPathStr) {
  const { workspace, repoSlug } = splitFullName(fullName);
  const path = String(repoPathStr || '').split('/').map(encodeURIComponent).join('/');
  return `https://bitbucket.org/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}/raw/${encodeURIComponent(branch || 'main')}/${path}`;
}

async function addCollaborator(client, owner, repo, username, permission = 'write') {
  const perm = permission === 'push' || permission === 'write' ? 'write' : 'read';
  await client.request(
    'PUT',
    `${repoPath(owner, repo)}/permissions-config/users/${encodeURIComponent(username)}`,
    {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ permission: perm }),
    },
  );
  return { invited: true };
}

async function findFork() {
  return null;
}

async function forkRepo() {
  throw new Error('Bitbucket backup via fork is not supported — use mirror upload');
}

async function mergeUpstream() {
  return { merged: false, message: 'Not applicable for Bitbucket' };
}

async function listUserOrgs() {
  return [];
}

async function getOrg() {
  return null;
}

async function getOrgRole() {
  return null;
}

async function getTokenScopes() {
  return ['repository', 'repository:write', 'account'];
}

function getRepoCacheStats() {
  return {
    read_cache_size: readCache.size,
    repo_info_cache_size: repoInfoCache.size,
    provider: 'bitbucket',
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
  PROVIDER: 'bitbucket',
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
