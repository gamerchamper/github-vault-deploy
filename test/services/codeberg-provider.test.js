const { expect } = require('chai');
const storageProvider = require('../../server/services/storage-provider');
const codeberg = require('../../server/services/codeberg');
const codebergRateLimit = require('../../server/services/codeberg-rate-limit');

describe('storage-provider codeberg', () => {
  it('lists codeberg among providers', () => {
    const providers = storageProvider.listProviders();
    expect(providers.map((p) => p.id)).to.include.members(['github', 'bitbucket', 'codeberg', 'pastebin']);
    const cb = providers.find((p) => p.id === 'codeberg');
    expect(cb.label).to.equal('Codeberg');
    expect(cb.auth_type).to.equal('oauth');
    expect(cb.supports_org_repos).to.equal(true);
  });

  it('builds codeberg raw URLs', () => {
    const url = storageProvider.rawUrl(
      { full_name: 'user/repo', provider: 'codeberg' },
      'main',
      '.vault/chunks/x/00000.bin',
    );
    expect(url).to.include('codeberg.org');
    expect(url).to.include('/raw/branch/main/');
  });

  it('normalizes codeberg provider id', () => {
    expect(storageProvider.normalizeProvider('codeberg')).to.equal('codeberg');
  });
});

describe('codeberg adapter', () => {
  it('rawUrlForRepo uses forgejo raw path', () => {
    const url = codeberg.rawUrlForRepo('alice/vault-storage-1', 'main', '.vault/a.bin');
    expect(url).to.equal('https://codeberg.org/alice/vault-storage-1/raw/branch/main/.vault/a.bin');
  });

  it('createClient exposes provider id', () => {
    const client = codeberg.createClient('test-token');
    expect(client.provider).to.equal('codeberg');
    expect(client.tokenKey).to.be.a('string');
  });
});

describe('codeberg-rate-limit', () => {
  it('tracks quota per token', () => {
    const key = codebergRateLimit.keyForToken('token-a');
    codebergRateLimit.recordRequest(key, { resource: 'api' });
    const status = codebergRateLimit.getQuotaStatus(key);
    expect(status.limit).to.equal(codebergRateLimit.DEFAULT_LIMIT_MINUTE);
    expect(status.remaining).to.be.at.most(codebergRateLimit.DEFAULT_LIMIT_MINUTE - 1);
    expect(status.provider).to.equal('codeberg');
    expect(status.window).to.equal('minute');
  });

  it('detects rate limit errors', () => {
    expect(codebergRateLimit.isRateLimitError({ status: 429 })).to.equal(true);
    expect(codebergRateLimit.isRateLimitError({ status: 403, message: 'rate limit exceeded' })).to.equal(true);
    expect(codebergRateLimit.isRateLimitError({ status: 500 })).to.equal(false);
  });
});
