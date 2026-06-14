const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { createMemoryDb, seedTestUser, seedTestFile, seedTestRepo } = require('../helpers/setup');

describe('verify-hls routes', function () {
  let app;
  let request;
  let db;
  let user;
  let repo;
  let file;

  before(function () {
    db = createMemoryDb();
    user = seedTestUser(db, { github_id: 'verify-hls-user', username: 'verifyhls' });
    repo = seedTestRepo(db, user.id, {
      full_name: 'test/verifyhlsrepo',
      default_branch: 'main',
    });
    file = seedTestFile(db, user.id, {
      id: 'verify-hls-file',
      name: 'video.mp4',
      mime_type: 'video/mp4',
      has_hls: 1,
      hls_playlist_repo_id: repo.id,
      hls_playlist_path: '.vault/hls/verify-hls-file/playlist.m3u8',
      chunk_count: 2,
    });
    db.prepare(`
      INSERT INTO hls_segments (file_id, segment_index, duration, repo_id, repo_path, sha, size)
      VALUES (?, 0, 6, ?, '.vault/hls/verify-hls-file/00000.dat', 'abc', 1200)
    `).run(file.id, repo.id);

    const mockHlsConvert = {
      getHlsSegmentCount: (fileId) => {
        const row = db.prepare('SELECT COUNT(*) as n FROM hls_segments WHERE file_id = ?').get(fileId);
        return row?.n || 0;
      },
      verifyHlsOnGitHub: async () => ({
        valid: true,
        fileId: file.id,
        fileName: file.name,
        hasHls: true,
        totalSegments: 1,
        verified: 1,
        missing: [],
        gaps: [],
        missingOnGitHub: [],
        playlistPresent: true,
        playlistHasEndList: true,
        playlistSegmentCount: 1,
        issues: [],
      }),
    };

    const mockAuth = {
      requireAuth: (req, _res, next) => { req.user = { id: user.id }; next(); },
    };
    const mockSetup = {
      ensureSetup: (_req, _res, next) => next(),
    };

    const filesRoutes = proxyquire('../../server/routes/files', {
      '../db/database': db,
      '../middleware/auth': mockAuth,
      '../middleware/setup': mockSetup,
      '../services/hls-convert': mockHlsConvert,
      '../services/storage': proxyquire('../../server/services/storage', {
        '../db/database': db,
        './hls-convert': mockHlsConvert,
      }),
    });

    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/files', filesRoutes);
    request = require('supertest');
  });

  it('starts verify-hls task for HLS file', async function () {
    const res = await request(app).post(`/api/files/${file.id}/verify-hls`);
    expect(res.status).to.equal(200);
    expect(res.body).to.have.property('taskId');
    expect(res.body.success).to.equal(true);
  });

  it('rejects verify-hls for file without HLS data', async function () {
    const plain = seedTestFile(db, user.id, {
      id: 'no-hls-file',
      name: 'plain.mp4',
      mime_type: 'video/mp4',
      has_hls: 0,
    });
    const res = await request(app).post(`/api/files/${plain.id}/verify-hls`);
    expect(res.status).to.equal(400);
    expect(res.body.error).to.include('no HLS');
  });

  it('verify-hls-batch accepts multiple file ids', async function () {
    const res = await request(app)
      .post('/api/files/verify-hls-batch')
      .send({ ids: [file.id] });
    expect(res.status).to.equal(200);
    expect(res.body).to.have.property('taskId');
    expect(res.body.count).to.equal(1);
  });
});
