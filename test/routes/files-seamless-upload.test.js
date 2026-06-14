const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { createMemoryDb, seedTestUser, seedTestRepo } = require('../helpers/setup');
const path = require('path');
const fs = require('fs');

describe('Seamless upload routes', function () {
  let db;
  let request;
  let app;
  let userId;
  let uploadDir;
  let seamlessDir;
  let testCounter = 0;

  function uniqueName(base) {
    testCounter += 1;
    return `${base}-${testCounter}-${Date.now()}.bin`;
  }

  before(function () {
    db = createMemoryDb();
    const user = seedTestUser(db, { github_id: 'seamless-test-user', username: 'seamlesstest', master_key: 'x'.repeat(44) });
    userId = user.id;
    seedTestRepo(db, userId, { full_name: 'test/seamlessrepo', default_branch: 'main' });
    uploadDir = path.join(__dirname, '../../uploads');
    seamlessDir = path.join(__dirname, '../../data/seamless-uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    if (!fs.existsSync(seamlessDir)) fs.mkdirSync(seamlessDir, { recursive: true });

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

    const mockStorage = proxyquire('../../server/services/storage', {
      '../db/database': db,
      '../services/crypto': mockCrypto,
      '../services/github': mockGithub,
      '../services/accounts': mockAccounts,
      '../services/metadata': mockMetadata,
      '../services/thumbnails': mockThumbnails,
      '../services/backup-sync': mockBackupSync,
      '../services/cache': mockCache,
    });

    const mockSeamless = proxyquire('../../server/services/seamless-upload', {
      '../db/database': db,
      './storage': mockStorage,
      './tasks': proxyquire('../../server/services/tasks', { '../db/database': db }),
    });

    const filesRoutes = proxyquire('../../server/routes/files', {
      '../db/database': db,
      '../middleware/auth': mockAuth,
      '../middleware/setup': mockSetup,
      '../services/storage': mockStorage,
      '../services/seamless-upload': mockSeamless,
      '../services/tasks': proxyquire('../../server/services/tasks', { '../db/database': db }),
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

  afterEach(function () {
    db.prepare('DELETE FROM chunks').run();
    db.prepare('DELETE FROM files').run();
    db.prepare('DELETE FROM tasks').run();
    if (fs.existsSync(seamlessDir)) {
      for (const userDir of fs.readdirSync(seamlessDir)) {
        const full = path.join(seamlessDir, userDir);
        if (fs.statSync(full).isDirectory()) fs.rmSync(full, { recursive: true, force: true });
      }
    }
  });

  describe('POST /api/files/upload/seamless/init', function () {
    it('should create seamless session with staging file and task', async function () {
      const res = await request(app)
        .post('/api/files/upload/seamless/init')
        .send({
          fileName: uniqueName('seamless'),
          size: 5000,
          mimeType: 'application/octet-stream',
          parentPath: '/',
          chunkSize: 65536,
        });

      expect(res.status).to.equal(200);
      expect(res.body.fileId).to.be.a('string');
      expect(res.body.jobId).to.be.a('string');
      expect(res.body.uploadMode).to.equal('seamless');
      expect(res.body.totalParts).to.be.greaterThan(0);
      expect(res.body.partSize).to.be.greaterThan(0);

      const staging = path.join(seamlessDir, String(userId), res.body.fileId, 'source');
      expect(fs.existsSync(staging)).to.equal(true);
      expect(fs.statSync(staging).size).to.equal(5000);
    });
  });

  describe('POST /api/files/upload/seamless/part', function () {
    it('should write parts to staging and track progress', async function () {
      const fileSize = 3000;
      const initRes = await request(app)
        .post('/api/files/upload/seamless/init')
        .send({
          fileName: uniqueName('parts'),
          size: fileSize,
          mimeType: 'application/octet-stream',
          parentPath: '/',
          chunkSize: 65536,
        });
      const { fileId, jobId, totalParts } = initRes.body;

      const part0 = Buffer.alloc(fileSize, 1);
      const partRes = await request(app)
        .post('/api/files/upload/seamless/part')
        .attach('part', part0, { filename: 'part-0', contentType: 'application/octet-stream' })
        .field('fileId', fileId)
        .field('partIndex', '0')
        .field('taskId', jobId);

      expect(partRes.status).to.equal(200);
      expect(partRes.body.skipped).to.equal(false);
      expect(partRes.body.partsDone).to.equal(1);
      expect(partRes.body.totalParts).to.equal(totalParts);

      const dupRes = await request(app)
        .post('/api/files/upload/seamless/part')
        .attach('part', part0, { filename: 'part-0', contentType: 'application/octet-stream' })
        .field('fileId', fileId)
        .field('partIndex', '0')
        .field('taskId', jobId);

      expect(dupRes.status).to.equal(200);
      expect(dupRes.body.skipped).to.equal(true);
      expect(dupRes.body.partsDone).to.equal(1);
    });
  });

  describe('GET /api/files/upload/seamless/status/:fileId', function () {
    it('should report missing parts and staging progress', async function () {
      const fileSize = 4000;
      const initRes = await request(app)
        .post('/api/files/upload/seamless/init')
        .send({
          fileName: uniqueName('status'),
          size: fileSize,
          mimeType: 'application/octet-stream',
          parentPath: '/',
          chunkSize: 65536,
        });
      const { fileId, jobId } = initRes.body;

      const statusRes = await request(app).get(`/api/files/upload/seamless/status/${fileId}`);
      expect(statusRes.status).to.equal(200);
      expect(statusRes.body.partsDone).to.equal(0);
      expect(statusRes.body.stagingComplete).to.equal(false);
      expect(statusRes.body.missingParts).to.deep.equal([0]);
      expect(statusRes.body.taskId).to.equal(jobId);
    });
  });

  describe('POST /api/files/upload/seamless/complete', function () {
    this.timeout(15000);

    it('should accept complete when staging is full and start processing', async function () {
      const fileSize = 1000;
      const initRes = await request(app)
        .post('/api/files/upload/seamless/init')
        .send({
          fileName: uniqueName('complete'),
          size: fileSize,
          mimeType: 'application/octet-stream',
          parentPath: '/',
          chunkSize: 65536,
        });
      const { fileId, jobId } = initRes.body;

      const partRes = await request(app)
        .post('/api/files/upload/seamless/part')
        .attach('part', Buffer.alloc(fileSize, 9), { filename: 'part-0' })
        .field('fileId', fileId)
        .field('partIndex', '0')
        .field('taskId', jobId);
      expect(partRes.status).to.equal(200);

      const completeRes = await request(app)
        .post('/api/files/upload/seamless/complete')
        .send({ fileId, taskId: jobId, convertHls: '0' });

      expect(completeRes.status).to.equal(200);
      expect(completeRes.body.success).to.equal(true);
      expect(completeRes.body.processing).to.equal(true);
    });
  });

  describe('POST /api/files/upload/seamless/resume', function () {
    it('should reject resume when staging is incomplete', async function () {
      const initRes = await request(app)
        .post('/api/files/upload/seamless/init')
        .send({
          fileName: uniqueName('resume-partial'),
          size: 2000,
          mimeType: 'application/octet-stream',
          parentPath: '/',
          chunkSize: 65536,
        });
      const { fileId, jobId } = initRes.body;

      const res = await request(app)
        .post('/api/files/upload/seamless/resume')
        .send({ fileId, taskId: jobId });

      expect(res.status).to.equal(400);
      expect(res.body.error).to.include('not fully cached');
      expect(res.body.missingParts).to.be.an('array');
    });

    it('should kick processing when staging is complete', async function () {
      const fileSize = 800;
      const initRes = await request(app)
        .post('/api/files/upload/seamless/init')
        .send({
          fileName: uniqueName('resume-full'),
          size: fileSize,
          mimeType: 'application/octet-stream',
          parentPath: '/',
          chunkSize: 65536,
        });
      const { fileId, jobId } = initRes.body;

      await request(app)
        .post('/api/files/upload/seamless/part')
        .attach('part', Buffer.alloc(fileSize, 3), { filename: 'part-0' })
        .field('fileId', fileId)
        .field('partIndex', '0')
        .field('taskId', jobId);

      const res = await request(app)
        .post('/api/files/upload/seamless/resume')
        .send({ fileId, taskId: jobId });

      expect(res.status).to.equal(200);
      expect(res.body.success).to.equal(true);
      expect(res.body.processing).to.equal(true);
    });
  });
});
