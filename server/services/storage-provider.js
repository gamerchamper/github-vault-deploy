/**
 * Storage provider registry — GitHub, Bitbucket, and future backends.
 */
const github = require('./github');
const bitbucket = require('./bitbucket');
const pastebin = require('./pastebin');
const githubRateLimit = require('./github-rate-limit');
const bitbucketRateLimit = require('./bitbucket-rate-limit');
const pastebinRateLimit = require('./pastebin-rate-limit');

const PROVIDERS = Object.freeze({
  github: {
    id: 'github',
    label: 'GitHub',
    module: github,
    rateLimit: githubRateLimit,
    supportsForkBackup: true,
    supportsOrgRepos: true,
    maxBlobBytes: Number(process.env.MAX_CHUNK_MB || 95) * 1024 * 1024,
    defaultRateLimitHour: 5000,
    authPath: '/auth/github/link',
    authType: 'oauth',
    scopes: ['repo', 'user', 'read:org'],
  },
  bitbucket: {
    id: 'bitbucket',
    label: 'Bitbucket',
    module: bitbucket,
    rateLimit: bitbucketRateLimit,
    supportsForkBackup: false,
    supportsOrgRepos: false,
    maxBlobBytes: bitbucket.MAX_BLOB_BYTES,
    defaultRateLimitHour: bitbucketRateLimit.DEFAULT_LIMIT,
    authPath: '/auth/bitbucket/link',
    authType: 'oauth',
    scopes: ['repository', 'repository:write', 'account'],
  },
  pastebin: {
    id: 'pastebin',
    label: 'Pastebin',
    module: pastebin,
    rateLimit: pastebinRateLimit,
    supportsForkBackup: false,
    supportsOrgRepos: false,
    maxBlobBytes: pastebin.MAX_BLOB_BYTES,
    defaultRateLimitHour: pastebinRateLimit.DEFAULT_LIMIT,
    authPath: '/auth/pastebin/link',
    authType: 'api_login',
    scopes: ['paste', 'list', 'delete', 'userdetails'],
    maxUnlistedPastesFree: pastebin.MAX_UNLISTED_PASTES_FREE,
    maxPrivatePastesFree: pastebin.MAX_PRIVATE_PASTES_FREE,
  },
});

const DEFAULT_PROVIDER = 'github';

function normalizeProvider(name) {
  const key = String(name || DEFAULT_PROVIDER).toLowerCase();
  return PROVIDERS[key] ? key : DEFAULT_PROVIDER;
}

function getProvider(name) {
  return PROVIDERS[normalizeProvider(name)];
}

function getProviderForRepo(repo) {
  return getProvider(repo?.provider || DEFAULT_PROVIDER);
}

function getModule(name) {
  return getProvider(name).module;
}

function getRateLimit(name) {
  return getProvider(name).rateLimit;
}

function getRateLimitForRepo(repo) {
  return getProviderForRepo(repo).rateLimit;
}

function rawUrl(repo, branch, repoPath) {
  const provider = getProviderForRepo(repo);
  if (provider.id === 'bitbucket') {
    return bitbucket.rawUrlForRepo(repo.full_name, branch, repoPath);
  }
  if (provider.id === 'pastebin') {
    return pastebin.rawUrlForRepo(repo.full_name, branch, repoPath);
  }
  const [owner, name] = repo.full_name.split('/');
  const path = String(repoPath || '').split('/').map(encodeURIComponent).join('/');
  return `https://raw.githubusercontent.com/${owner}/${name}/${branch || 'main'}/${path}`;
}

function listProviders() {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
    supports_fork_backup: p.supportsForkBackup,
    supports_org_repos: p.supportsOrgRepos,
    max_blob_mb: Math.floor(p.maxBlobBytes / (1024 * 1024)),
    max_paste_kb: p.id === 'pastebin' ? Math.floor(p.maxBlobBytes / 1024) : undefined,
    default_rate_limit_hour: p.defaultRateLimitHour,
    auth_type: p.authType || 'oauth',
    max_unlisted_pastes_free: p.maxUnlistedPastesFree,
    max_private_pastes_free: p.maxPrivatePastesFree,
    scopes: p.scopes,
  }));
}

function isConfigured(providerId) {
  if (providerId === 'pastebin') {
    return pastebin.isDevKeyConfigured();
  }
  if (providerId === 'bitbucket') {
    return !!(process.env.BITBUCKET_CLIENT_ID && process.env.BITBUCKET_CLIENT_SECRET);
  }
  if (providerId === 'github') {
    return !!(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
  }
  return false;
}

module.exports = {
  PROVIDERS,
  DEFAULT_PROVIDER,
  normalizeProvider,
  getProvider,
  getProviderForRepo,
  getModule,
  getRateLimit,
  getRateLimitForRepo,
  rawUrl,
  listProviders,
  isConfigured,
};
