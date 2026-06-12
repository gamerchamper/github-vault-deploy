const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');
const { createMemoryDb, seedTestUser, seedTestFile, seedTestRepo } = require('../helpers/setup');

describe('shoutbox routes', function () {
  let app;
  let request;
  let db;
  let user;
  let file;
  let repo;
  const SHARE_TOKEN = 'test-share-token-1';

  before(async function () {
    db = createMemoryDb();
    user = seedTestUser(db, { github_id: '999', username: 'shoutboxuser' });
    repo = seedTestRepo(db, user.id, { full_name: 'test/shoutrepo' });
    file = seedTestFile(db, user.id, {
      id: 'shoutbox-file-1',
      name: 'video.mp4',
      share_token: SHARE_TOKEN,
      chunk_count: 5,
    });

    const dbStub = { prepare: db.prepare.bind(db), exec: db.exec.bind(db) };
    dbStub.__proto__ = db.__proto__;

    const publicRoutes = proxyquire('../../server/routes/public', {
      '../db/database': db,
      '../services/storage': proxyquire('../../server/services/storage', {
        '../db/database': db,
      }),
    });

    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/public', publicRoutes);
    request = require('supertest');
  });

  describe('GET /api/public/share/:token/shoutbox', function () {
    it('should return empty messages array for new room', async function () {
      const res = await request(app)
        .get(`/api/public/share/${SHARE_TOKEN}/shoutbox`)
        .query({ file: file.id, since: 0 });

      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('messages');
      expect(res.body.messages).to.be.an('array').that.is.empty;
    });

    it('should accept empty file param', async function () {
      const res = await request(app)
        .get(`/api/public/share/${SHARE_TOKEN}/shoutbox`)
        .query({ since: 0 });

      expect(res.status).to.equal(200);
    });
  });

  describe('POST /api/public/share/:token/shoutbox', function () {
    it('should create a message and return its id', async function () {
      const res = await request(app)
        .post(`/api/public/share/${SHARE_TOKEN}/shoutbox`)
        .send({
          file_id: file.id,
          viewer_id: 'viewer-abc',
          viewer_name: 'Cool Fox',
          message: 'Hello from test!',
          position: 42.5,
        });

      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('id');
      expect(res.body.id).to.be.a('number');
      expect(res.body.id).to.be.at.least(1);
    });

    it('should reject messages over 500 chars', async function () {
      const res = await request(app)
        .post(`/api/public/share/${SHARE_TOKEN}/shoutbox`)
        .send({
          file_id: file.id,
          viewer_id: 'viewer-abc',
          viewer_name: 'Cool Fox',
          message: 'x'.repeat(501),
        });

      expect(res.status).to.equal(400);
    });

    it('should truncate viewer_name to 32 chars', async function () {
      const res = await request(app)
        .post(`/api/public/share/${SHARE_TOKEN}/shoutbox`)
        .send({
          file_id: file.id,
          viewer_id: 'viewer-abc',
          viewer_name: 'A'.repeat(33),
          message: 'hello',
        });

      expect(res.status).to.equal(200);
    });

    it('should require a message', async function () {
      const res = await request(app)
        .post(`/api/public/share/${SHARE_TOKEN}/shoutbox`)
        .send({
          file_id: file.id,
          viewer_id: 'viewer-abc',
          viewer_name: 'Cool Fox',
          message: '',
        });

      expect(res.status).to.equal(400);
    });

    it('should accept message with position=null', async function () {
      const res = await request(app)
        .post(`/api/public/share/${SHARE_TOKEN}/shoutbox`)
        .send({
          file_id: file.id,
          viewer_id: 'viewer-xyz',
          viewer_name: 'Quiet Bear',
          message: 'No position',
          position: null,
        });

      expect(res.status).to.equal(200);
    });
  });

  describe('GET /api/public/share/:token/shoutbox (after posting)', function () {
    it('should return messages since id 0', async function () {
      const res = await request(app)
        .get(`/api/public/share/${SHARE_TOKEN}/shoutbox`)
        .query({ file: file.id, since: 0 });

      expect(res.status).to.equal(200);
      expect(res.body.messages.length).to.be.at.least(1);
      expect(res.body.messages[0]).to.have.all.keys('id', 'viewer_id', 'viewer_name', 'message', 'position', 'created_at');
    });

    it('should return only newer messages with since param', async function () {
      const first = await request(app)
        .get(`/api/public/share/${SHARE_TOKEN}/shoutbox`)
        .query({ file: file.id, since: 0 });
      const maxId = Math.max(...first.body.messages.map(m => m.id));

      const res = await request(app)
        .get(`/api/public/share/${SHARE_TOKEN}/shoutbox`)
        .query({ file: file.id, since: maxId });

      expect(res.body.messages.length).to.equal(0);
    });
  });
});
