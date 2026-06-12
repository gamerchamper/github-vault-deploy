const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { createMemoryDb, seedTestUser, seedTestFile, seedTestRepo } = require('../helpers/setup');

describe('presence routes', function () {
  let app;
  let request;
  let db;
  let user;
  let file;
  const TOKEN = 'presence-share-token';

  before(function () {
    db = createMemoryDb();
    user = seedTestUser(db, { github_id: 'presence-user', username: 'presenceuser' });
    seedTestRepo(db, user.id, { full_name: 'test/presencerepo' });
    file = seedTestFile(db, user.id, {
      id: 'presence-file-1',
      name: 'video.mp4',
      share_token: TOKEN,
      chunk_count: 5,
    });

    // verify the share is findable
    const found = db.prepare('SELECT * FROM files WHERE share_token = ?').get(TOKEN);
    if (!found) throw new Error('Share not findable in test DB');

    const publicRoutes = proxyquire('../../server/routes/public', {
      '../db/database': db,
      '../services/storage': proxyquire('../../server/services/storage', {
        '../db/database': db,
      }),
    });

    // test the storage module directly
    const testStorage = require('../../server/services/storage');
    const result = testStorage.getSharedByToken(TOKEN);
    // console.log('Direct storage result:', result);

    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/public', publicRoutes);
    request = require('supertest');
  });

  describe('POST /share/:token/presence/join', function () {
    it('should join a viewer to the room', async function () {
      const res = await request(app)
        .post(`/api/public/share/${TOKEN}/presence/join`)
        .send({ viewer_id: 'viewer-join-1' });

      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('viewer');
      expect(res.body.viewer.id).to.equal('viewer-join-1');
      expect(res.body).to.have.property('viewers');
      expect(res.body.viewers).to.be.an('array');
    });

    it('should reject missing viewer_id', async function () {
      const res = await request(app)
        .post(`/api/public/share/${TOKEN}/presence/join`)
        .send({});

      expect(res.status).to.equal(400);
    });

    it('should reject non-existent share token', async function () {
      const res = await request(app)
        .post('/api/public/share/nonexistent/presence/join')
        .send({ viewer_id: 'viewer-2' });

      expect(res.status).to.equal(404);
    });

    it('should return existing viewers list', async function () {
      const res = await request(app)
        .post(`/api/public/share/${TOKEN}/presence/join`)
        .send({ viewer_id: 'viewer-join-2' });

      expect(res.status).to.equal(200);
      expect(res.body.viewers.map(v => v.id)).to.include.members(['viewer-join-1', 'viewer-join-2']);
    });
  });

  describe('POST /share/:token/presence/heartbeat', function () {
    it('should heartbeat an existing viewer', async function () {
      const res = await request(app)
        .post(`/api/public/share/${TOKEN}/presence/heartbeat`)
        .send({ viewer_id: 'viewer-join-1' });

      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('viewers');
    });

    it('should return 404 for unknown viewer', async function () {
      const res = await request(app)
        .post(`/api/public/share/${TOKEN}/presence/heartbeat`)
        .send({ viewer_id: 'never-joined' });

      expect(res.status).to.equal(404);
    });

    it('should reject missing viewer_id', async function () {
      const res = await request(app)
        .post(`/api/public/share/${TOKEN}/presence/heartbeat`)
        .send({});

      expect(res.status).to.equal(400);
    });
  });

  describe('GET /share/:token/presence', function () {
    it('should return current viewers', async function () {
      const res = await request(app)
        .get(`/api/public/share/${TOKEN}/presence`);

      expect(res.status).to.equal(200);
      expect(res.body.viewers).to.be.an('array');
      const ids = res.body.viewers.map(v => v.id);
      expect(ids).to.include('viewer-join-1');
    });

    it('should return 404 for unknown token', async function () {
      const res = await request(app)
        .get('/api/public/share/nonexistent/presence');

      expect(res.status).to.equal(404);
    });
  });

  describe('POST /share/:token/presence/leave', function () {
    it('should remove a viewer from the room', async function () {
      await request(app)
        .post(`/api/public/share/${TOKEN}/presence/join`)
        .send({ viewer_id: 'viewer-leave-1' });

      const res = await request(app)
        .post(`/api/public/share/${TOKEN}/presence/leave`)
        .send({ viewer_id: 'viewer-leave-1' });

      expect(res.status).to.equal(200);
      expect(res.body.success).to.be.true;

      const list = await request(app).get(`/api/public/share/${TOKEN}/presence`);
      expect(list.body.viewers.map(v => v.id)).to.not.include('viewer-leave-1');
    });
  });
});
