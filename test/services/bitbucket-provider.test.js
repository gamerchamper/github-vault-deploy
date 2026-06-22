const { expect } = require('chai');
const storageProvider = require('../../server/services/storage-provider');
const bitbucket = require('../../server/services/bitbucket');
const bitbucketRateLimit = require('../../server/services/bitbucket-rate-limit');

describe('storage-provider', () => {
  it('lists github and bitbucket providers', () => {
    const providers = storageProvider.listProviders();
    expect(providers.map((p) => p.id)).to.include.members(['github', 'bitbucket']);
  });

  it('builds raw URLs per provider', () => {
    const gh = storageProvider.rawUrl(
      { full_name: 'user/repo', provider: 'github' },
      'main',
      '.vault/chunks/x/00000.bin',
    );
    expect(gh).to.include('raw.githubusercontent.com');

    const bb = storageProvider.rawUrl(
      { full_name: 'workspace/repo', provider: 'bitbucket' },
      'main',
      '.vault/chunks/x/00000.bin',
    );
    expect(bb).to.include('bitbucket.org');
    expect(bb).to.include('/raw/');
  });

  it('normalizes unknown provider to github', () => {
    expect(storageProvider.normalizeProvider('unknown')).to.equal('github');
    expect(storageProvider.normalizeProvider('bitbucket')).to.equal('bitbucket');
  });
});

describe('bitbucket adapter', () => {
  it('builds raw URLs', () => {
    const url = bitbucket.rawUrlForRepo('team/repo', 'main', '.vault/a.bin');
    expect(url).to.equal('https://bitbucket.org/team/repo/raw/main/.vault/a.bin');
  });

  it('createClient exposes provider metadata', () => {
    const client = bitbucket.createClient('test-token');
    expect(client.provider).to.equal('bitbucket');
    expect(client.accessToken).to.equal('test-token');
  });
});

describe('bitbucket-rate-limit', () => {
  it('tracks rolling window usage', () => {
    const key = bitbucketRateLimit.keyForToken('token-a');
    bitbucketRateLimit.recordRequest(key, { resource: 'api' });
    const status = bitbucketRateLimit.getQuotaStatus(key);
    expect(status.limit).to.equal(bitbucketRateLimit.DEFAULT_LIMIT);
    expect(status.remaining).to.be.at.most(bitbucketRateLimit.DEFAULT_LIMIT - 1);
    expect(status.provider).to.equal('bitbucket');
  });

  it('detects rate limit errors', () => {
    expect(bitbucketRateLimit.isRateLimitError({ status: 429 })).to.equal(true);
    expect(bitbucketRateLimit.isRateLimitError({ status: 403, message: 'Rate limit exceeded' })).to.equal(true);
    expect(bitbucketRateLimit.isRateLimitError({ status: 500 })).to.equal(false);
  });
});
