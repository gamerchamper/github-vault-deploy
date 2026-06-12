const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { createMemoryDb, seedTestUser } = require('../helpers/setup');

describe('requireAuth API key support', function () {
  it('should authenticate bearer API keys', function (done) {
    const db = createMemoryDb();
    const user = seedTestUser(db, { github_id: 'auth-key-user', username: 'authkey' });
    const apiKeys = proxyquire('../../server/services/api-keys', { '../db/database': db });
    const created = apiKeys.createKey(user.id, 'test key');
    const { requireAuth } = proxyquire('../../server/middleware/auth', {
      '../services/api-keys': apiKeys,
    });

    const req = {
      isAuthenticated: () => false,
      get: (name) => name.toLowerCase() === 'authorization' ? `Bearer ${created.key}` : null,
      query: {},
    };
    const res = { status: () => res, json: done };

    requireAuth(req, res, () => {
      expect(req.user.id).to.equal(user.id);
      expect(req.authType).to.equal('api-key');
      done();
    });
  });
});
