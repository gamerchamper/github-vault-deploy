/**
 * Pastebin storage adapter — chunks stored as unlisted/private pastes (base64 payload).
 * @see https://pastebin.com/doc_api
 */
const rateLimit = require('./pastebin-rate-limit');

const API_POST = 'https://pastebin.com/api/api_post.php';
const API_RAW = 'https://pastebin.com/api/api_raw.php';
const API_LOGIN = 'https://pastebin.com/api/api_login.php';
const RAW_BASE = 'https://pastebin.com/raw/';

const MAX_BLOB_BYTES = Number(process.env.PASTEBIN_MAX_PASTE_KB || 512) * 1024;
const PASTE_PRIVATE = String(process.env.PASTEBIN_PASTE_PRIVATE || '1'); // 0=public 1=unlisted 2=private
const PASTE_EXPIRE = process.env.PASTEBIN_PASTE_EXPIRE || 'N';
const VAULT_TITLE_PREFIX = 'vault:';

const repoInfoCache = new Map();
const readCache = new Map();
const REPO_INFO_TTL_MS = 15 * 60 * 1000;
const READ_CACHE_TTL = 10 * 60 * 1000;

function isDevKeyConfigured() {
  return !!process.env.PASTEBIN_DEV_KEY;
}

function devKey() {
  const key = process.env.PASTEBIN_DEV_KEY;
  if (!key) throw new Error('PASTEBIN_DEV_KEY is not configured on this server');
  return key;
}

function parseXmlTag(xml, tag) {
  const re = new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i');
  return re.exec(String(xml || ''))?.[1] ?? null;
}

function parsePasteBlocks(xml) {
  if (!xml || /No pastes found/i.test(xml)) return [];
  const blocks = String(xml).split('<paste>').slice(1);
  return blocks.map((block) => ({
    paste_key: parseXmlTag(block, 'paste_key'),
    paste_title: parseXmlTag(block, 'paste_title') || '',
    paste_size: parseInt(parseXmlTag(block, 'paste_size') || '0', 10),
    paste_private: parseXmlTag(block, 'paste_private'),
    paste_url: parseXmlTag(block, 'paste_url'),
  })).filter((p) => p.paste_key);
}

function extractPasteKey(value) {
  if (!value) return null;
  const str = String(value).trim();
  const urlMatch = /pastebin\.com\/(?:raw\/)?([a-zA-Z0-9]+)/i.exec(str);
  if (urlMatch) return urlMatch[1];
  if (/^[a-zA-Z0-9]{8}$/.test(str)) return str;
  return null;
}

function buildPasteTitle(repoName, repoPath) {
  const title = `${VAULT_TITLE_PREFIX}${repoName}/${repoPath}`;
  return title.length > 200 ? title.slice(0, 200) : title;
}

