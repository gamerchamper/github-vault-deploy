const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { createMemoryDb, seedTestUser } = require('../helpers/setup');

describe('API key auth routes', function () {
  describe('local-provision', function () {
    let db;
    let app;
    let request;

    beforeEach(function () {
      db = require('../../server/db/database');
      app = require('express')();
      app.use(require('express').json());
      app.use('/auth', require('../../server/routes/auth'));
      request = require('supertest');
    });

    it('should return 403 for requests without X-Vault-Local header', async function () {
      const res = await request(app).post('/auth/local-provision');
      expect(res.status).to.equal(403);
    });

    it('should create an API key with X-Vault-Local header when a user exists', async function () {
      const res = await request(app)
        .post('/auth/local-provision')
        .set('X-Vault-Local', '1');
      expect(res.status).to.equal(200);
      expect(res.body.key).to.match(/^gv_/);
      expect(res.body.serverUrl).to.be.a('string');
      expect(res.body.username).to.be.a('string');
    });

    it('should rate-limit repeated provisioning requests', async function () {
      await request(app).post('/auth/local-provision').set('X-Vault-Local', '1');
      const res = await request(app).post('/auth/local-provision').set('X-Vault-Local', '1');
      expect(res.status).to.equal(429);
      expect(res.body.error).to.include('Too many provisioning requests');
    });
  });
  let db;
  let app;
  let request;
  let userId;

  beforeEach(function () {
    db = createMemoryDb();
    const user = seedTestUser(db, { github_id: 'route-api-key-user', username: 'routekey' });
    userId = user.id;

    const apiKeys = proxyquire('../../server/services/api-keys', {
      '../db/database': db,
    });
    const authRoutes = proxyquire('../../server/routes/auth', {
      '../services/api-keys': apiKeys,
      '../middleware/auth': {
        requireAuth: (req, res, next) => { req.user = { id: userId, username: 'routekey' }; next(); },
      },
    });

    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/auth', authRoutes);
    request = require('supertest');
  });

  it('should create, list, and revoke API keys for the panel', async function () {
    const createRes = await request(app)
      .post('/auth/api-keys')
      .send({ name: 'Desktop Panel Key' });

    expect(createRes.status).to.equal(201);
    expect(createRes.body.key.key).to.match(/^gv_/);
    expect(createRes.body.key.name).to.equal('Desktop Panel Key');

    const listRes = await request(app).get('/auth/api-keys');
    expect(listRes.status).to.equal(200);
    expect(listRes.body.keys).to.have.length(1);
    expect(listRes.body.keys[0]).to.not.have.property('key_hash');
    expect(listRes.body.keys[0]).to.not.have.property('key');

    const revokeRes = await request(app).delete(`/auth/api-keys/${listRes.body.keys[0].id}`);
    expect(revokeRes.status).to.equal(200);
    expect(revokeRes.body.success).to.equal(true);

    const afterRevoke = await request(app).get('/auth/api-keys');
    expect(afterRevoke.body.keys[0].revoked_at).to.be.a('string');
  });

  it('should handle many panel API key operations under pressure', async function () {
    const creates = [];
    for (let i = 0; i < 50; i++) {
      creates.push(request(app).post('/auth/api-keys').send({ name: `pressure-${i}` }));
    }

    const created = await Promise.all(creates);
    expect(created.every(res => res.status === 201)).to.equal(true);
    const ids = created.map(res => res.body.key.id);
    expect(new Set(ids).size).to.equal(50);

    const listRes = await request(app).get('/auth/api-keys');
    expect(listRes.status).to.equal(200);
    expect(listRes.body.keys).to.have.length(50);

    const revokes = ids.map(id => request(app).delete(`/auth/api-keys/${id}`));
    const revoked = await Promise.all(revokes);
    expect(revoked.every(res => res.status === 200)).to.equal(true);

    const after = await request(app).get('/auth/api-keys');
    expect(after.body.keys.filter(key => key.revoked_at)).to.have.length(50);
  });
});
