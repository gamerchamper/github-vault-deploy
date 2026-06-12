const { expect } = require('chai');
const sinon = require('sinon');
const nock = require('nock');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { VaultApi } = require('../src/api');
const { UploadEngine } = require('../src/upload-engine');
const { SessionStore } = require('../src/session-store');
const { SESSION_DIR, CONFIG_DIR } = require('../src/config');

describe('UploadEngine', function () {
  const BASE = 'https://vault.test';
  const COOKIE = 'vault.sid=test';
  let api;
  let engine;
  let testFileBuffer;
  let testFilePath;
  let testFileName;

  beforeEach(function () {
    nock.cleanAll();
    if (fs.existsSync(SESSION_DIR)) {
      for (const f of fs.readdirSync(SESSION_DIR)) {
        fs.unlinkSync(path.join(SESSION_DIR, f));
      }
    }
    if (fs.existsSync(CONFIG_DIR)) {
      for (const f of fs.readdirSync(CONFIG_DIR)) {
        if (f.endsWith('.json')) fs.unlinkSync(path.join(CONFIG_DIR, f));
      }
    }

    api = new VaultApi(BASE, COOKIE);

    testFileName = `vault-upload-test-${Date.now()}.bin`;
    testFilePath = path.join(os.tmpdir(), testFileName);
    testFileBuffer = Buffer.alloc(50000, 0x42);
    fs.writeFileSync(testFilePath, testFileBuffer);

    engine = new UploadEngine(api, {
      concurrency: 3,
      onProgress: () => {},
      onLog: () => {},
    });
  });

  afterEach(function () {
    nock.cleanAll();
    try { fs.unlinkSync(testFilePath); } catch {}
  });

  describe('_computeChunkSize', function () {
    it('should use 1MB for files < 50MB', function () {
      expect(engine._computeChunkSize(10 * 1024 * 1024)).to.equal(1024 * 1024);
    });
    it('should use 2MB for files 50-500MB', function () {
      expect(engine._computeChunkSize(100 * 1024 * 1024)).to.equal(2 * 1024 * 1024);
    });
    it('should use 5MB for files 500MB-2GB', function () {
      expect(engine._computeChunkSize(1024 * 1024 * 1024)).to.equal(5 * 1024 * 1024);
    });
    it('should use 10MB for files > 2GB', function () {
      expect(engine._computeChunkSize(3 * 1024 * 1024 * 1024)).to.equal(10 * 1024 * 1024);
    });
  });

  describe('initSession', function () {
    it('should create session and call uploadInit', async function () {
      const taskId = 'test-init-task';

      nock(BASE).post(`/api/tasks/${taskId}/resume`, {}).reply(200, { id: taskId, status: 'processing' });

      nock(BASE)
        .post('/api/files/upload/init', (body) => {
          return body.fileName === testFileName && body.size === 50000;
        })
        .reply(200, { fileId: 'file-init-1', jobId: taskId, totalChunks: 1, chunkSize: 921600, chunksDone: 0, nextChunk: 0 });

      const result = await engine.initSession(testFilePath, '/', null, taskId);
      expect(result.fileId).to.equal('file-init-1');
      expect(result.totalChunks).to.equal(1);
      expect(engine.session.taskId).to.equal(taskId);
      expect(engine.session.fileId).to.equal('file-init-1');
      expect(engine.session.status).to.equal('uploading');
    });

    it('should retry init on failure with backoff', async function () {
      const taskId = 'test-retry-task';

      nock(BASE).post(`/api/tasks/${taskId}/resume`, {}).reply(200, { id: taskId, status: 'processing' });

      nock(BASE)
        .post('/api/files/upload/init')
        .reply(500, { error: 'Server error' })
        .post('/api/files/upload/init')
        .reply(200, { fileId: 'file-retry', jobId: taskId, totalChunks: 1, chunkSize: 921600, chunksDone: 0, nextChunk: 0 });

      const result = await engine.initSession(testFilePath, '/', null, taskId);
      expect(result.fileId).to.equal('file-retry');
    });

    it('should not retry permanent init failures', async function () {
      const taskId = 'test-init-permanent-failure';

      nock(BASE).post(`/api/tasks/${taskId}/resume`, {}).reply(200, { id: taskId, status: 'processing' });
      const scope = nock(BASE)
        .post('/api/files/upload/init')
        .once()
        .reply(400, { error: 'HLS conversion requires FFmpeg on the server' });

      try {
        await engine.initSession(testFilePath, '/', null, taskId);
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('HLS conversion requires FFmpeg');
      }
      scope.done();
    });
  });

  describe('resumeSession', function () {
    it('should load local session and init with existing fileId', async function () {
      const taskId = 'test-resume-task';
      const session = SessionStore.create(taskId, {
        name: testFileName,
        path: testFilePath,
        size: 50000,
        mimeType: 'application/octet-stream',
        parentPath: '/',
        chunkSize: 921600,
      });
      session.fileId = 'file-resume-1';
      session.totalChunks = 3;
      session.chunksDone = 1;
      session.status = 'error';
      SessionStore.save(session);

      nock(BASE).post(`/api/tasks/${taskId}/resume`, {}).reply(200, { id: taskId, status: 'processing' });
      nock(BASE)
        .post('/api/files/upload/init', (body) => body.fileId === 'file-resume-1')
        .reply(200, { fileId: 'file-resume-1', jobId: taskId, totalChunks: 3, chunkSize: 921600, chunksDone: 1, nextChunk: 1 });

      const result = await engine.resumeSession(taskId);
      expect(result.chunksDone).to.equal(1);
      expect(result.nextChunk).to.equal(1);
    });

    it('should throw when local session not found', async function () {
      try {
        await engine.resumeSession('nonexistent-task');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err.message).to.include('No local session found');
      }
    });
  });

  describe('uploadAll', function () {
    it('should upload all chunks and complete', async function () {
      const taskId = 'test-full-flow';

      nock(BASE).post(`/api/tasks/${taskId}/resume`, {}).reply(200, { id: taskId, status: 'processing' });
      nock(BASE)
        .post('/api/files/upload/init')
        .reply(200, { fileId: 'file-full', jobId: taskId, totalChunks: 3, chunkSize: 20000, chunksDone: 0, nextChunk: 0 });
      await engine.initSession(testFilePath, '/', null, taskId);

      nock(BASE)
        .post('/api/files/upload/chunk')
        .times(3)
        .reply(200, { skipped: false, chunksDone: 1, totalChunks: 3, nextChunk: 1 });
      nock(BASE)
        .post('/api/files/upload/complete')
        .reply(200, { id: 'file-full', name: 'test.bin', size: 50000, chunks: 3, encrypted: true });

      const result = await engine.uploadAll();
      expect(result.id).to.equal('file-full');
      expect(SessionStore.get(taskId)).to.be.null;
    });

    it('should skip already-uploaded chunks and upload the rest', async function () {
      const taskId = 'test-partial-resume';

      nock(BASE).post(`/api/tasks/${taskId}/resume`, {}).reply(200, { id: taskId, status: 'processing' });
      nock(BASE)
        .post('/api/files/upload/init')
        .reply(200, { fileId: 'file-partial', jobId: taskId, totalChunks: 3, chunkSize: 20000, chunksDone: 1, nextChunk: 1 });
      await engine.initSession(testFilePath, '/', null, taskId);

      nock(BASE)
        .post('/api/files/upload/chunk')
        .times(2)
        .reply(200, { skipped: false, chunksDone: 1, totalChunks: 3, nextChunk: 1 });
      nock(BASE)
        .post('/api/files/upload/complete')
        .reply(200, { id: 'file-partial', name: 'test.bin', size: 50000, chunks: 3 });

      const result = await engine.uploadAll();
      expect(result.id).to.equal('file-partial');
    });

    it('should retry failed chunks', async function () {
      const taskId = 'test-chunk-retry';
      engine = new UploadEngine(api, {
        concurrency: 1, retryDelayMs: 1, maxRetryDelayMs: 10,
        onProgress: () => {}, onLog: () => {},
      });

      nock(BASE).post(`/api/tasks/${taskId}/resume`, {}).reply(200, { id: taskId, status: 'processing' });
      nock(BASE)
        .post('/api/files/upload/init')
        .reply(200, { fileId: 'file-retry-chunk', jobId: taskId, totalChunks: 2, chunkSize: 30000, chunksDone: 0, nextChunk: 0 });
      await engine.initSession(testFilePath, '/', null, taskId);

      nock(BASE)
        .post('/api/files/upload/chunk')
        .reply(500, { error: 'Server error' })
        .post('/api/files/upload/chunk')
        .reply(200, { skipped: false, chunksDone: 1, totalChunks: 2, nextChunk: 1 });
      nock(BASE)
        .post('/api/files/upload/chunk')
        .reply(200, { skipped: false, chunksDone: 2, totalChunks: 2, nextChunk: 2 });
      nock(BASE)
        .post('/api/files/upload/complete')
        .reply(200, { id: 'file-retry-chunk', name: 'test.bin', size: 50000, chunks: 2 });

      const result = await engine.uploadAll();
      expect(result.id).to.equal('file-retry-chunk');
    });

    it('should wait and resume chunks after transient server failures', async function () {
      const taskId = 'test-chunk-offline-resume';
      engine = new UploadEngine(api, {
        concurrency: 1,
        maxRetriesPerChunk: 3,
        retryDelayMs: 1,
        maxRetryDelayMs: 1,
        onProgress: () => {},
        onLog: () => {},
      });

      nock(BASE).post(`/api/tasks/${taskId}/resume`, {}).reply(200, { id: taskId, status: 'processing' });
      nock(BASE)
        .post('/api/files/upload/init')
        .reply(200, { fileId: 'file-offline-resume', jobId: taskId, totalChunks: 1, chunkSize: 50000, chunksDone: 0, nextChunk: 0 });
      await engine.initSession(testFilePath, '/', null, taskId);

      nock(BASE)
        .post('/api/files/upload/chunk')
        .reply(503, { error: 'Server unavailable' })
        .post('/api/files/upload/chunk')
        .reply(200, { skipped: false, chunksDone: 1, totalChunks: 1, nextChunk: 1 });
      nock(BASE)
        .post('/api/files/upload/complete')
        .reply(200, { id: 'file-offline-resume', name: 'test.bin', size: 50000, chunks: 1 });

      const result = await engine.uploadAll();
      expect(result.id).to.equal('file-offline-resume');
      expect(SessionStore.get(taskId)).to.be.null;
    });

    it('should re-init session on Upload session not found and retry', async function () {
      const taskId = 'test-reinit-on-session-not-found';
      engine = new UploadEngine(api, {
        concurrency: 1,
        maxRetriesPerChunk: 3,
        retryDelayMs: 1,
        maxRetryDelayMs: 1,
        onProgress: () => {},
        onLog: () => {},
      });

      nock(BASE).post(`/api/tasks/${taskId}/resume`, {}).reply(200, { id: taskId, status: 'processing' });
      nock(BASE)
        .post('/api/files/upload/init')
        .reply(200, { fileId: 'file-reinit', jobId: taskId, totalChunks: 1, chunkSize: 50000, chunksDone: 0, nextChunk: 0 });
      await engine.initSession(testFilePath, '/', null, taskId);

      nock(BASE)
        .post('/api/files/upload/chunk')
        .reply(500, { error: 'Upload session not found' });

      nock(BASE).post(`/api/tasks/${taskId}/resume`, {}).reply(200, { id: taskId, status: 'processing' });
      nock(BASE)
        .post('/api/files/upload/init', (body) => body.fileId === 'file-reinit')
        .reply(200, { fileId: 'file-reinit', jobId: taskId, totalChunks: 1, chunkSize: 50000, chunksDone: 0, nextChunk: 0 });

      nock(BASE)
        .post('/api/files/upload/chunk')
        .reply(200, { skipped: false, chunksDone: 1, totalChunks: 1, nextChunk: 1 });
      nock(BASE)
        .post('/api/files/upload/complete')
        .reply(200, { id: 'file-reinit', name: 'test.bin', size: 50000, chunks: 1 });

      const result = await engine.uploadAll();
      expect(result.id).to.equal('file-reinit');
      expect(SessionStore.get(taskId)).to.be.null;
    });

    it('should surface server storage feedback warnings once', async function () {
      const taskId = 'test-feedback-warning';
      const logs = [];
      engine = new UploadEngine(api, {
        concurrency: 1,
        onProgress: () => {},
        onLog: (message) => logs.push(message),
      });

      nock(BASE).post(`/api/tasks/${taskId}/resume`, {}).reply(200, { id: taskId, status: 'processing' });
      nock(BASE)
        .post('/api/files/upload/init')
        .reply(200, {
          fileId: 'file-feedback', jobId: taskId, totalChunks: 1, chunkSize: 50000, chunksDone: 0, nextChunk: 0,
          feedback: { storage: { warnings: ['Storage pool is almost full.'] } },
        });
      await engine.initSession(testFilePath, '/', null, taskId);

      nock(BASE)
        .post('/api/files/upload/chunk')
        .reply(200, {
          skipped: false, chunksDone: 1, totalChunks: 1, nextChunk: 1,
          feedback: { storage: { warnings: ['Storage pool is almost full.'] } },
        });
      nock(BASE)
        .post('/api/files/upload/complete')
        .reply(200, { id: 'file-feedback', name: 'test.bin', size: 50000, chunks: 1 });

      const result = await engine.uploadAll();
      expect(result.id).to.equal('file-feedback');
      expect(logs.filter(l => l.includes('Storage pool is almost full.'))).to.have.length(1);
    });

    it('should wait and retry complete after transient server failures', async function () {
      const taskId = 'test-complete-offline-resume';
      engine = new UploadEngine(api, {
        concurrency: 1,
        retryDelayMs: 1,
        maxRetryDelayMs: 1,
        onProgress: () => {},
        onLog: () => {},
      });

      nock(BASE).post(`/api/tasks/${taskId}/resume`, {}).reply(200, { id: taskId, status: 'processing' });
      nock(BASE)
        .post('/api/files/upload/init')
        .reply(200, { fileId: 'file-complete-resume', jobId: taskId, totalChunks: 1, chunkSize: 50000, chunksDone: 0, nextChunk: 0 });
      await engine.initSession(testFilePath, '/', null, taskId);

      nock(BASE)
        .post('/api/files/upload/chunk')
        .reply(200, { skipped: false, chunksDone: 1, totalChunks: 1, nextChunk: 1 });
      nock(BASE)
        .post('/api/files/upload/complete')
        .reply(502, { error: 'Gateway down' })
        .post('/api/files/upload/complete')
        .reply(200, { id: 'file-complete-resume', name: 'test.bin', size: 50000, chunks: 1 });

      const result = await engine.uploadAll();
      expect(result.id).to.equal('file-complete-resume');
      expect(SessionStore.get(taskId)).to.be.null;
    });

    it('should handle many concurrent chunks with intermittent transient failures', async function () {
      const taskId = 'test-high-pressure-upload';
      const totalChunks = 50;
      engine = new UploadEngine(api, {
        concurrency: 20,
        maxRetriesPerChunk: 5,
        retryDelayMs: 1,
        maxRetryDelayMs: 1,
        onProgress: () => {},
        onLog: () => {},
      });

      nock(BASE).post(`/api/tasks/${taskId}/resume`, {}).reply(200, { id: taskId, status: 'processing' });
      nock(BASE)
        .post('/api/files/upload/init')
        .reply(200, { fileId: 'file-high-pressure', jobId: taskId, totalChunks, chunkSize: 1000, chunksDone: 0, nextChunk: 0 });
      await engine.initSession(testFilePath, '/', null, taskId);

      let requests = 0;
      let successes = 0;
      nock(BASE)
        .persist()
        .post('/api/files/upload/chunk')
        .reply(function () {
          requests++;
          if (requests % 11 === 0 || requests % 17 === 0) {
            return [503, { error: 'Temporary overload' }];
          }
          successes++;
          return [200, { skipped: false, chunksDone: successes, totalChunks, nextChunk: successes }];
        });
      nock(BASE)
        .post('/api/files/upload/complete')
        .reply(200, { id: 'file-high-pressure', name: 'test.bin', size: 50000, chunks: totalChunks });

      const result = await engine.uploadAll();
      expect(result.id).to.equal('file-high-pressure');
      expect(successes).to.equal(totalChunks);
      expect(requests).to.be.greaterThan(totalChunks);
      expect(SessionStore.get(taskId)).to.be.null;
    });

    it('should stop and save session on abort', async function () {
      const taskId = 'test-abort';

      nock(BASE).post(`/api/tasks/${taskId}/resume`, {}).reply(200, { id: taskId, status: 'processing' });
      nock(BASE)
        .post('/api/files/upload/init')
        .reply(200, { fileId: 'file-abort', jobId: taskId, totalChunks: 10, chunkSize: 5000, chunksDone: 0, nextChunk: 0 });
      await engine.initSession(testFilePath, '/', null, taskId);

      let uploadCount = 0;
      const scope = nock(BASE)
        .post('/api/files/upload/chunk')
        .times(10)
        .reply(200, function () {
          uploadCount++;
          if (uploadCount === 3) engine.abort();
          return { skipped: false, chunksDone: uploadCount, totalChunks: 10, nextChunk: uploadCount };
        });

      const result = await engine.uploadAll();
      expect(result).to.be.null;
      expect(engine.session.status).to.equal('paused');
      expect(SessionStore.get(taskId).status).to.equal('paused');
    });

    it('should stop when server returns 409 (paused)', async function () {
      const taskId = 'test-409';

      nock(BASE).post(`/api/tasks/${taskId}/resume`, {}).reply(200, { id: taskId, status: 'processing' });
      nock(BASE)
        .post('/api/files/upload/init')
        .reply(200, { fileId: 'file-409', jobId: taskId, totalChunks: 10, chunkSize: 5000, chunksDone: 0, nextChunk: 0 });
      await engine.initSession(testFilePath, '/', null, taskId);

      let count = 0;
      // Use persist so all parallel in-flight chunks get a response
      nock(BASE)
        .post('/api/files/upload/chunk')
        .times(10)
        .reply(function () {
          count++;
          if (count === 2) {
            return [409, { error: 'Upload is paused — click Resume to continue' }];
          }
          return [200, { skipped: false, chunksDone: count, totalChunks: 10, nextChunk: count }];
        });

      const result = await engine.uploadAll();
      expect(result).to.be.null;
      expect(engine.session.status).to.equal('paused');
    });

    it('should skip to complete when all chunks already done', async function () {
      const taskId = 'test-already-done';

      nock(BASE).post(`/api/tasks/${taskId}/resume`, {}).reply(200, { id: taskId, status: 'processing' });
      nock(BASE)
        .post('/api/files/upload/init')
        .reply(200, { fileId: 'file-done', jobId: taskId, totalChunks: 3, chunkSize: 20000, chunksDone: 3, nextChunk: 3 });
      await engine.initSession(testFilePath, '/', null, taskId);

      nock(BASE).post('/api/files/upload/complete').reply(200, { id: 'file-done', name: 'test.bin', size: 50000, chunks: 3 });

      const result = await engine.uploadAll();
      expect(result.id).to.equal('file-done');
    });
  });

  describe('_guessMimeType', function () {
    it('should detect video/mp4', function () {
      expect(engine._guessMimeType('video.mp4')).to.equal('video/mp4');
    });
    it('should detect image/png', function () {
      expect(engine._guessMimeType('photo.png')).to.equal('image/png');
    });
    it('should return default for unknown', function () {
      expect(engine._guessMimeType('file.xyz')).to.equal('application/octet-stream');
    });
  });

  describe('abort', function () {
    it('should set _aborted flag', function () {
      engine.abort();
      expect(engine._aborted).to.be.true;
    });
  });
});
