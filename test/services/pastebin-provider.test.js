const { expect } = require('chai');
const storageProvider = require('../../server/services/storage-provider');
const pastebin = require('../../server/services/pastebin');
const pastebinRateLimit = require('../../server/services/pastebin-rate-limit');

describe('storage-provider pastebin', () => {
  it('lists pastebin provider', () => {
    const providers = storageProvider.listProviders();
    expect(providers.map((p) => p.id)).to.include('pastebin');
    const pb = providers.find((p) => p.id === 'pastebin');
    expect(pb.max_paste_kb).to.be.a('number');
    expect(pb.max_unlisted_pastes_free).to.equal(25);
  });

  it('builds pastebin raw URLs from paste keys', () => {
    const url = storageProvider.rawUrl(
      { full_name: 'user/vault-storage-1', provider: 'pastebin' },
      'main',
      'abc12345',
    );
    expect(url).to.include('pastebin.com/raw/abc12345');
  });

  it('normalizes pastebin provider id', () => {
    expect(storageProvider.normalizeProvider('pastebin')).to.equal('pastebin');
  });
});

describe('pastebin adapter', () => {
  it('builds vault paste titles', () => {
    const title = pastebin.buildPasteTitle('vault-storage-1', '.vault/chunks/x/00000.bin');
    expect(title).to.equal('vault:vault-storage-1/.vault/chunks/x/00000.bin');
  });

  it('parses vault paste titles', () => {
    const parsed = pastebin.parseTitle('vault:vault-storage-1/.vault/chunks/a/00001.bin');
    expect(parsed.repoName).to.equal('vault-storage-1');
    expect(parsed.repoPath).to.equal('.vault/chunks/a/00001.bin');
  });

  it('extracts paste keys from urls', () => {
    expect(pastebin.rawUrlForPaste('UIFdu235')).to.equal('https://pastebin.com/raw/UIFdu235');
  });

  it('createClient exposes provider metadata', () => {
    const client = pastebin.createClient('user-key-abc');
    expect(client.provider).to.equal('pastebin');
    expect(client.apiUserKey).to.equal('user-key-abc');
  });
});

describe('pastebin-rate-limit', () => {
  it('tracks rolling window usage', () => {
    const key = pastebinRateLimit.keyForToken('token-a');
    pastebinRateLimit.recordRequest(key, { resource: 'api' });
    const status = pastebinRateLimit.getQuotaStatus(key);
    expect(status.limit).to.equal(pastebinRateLimit.DEFAULT_LIMIT);
    expect(status.remaining).to.be.at.most(pastebinRateLimit.DEFAULT_LIMIT - 1);
  });
});
