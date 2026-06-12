const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { createMemoryDb, seedTestUser, seedTestFile, seedTestRepo } = require('../helpers/setup');
const path = require('path');
const fs = require('fs');

describe('Upload routes', function () {
  let db;
  let request;
  let app;
  let userId;
  let repoId;
  let uploadDir;

  before(function () {
    db = createMemoryDb();
    const user = seedTestUser(db, { github_id: 'upload-test-user', username: 'uploadtest', master_key: 'x'.repeat(44) });
    userId = user.id;
    const repo = seedTestRepo(db, userId, { full_name: 'test/uploadrepo', default_branch: 'main' });
    repoId = repo.id;
    uploadDir = path.join(__dirname, '../../uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

    const mockAuth = {
      requireAuth: (req, res, next) => { req.user = { id: userId }; next(); },
    };
    const mockSetup = {
      ensureSetup: (req, res, next) => next(),
    };
    const mockCrypto = {
      getMasterKey: () => Buffer.alloc(32),
      generateKey: () => Buffer.alloc(32),
      wrapFileKey: () => ({ wrapped_key: 'AAA', wrap_iv: 'AAA', wrap_tag: 'AAA' }),
      encryptChunk: () => ({ encrypted: Buffer.alloc(500), iv: Buffer.alloc(16), authTag: Buffer.alloc(16) }),
      deserializeEncryption: () => Buffer.alloc(32),
    };
    const mockGithub = {
      uploadChunk: async () => 'mock-sha-abc',
      getRepoInfo: async () => ({ default_branch: 'main' }),
    };
    const mockAccounts = {
      createClientForUpload: () => ({}),
      createClientForRepo: () => ({}),
      getTokenForRepo: () => 'mock-token',
      ensureBackupReposForAllAccounts: async () => {},
    };
    const mockMetadata = {
      saveFileManifest: async () => {},
      saveThumbnail: async () => {},
      getFileManifest: async () => null,
      deleteFileMetadata: async () => {},
      warmThumbnailsBackground: () => {},
      getMetadataRepo: () => null,
    };
    const mockHlsConvert = {
      isFfmpegAvailable: async () => false,
      convertFile: async () => { throw new Error('FFmpeg not available in test'); },
    };
    const mockBackupSync = {
      startAllBackupSyncs: () => {},
      dedupeAllBackupTasks: () => {},
      maybeResumeSync: () => {},
    };
    const mockThumbnails = {
      generate: async () => null,
      isAudio: () => false,
      isVideo: () => false,
      generateFromLookup: async () => null,
      previewByteLimit: () => 1024 * 1024,
    };
    const mockCache = { remove: () => {}, get: () => null, put: () => {} };

    const filesRoutes = proxyquire('../../server/routes/files', {
      '../db/database': db,
      '../middleware/auth': mockAuth,
      '../middleware/setup': mockSetup,
      '../services/storage': proxyquire('../../server/services/storage', {
        '../db/database': db,
        '../services/crypto': mockCrypto,
        '../services/github': mockGithub,
        '../services/accounts': mockAccounts,
        '../services/metadata': mockMetadata,
        '../services/thumbnails': mockThumbnails,
        '../services/backup-sync': mockBackupSync,
        '../services/cache': mockCache,
      }),
      '../services/metadata': mockMetadata,
      '../services/hls-convert': mockHlsConvert,
      '../services/backup-sync': mockBackupSync,
    });

    const express = require('express');
    app = express();
    app.use(express.json());
    app.use('/api/files', filesRoutes);
    request = require('supertest');
  });

  describe('POST /api/files/plan feedback', function () {
    it('should include storage feedback for upload planning', async function () {
      const res = await request(app)
        .post('/api/files/plan')
        .send({ size: 1000000, chunkSize: 200000 });

      expect(res.status).to.equal(200);
      expect(res.body.totalChunks).to.be.greaterThan(0);
      expect(res.body.feedback.storage.activeRepoCount).to.equal(1);
      expect(res.body.feedback.storage.availableRepoCount).to.equal(1);
      expect(res.body.feedback.storage.poolFull).to.equal(false);
    });
  });

  describe('GET /api/files/upload/session/:fileId/chunks', function () {
    it('should return empty indices for file with no chunks', async function () {
      const fileId = 'chunks-endpoint-empty';
      seedTestFile(db, userId, {
        id: fileId, name: 'empty.mp4', path: '/empty.mp4', size: 1000, chunk_count: 5,
        upload_status: 'uploading',
      });

      const res = await request(app).get(`/api/files/upload/session/${fileId}/chunks`);
      expect(res.status).to.equal(200);
      expect(res.body.fileId).to.equal(fileId);
      expect(res.body.indices).to.deep.equal([]);
      expect(res.body.count).to.equal(0);
    });

    it('should return all uploaded chunk indices', async function () {
      const fileId = 'chunks-endpoint-full';
      seedTestFile(db, userId, {
        id: fileId, name: 'full.mp4', path: '/full.mp4', size: 10000, chunk_count: 5,
        upload_status: 'uploading',
      });
      for (let i = 0; i < 5; i++) {
        db.prepare(`INSERT INTO chunks (file_id, chunk_index, repo_id, repo_path, sha, size) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(fileId, i, repoId, `.vault/chunks/${fileId}/${String(i).padStart(5, '0')}.bin`, `sha-${i}`, 2000);
      }

      const res = await request(app).get(`/api/files/upload/session/${fileId}/chunks`);
      expect(res.status).to.equal(200);
      expect(res.body.indices).to.deep.equal([0, 1, 2, 3, 4]);
      expect(res.body.count).to.equal(5);
    });

    it('should return only completed indices for partially uploaded file', async function () {
      const fileId = 'chunks-endpoint-partial';
      seedTestFile(db, userId, {
        id: fileId, name: 'partial.mp4', path: '/partial.mp4', size: 20000, chunk_count: 10,
        upload_status: 'uploading',
      });
      for (let i = 0; i < 4; i++) {
        db.prepare(`INSERT INTO chunks (file_id, chunk_index, repo_id, repo_path, sha, size) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(fileId, i, repoId, `.vault/chunks/${fileId}/${String(i).padStart(5, '0')}.bin`, `sha-${i}`, 2000);
      }

      const res = await request(app).get(`/api/files/upload/session/${fileId}/chunks`);
      expect(res.status).to.equal(200);
      expect(res.body.indices).to.deep.equal([0, 1, 2, 3]);
      expect(res.body.count).to.equal(4);
    });
  });

  describe('end-to-end small file upload', function () {
    this.timeout(15000);
    it('should complete a full upload lifecycle with a small file', async function () {
      const fileSize = 1000;
      const initRes = await request(app)
        .post('/api/files/upload/init')
        .send({ fileName: 'e2e-test.bin', size: fileSize, mimeType: 'application/octet-stream', parentPath: '/' });
      expect(initRes.status).to.equal(200);
      const { fileId, totalChunks, chunkSize, jobId } = initRes.body;
      expect(fileId).to.be.a('string');
      expect(totalChunks).to.equal(1);
      expect(chunkSize).to.be.greaterThan(0);

      const chunkRes = await request(app)
        .post('/api/files/upload/chunk')
        .attach('chunk', Buffer.alloc(fileSize), { filename: 'chunk-0', contentType: 'application/octet-stream' })
        .field('fileId', fileId)
        .field('chunkIndex', '0')
        .field('taskId', jobId)
        .field('uploadMode', 'api');
      expect(chunkRes.status).to.equal(200);
      expect(chunkRes.body.skipped).to.equal(false);
      expect(chunkRes.body.chunksDone).to.equal(1);

      const completeRes = await request(app)
        .post('/api/files/upload/complete')
        .field('fileId', fileId)
        .field('taskId', jobId)
        .field('uploadMode', 'api')
        .field('convertHls', '0');
      expect(completeRes.status).to.equal(200);
      expect(completeRes.body.id).to.equal(fileId);
      expect(completeRes.body.name).to.equal('e2e-test.bin');
      expect(completeRes.body.size).to.equal(fileSize);
    });

    it('should resume upload after session is marked as failed', async function () {
      const fileSize = 2000;
      const initRes = await request(app)
        .post('/api/files/upload/init')
        .send({ fileName: 'e2e-resume-failed.bin', size: fileSize, mimeType: 'application/octet-stream', parentPath: '/' });
      expect(initRes.status).to.equal(200);
      const { fileId, jobId } = initRes.body;

      // Manually mark as failed to simulate a previous failure
      const db = require('../../server/db/database');
      db.prepare('UPDATE files SET upload_status = ? WHERE id = ?').run('failed', fileId);

      // Init again - should find the failed session and resume
      const reinitRes = await request(app)
        .post('/api/files/upload/init')
        .send({ fileName: 'e2e-resume-failed.bin', size: fileSize, mimeType: 'application/octet-stream', parentPath: '/', fileId });
      expect(reinitRes.status).to.equal(200);
      expect(reinitRes.body.fileId).to.equal(fileId);

      // Upload chunk - should work because uploadPlainChunk now accepts 'failed' status
      const chunkRes = await request(app)
        .post('/api/files/upload/chunk')
        .attach('chunk', Buffer.alloc(fileSize), { filename: 'chunk-0', contentType: 'application/octet-stream' })
        .field('fileId', fileId)
        .field('chunkIndex', '0')
        .field('taskId', reinitRes.body.jobId)
        .field('uploadMode', 'api');
      expect(chunkRes.status).to.equal(200);
      expect(chunkRes.body.skipped).to.equal(false);

      // Complete
      const completeRes = await request(app)
        .post('/api/files/upload/complete')
        .field('fileId', fileId)
        .field('taskId', reinitRes.body.jobId)
        .field('uploadMode', 'api')
        .field('convertHls', '0');
      expect(completeRes.status).to.equal(200);
      expect(completeRes.body.id).to.equal(fileId);
    });
  });
});
