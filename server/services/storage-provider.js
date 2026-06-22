/**
 * Storage provider registry — GitHub, Bitbucket, and future backends.
 */
const github = require('./github');
const bitbucket = require('./bitbucket');
const githubRateLimit = require('./github-rate-limit');
const bitbucketRateLimit = require('./bitbucket-rate-limit');

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
    scopes: ['repository', 'repository:write', 'account'],
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
    default_rate_limit_hour: p.defaultRateLimitHour,
    scopes: p.scopes,
  }));
}

function isConfigured(providerId) {
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