function parseTitle(title) {
  if (!title || !title.startsWith(VAULT_TITLE_PREFIX)) return null;
  const rest = title.slice(VAULT_TITLE_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  return {
    repoName: rest.slice(0, slash),
    repoPath: rest.slice(slash + 1),
  };
}

function encodeChunkPayload(buffer) {
  return `vault:b64\n${buffer.toString('base64')}`;
}

function decodeChunkPayload(text) {
  const raw = String(text || '');
  if (raw.startsWith('vault:b64\n')) {
    return Buffer.from(raw.slice('vault:b64\n'.length), 'base64');
  }
  if (raw.startsWith('vault:b64\r\n')) {
    return Buffer.from(raw.slice('vault:b64\r\n'.length), 'base64');
  }
  return Buffer.from(raw, 'utf8');
}

async function postForm(url, fields, { tokenKey, resource = 'api', failFastRateLimit = false } = {}) {
  return rateLimit.withRetry(tokenKey, async () => {
    rateLimit.logApiCall(tokenKey, `POST ${url}`);
    const body = new URLSearchParams(fields);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
      body,
    });
    const text = await res.text();
    if (text.startsWith('Bad API request')) {
      const err = new Error(text.trim());
      err.status = 400;
      err.response = { data: { message: text.trim() } };
      throw err;
    }
    if (!res.ok) {
      const err = new Error(text.trim() || `Pastebin API ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return text.trim();
  }, { failFastRateLimit, resource });
}

function createClient(apiUserKey, opts = {}) {
  const failFastRateLimit = !!opts.failFastRateLimit;
  const tokenKey = rateLimit.keyForToken(apiUserKey);
  return {
    provider: 'pastebin',
    accessToken: apiUserKey,
    apiUserKey,
    tokenKey,
    failFastRateLimit,
    username: opts.username || null,
  };
}

async function loginMember(username, password) {
  const tokenKey = rateLimit.keyForToken(`${username}:login`);
  const key = await postForm(API_LOGIN, {
    api_dev_key: devKey(),
    api_user_name: username,
    api_user_password: password,
  }, { tokenKey, resource: 'api' });
  if (!key || key.length < 8) {
    throw new Error('Invalid Pastebin login response');
  }
  return key;
}

async function fetchUserProfile(apiUserKey) {
  const client = createClient(apiUserKey);
  const xml = await postForm(API_POST, {
    api_dev_key: devKey(),
    api_user_key: apiUserKey,
    api_option: 'userdetails',
  }, { tokenKey: client.tokenKey });
  return {
    user_name: parseXmlTag(xml, 'user_name'),
    user_avatar_url: parseXmlTag(xml, 'user_avatar_url'),
    user_account_type: parseXmlTag(xml, 'user_account_type'),
    user_private: parseXmlTag(xml, 'user_private'),
  };
}

async function listPastes(client, limit = 1000) {
  const text = await postForm(API_POST, {
    api_dev_key: devKey(),
    api_user_key: client.apiUserKey,
    api_option: 'list',
    api_results_limit: String(Math.min(Math.max(limit, 1), 1000)),
  }, { tokenKey: client.tokenKey });
  return parsePasteBlocks(text);
}

async function ensureUsername(client) {
  if (client.username) return client.username;
  const profile = await fetchUserProfile(client.apiUserKey);
  client.username = profile.user_name;
  return client.username;
}

function normalizeRepo(username, repoName) {
  const name = repoName || 'vault-storage-1';
  const owner = username || 'pastebin';
  return {
    id: `${owner}/${name}`,
    full_name: `${owner}/${name}`,
    name,
    owner: { login: owner },
    private: PASTE_PRIVATE === '2',
    default_branch: 'main',
    fork: false,
    provider: 'pastebin',
  };
}

async function getUserRepos(client, opts = {}) {
  const cacheKey = `pb:userRepos:${opts.accountId || client.apiUserKey}`;
  if (!opts.force) {
    const cached = readCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < READ_CACHE_TTL) return cached.data;
  }

  const username = await ensureUsername(client);
  const pastes = await listPastes(client);
  const repoNames = new Set();
  for (const paste of pastes) {
    const parsed = parseTitle(paste.paste_title);
    if (parsed?.repoName) repoNames.add(parsed.repoName);
  }
  if (!repoNames.size) repoNames.add('vault-storage-1');

  const repos = [...repoNames].sort().map((name) => normalizeRepo(username, name));
  readCache.set(cacheKey, { data: repos, ts: Date.now() });
  return repos;
}

async function createStorageRepo(client, name) {
  const username = await ensureUsername(client);
  return normalizeRepo(username, name);
}

async function getRepoInfo(client, owner, repo) {
  const key = `${owner}/${repo}`;
  const cached = repoInfoCache.get(key);
  if (cached && Date.now() - cached.ts < REPO_INFO_TTL_MS) return cached.data;
  const info = normalizeRepo(owner, repo);
  repoInfoCache.set(key, { data: info, ts: Date.now() });
  return info;
}

async function createPaste(client, repoName, repoPath, content, { existingKey = null } = {}) {
  if (content.length > MAX_BLOB_BYTES) {
    throw new Error(
      `Paste exceeds Pastebin limit (${content.length} bytes, max ${MAX_BLOB_BYTES}). `
      + 'Use a smaller chunk size for Pastebin storage repos.'
    );
  }

  if (existingKey) {
    try {
      await deletePaste(client, existingKey);
    } catch {
      /* replace via new paste if delete fails */
    }
  }

  const pasteCode = encodeChunkPayload(content);
  const response = await postForm(API_POST, {
    api_dev_key: devKey(),
    api_user_key: client.apiUserKey,
    api_option: 'paste',
    api_paste_code: pasteCode,
    api_paste_name: buildPasteTitle(repoName, repoPath),
    api_paste_private: PASTE_PRIVATE,
    api_paste_expire_date: PASTE_EXPIRE,
    api_paste_format: 'text',
  }, { tokenKey: client.tokenKey, failFastRateLimit: client.failFastRateLimit });

  const pasteKey = extractPasteKey(response);
  if (!pasteKey) {
    throw new Error(`Unexpected Pastebin paste response: ${response.slice(0, 120)}`);
  }
  return pasteKey;
}

async function deletePaste(client, pasteKey) {
  await postForm(API_POST, {
    api_dev_key: devKey(),
    api_user_key: client.apiUserKey,
    api_option: 'delete',
    api_paste_key: pasteKey,
  }, { tokenKey: client.tokenKey });
}

async function fetchRawPaste(client, pasteKey, { subsystem = 'download' } = {}) {
  const resource = subsystem === 'lookup' ? 'api' : 'raw';
  return rateLimit.withRetry(client.tokenKey, async () => {
    rateLimit.logApiCall(client.tokenKey, `RAW ${pasteKey}`);
    const text = await postForm(API_RAW, {
      api_dev_key: devKey(),
      api_user_key: client.apiUserKey,
      api_option: 'show_paste',
      api_paste_key: pasteKey,
    }, { tokenKey: client.tokenKey, resource });
    return decodeChunkPayload(text);
  }, { resource });
}

async function uploadChunk(client, owner, repo, path, content, branch, existingSha) {
  void branch;
  void owner;
  const pasteKey = await createPaste(client, repo, path, content, { existingKey: existingSha });
  return pasteKey;
}

async function downloadChunk(client, owner, repo, path, branch, opts = {}) {
  void owner;
  void repo;
  void branch;
  const pasteKey = opts.sha || extractPasteKey(path);
  if (!pasteKey) {
    const pastes = await listPastes(client, 1000);
    const title = buildPasteTitle(repo, path);
    const match = pastes.find((p) => p.paste_title === title);
    if (!match) {
      const err = new Error(`Chunk not found: ${path}`);
      err.status = 404;
      throw err;
    }
    return fetchRawPaste(client, match.paste_key, opts);
  }
  return fetchRawPaste(client, pasteKey, opts);
}

async function downloadBlobBySha(client, owner, repo, sha, opts = {}) {
  void owner;
  void repo;
  return fetchRawPaste(client, sha, opts);
}

async function getFileSha(client, owner, repo, path, branch, opts = {}) {
  void branch;
  void owner;
  const keyFromPath = extractPasteKey(path);
  if (keyFromPath) return keyFromPath;

  const pastes = await listPastes(client, 1000);
  const title = buildPasteTitle(repo, path);
  const match = pastes.find((p) => p.paste_title === title);
  if (match) return match.paste_key;
  if (opts.bypassMissing) return null;
  return null;
}

async function deleteChunk(client, owner, repo, path, sha, branch) {
  void owner;
  void repo;
  void path;
  void branch;
  const pasteKey = sha || extractPasteKey(path);
  if (!pasteKey) return;
  try {
    await deletePaste(client, pasteKey);
  } catch (err) {
    if (/invalid permission|not found/i.test(err.message)) return;
    throw err;
  }
}

function rawUrlForPaste(pasteKey) {
  return `${RAW_BASE}${encodeURIComponent(pasteKey)}`;
}

function rawUrlForRepo(_fullName, _branch, repoPathOrKey) {
  const key = extractPasteKey(repoPathOrKey);
  if (key) return rawUrlForPaste(key);
  return `${RAW_BASE}${encodeURIComponent(repoPathOrKey)}`;
}

async function setRepoPublic() {
  throw new Error('Pastebin pastes cannot be toggled public after creation');
}

async function addCollaborator() {
  return { invited: false, message: 'Pastebin does not support repo collaborators' };
}

async function findFork() {
  return null;
}

async function forkRepo() {
  throw new Error('Pastebin backup via fork is not supported — use mirror upload');
}

async function mergeUpstream() {
  return { merged: false, message: 'Not applicable for Pastebin' };
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
  return ['paste', 'list', 'delete', 'userdetails'];
}

async function fetchCoreRateLimit(accessToken) {
  if (!accessToken) return null;
  const tokenKey = rateLimit.keyForToken(accessToken);
  rateLimit.touchQuotaUpdated(tokenKey);
  return rateLimit.getQuotaStatus(tokenKey);
}

function getRepoCacheStats() {
  return {
    read_cache_size: readCache.size,
    repo_info_cache_size: repoInfoCache.size,
    provider: 'pastebin',
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
  PROVIDER: 'pastebin',
  API_POST,
  MAX_BLOB_BYTES,
  MAX_UNLISTED_PASTES_FREE: 25,
  MAX_PRIVATE_PASTES_FREE: 10,
  isDevKeyConfigured,
  createClient,
  loginMember,
  fetchUserProfile,
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
  rawUrlForPaste,
  buildPasteTitle,
  parseTitle,
  getRepoCacheStats,
  pruneCaches,
};
