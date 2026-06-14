const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { createMemoryDb, seedTestUser, seedTestFile } = require('../helpers/setup');

const TINY_JPEG = Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AP//Z',
  'base64'
);

describe('thumbnail upload routes', function () {
  let app;
  let request;
  let db;
  let user;
  let file;
  let file2;

  before(function () {
    db = createMemoryDb();
    user = seedTestUser(db, { github_id: 'thumb-upload-user', username: 'thumbupload' });
    file = seedTestFile(db, user.id, {
      id: 'thumb-file-1',
      name: 'clip.mp4',
      mime_type: 'video/mp4',
    });
    file2 = seedTestFile(db, user.id, {
      id: 'thumb-file-2',
      name: 'song.mp3',
      mime_type: 'audio/mpeg',
    });

    const mockAuth = {
      requireAuth: (req, _res, next) => { req.user = { id: user.id }; next(); },
    };
    const mockSetup = {
      ensureSetup: (_req, _res, next) => next(),
    };
    const mockStorage = {
      setCustomThumbnail: async (_userId, fileId) => {
        db.prepare('UPDATE files SET has_thumbnail = 1 WHERE id = ?').run(fileId);
        return { id: fileId, has_thumbnail: true };
      },
      refreshThumbnail: async (_userId, fileId) => ({ id: fileId, has_thumbnail: true }),
    };

    const filesRoutes = proxyquire('../../server/routes/files', {
      '../db/database': db,
      '../middleware/auth': mockAuth,
      '../middleware/setup': mockSetup,
      '../services/storage': mockStorage,
      '../services/tasks': proxyquire('../../server/services/tasks', {
        '../db/database': db,
      }),
    });

    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/files', filesRoutes);
    request = require('supertest');
  });

  it('uploads a single custom thumbnail', async function () {
    const res = await request(app)
      .post(`/api/files/thumbnail/${file.id}/upload`)
      .attach('thumbnail', TINY_JPEG, { filename: 'cover.jpg', contentType: 'image/jpeg' });

    expect(res.status).to.equal(200);
    expect(res.body.success).to.equal(true);
    expect(res.body.has_thumbnail).to.equal(true);

    const row = db.prepare('SELECT has_thumbnail FROM files WHERE id = ?').get(file.id);
    expect(row.has_thumbnail).to.equal(1);
  });

  it('rejects single upload without an image', async function () {
    const res = await request(app).post(`/api/files/thumbnail/${file.id}/upload`);
    expect(res.status).to.equal(400);
    expect(res.body.error).to.include('No image');
  });

  it('starts batch thumbnail upload task', async function () {
    const res = await request(app)
      .post('/api/files/thumbnail-batch/upload')
      .field('fileIds', JSON.stringify([file.id, file2.id]))
      .attach('thumbnails', TINY_JPEG, { filename: 'clip.jpg', contentType: 'image/jpeg' })
      .attach('thumbnails', TINY_JPEG, { filename: 'song.jpg', contentType: 'image/jpeg' });

    expect(res.status).to.equal(200);
    expect(res.body).to.have.property('taskId');
    expect(res.body.count).to.equal(2);

    await new Promise((resolve) => setTimeout(resolve, 200));

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(res.body.taskId);
    expect(task).to.exist;
    expect(task.type).to.equal('thumbnail-upload');
    expect(task.status).to.equal('done');

    const rows = db.prepare('SELECT has_thumbnail FROM files WHERE id IN (?, ?)').all(file.id, file2.id);
    expect(rows.every((r) => r.has_thumbnail === 1)).to.equal(true);
  });

  it('rejects batch upload when image count mismatches file ids', async function () {
    const res = await request(app)
      .post('/api/files/thumbnail-batch/upload')
      .field('fileIds', JSON.stringify([file.id, file2.id]))
      .attach('thumbnails', TINY_JPEG, { filename: 'only-one.jpg', contentType: 'image/jpeg' });

    expect(res.status).to.equal(400);
    expect(res.body.error).to.include('Expected 2 image(s), received 1');
  });
});
