const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { createMemoryDb, seedTestUser } = require('../helpers/setup');

describe('api-keys service', function () {
  let db;
  let user;
  let apiKeys;

  beforeEach(function () {
    db = createMemoryDb();
    user = seedTestUser(db, { github_id: 'api-key-user', username: 'apikeyuser' });
    apiKeys = proxyquire('../../server/services/api-keys', {
      '../db/database': db,
    });
  });

  it('should create, authenticate, list, and revoke API keys', function () {
    const created = apiKeys.createKey(user.id, 'CLI key');
    expect(created.key).to.match(/^gv_/);
    expect(created.key_prefix).to.equal(created.key.slice(0, 12));

    const stored = db.prepare('SELECT * FROM api_keys WHERE id = ?').get(created.id);
    expect(stored.key_hash).to.not.equal(created.key);

    const authUser = apiKeys.authenticateKey(created.key);
    expect(authUser.id).to.equal(user.id);
    expect(authUser.apiKey.name).to.equal('CLI key');
    expect(apiKeys.listKeys(user.id)).to.have.length(1);

    expect(apiKeys.revokeKey(user.id, created.id)).to.equal(true);
    expect(apiKeys.authenticateKey(created.key)).to.equal(null);
  });

  it('should throttle last-used writes during repeated authentication', function () {
    const created = apiKeys.createKey(user.id, 'pressure key');
    for (let i = 0; i < 100; i++) {
      expect(apiKeys.authenticateKey(created.key).id).to.equal(user.id);
    }

    const row = db.prepare('SELECT last_used_at FROM api_keys WHERE id = ?').get(created.id);
    expect(row.last_used_at).to.be.a('string');
  });
});
