const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { createMemoryDb, seedTestUser, seedTestFile, seedTestRepo } = require('../helpers/setup');

describe('HLS github-playlist routes', function () {
  describe('GET /api/files/hls/:id/github-playlist', function () {
    let app;
    let request;
    let db;
    let user;
    let repo;
    let file;

    before(function () {
      db = createMemoryDb();
      user = seedTestUser(db, { github_id: 'hls-user', username: 'hlsuser' });
      repo = seedTestRepo(db, user.id, {
        full_name: 'test/hlsrepo',
        default_branch: 'main',
      });
      file = seedTestFile(db, user.id, {
        id: 'hls-file-1',
        name: 'video.mp4',
        mime_type: 'video/mp4',
        has_hls: 1,
        hls_playlist_repo_id: repo.id,
        hls_playlist_path: '.vault/hls/hls-file-1/playlist.m3u8',
        chunk_count: 5,
      });

      const filesRoutes = proxyquire('../../server/routes/files', {
        '../db/database': db,
        '../services/storage': proxyquire('../../server/services/storage', {
          '../db/database': db,
        }),
      });

      const express = require('express');
      app = express();
      app.use('/api/files', filesRoutes);
      request = require('supertest');
    });

    it('should return the GitHub raw URL for a valid HLS file', async function () {
      const res = await request(app)
        .get(`/api/files/hls/${file.id}/github-playlist`);

      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('url');
      expect(res.body.url).to.equal(
        'https://raw.githubusercontent.com/test/hlsrepo/main/.vault/hls/hls-file-1/playlist.m3u8'
      );
    });

    it('should return 404 for file without HLS', async function () {
      const noHlsFile = seedTestFile(db, user.id, {
        id: 'no-hls-file',
        name: 'test.mp4',
        has_hls: 0,
      });

      const res = await request(app)
        .get(`/api/files/hls/${noHlsFile.id}/github-playlist`);

      expect(res.status).to.equal(404);
    });

    it('should return 404 for non-existent file', async function () {
      const res = await request(app)
        .get('/api/files/hls/non-existent-id/github-playlist');

      expect(res.status).to.equal(404);
    });
  });

  describe('GET /api/public/share/:token/hls/github-playlist', function () {
    let app;
    let request;
    let db;
    let user;
    let repo;
    let file;
    const TOKEN = 'hls-share-token';

    before(function () {
      db = createMemoryDb();
      user = seedTestUser(db, { github_id: 'share-hls-user', username: 'sharehls' });
      repo = seedTestRepo(db, user.id, {
        full_name: 'test/sharehlsrepo',
        default_branch: 'main',
      });
      file = seedTestFile(db, user.id, {
        id: 'share-hls-file',
        name: 'video.mp4',
        mime_type: 'video/mp4',
        has_hls: 1,
        hls_playlist_repo_id: repo.id,
        hls_playlist_path: '.vault/hls/share-hls-file/playlist.m3u8',
        share_token: TOKEN,
        chunk_count: 5,
        encryption_meta: JSON.stringify({ iv: 'mock', auth_tag: 'mock', encrypted_key: 'mock' }),
      });

      // mock crypto to avoid GitHub fetches and missing master_key
      const mockCrypto = {
        getMasterKey: () => Buffer.from('x'.repeat(32)),
        deserializeEncryption: () => Buffer.from('x'.repeat(32)),
        wrapKeyForShare: () => ({ wrapped: 'mock' }),
      };

      const storageService = proxyquire('../../server/services/storage', {
        '../db/database': db,
        '../services/crypto': mockCrypto,
      });

      const publicRoutes = proxyquire('../../server/routes/public', {
        '../db/database': db,
        '../services/storage': storageService,
      });

      const express = require('express');
      app = express();
      app.use('/api/public', publicRoutes);
      request = require('supertest');
    });

    it('should return GitHub URL for shared file with HLS', async function () {
      const res = await request(app)
        .get(`/api/public/share/${TOKEN}/hls/github-playlist`)
        .query({ file: file.id });

      expect(res.status).to.equal(200);
      expect(res.body).to.have.property('url');
      expect(res.body.url).to.include('raw.githubusercontent.com');
      expect(res.body.url).to.include('sharehlsrepo');
    });

    it('should return error for unknown token', async function () {
      const res = await request(app)
        .get('/api/public/share/bad-token/hls/github-playlist')
        .query({ file: file.id });

      expect(res.status).to.equal(500);
      expect(res.body.error).to.include('Share not found');
    });
  });
});
