const { expect } = require('chai');
const nock = require('nock');
const { VaultApi, VaultApiError } = require('../src/api');

describe('VaultApi', function () {
  const BASE = 'https://vault.test';
  const COOKIE = 'vault.sid=test-session';
  let api;

  beforeEach(function () {
    api = new VaultApi(BASE, COOKIE);
    nock.cleanAll();
  });

  afterEach(function () {
    nock.cleanAll();
  });

  describe('constructor', function () {
    it('should strip trailing slash from baseUrl', function () {
      const a = new VaultApi('https://vault.test/', COOKIE);
      expect(a.baseUrl).to.equal('https://vault.test');
    });

    it('should set default headers with cookie', function () {
      expect(api.defaultHeaders.Cookie).to.equal(COOKIE);
    });

    it('should prefer bearer authorization when apiKey is provided', async function () {
      const apiKeyClient = new VaultApi(BASE, { apiKey: 'gv_test_key' });
      const scope = nock(BASE, {
        reqheaders: { authorization: 'Bearer gv_test_key' },
      }).get('/api/tasks/').query({ active: '1', resumable: '1' }).reply(200, { tasks: [] });

      expect(await apiKeyClient.checkAuth()).to.equal(true);
      scope.done();
    });
  });

  describe('api keys', function () {
    it('should create API keys', async function () {
      const scope = nock(BASE)
        .post('/auth/api-keys', { name: 'CLI key' })
        .reply(201, { key: { id: 1, name: 'CLI key', key: 'gv_created' } });

      const result = await api.createApiKey('CLI key');
      expect(result.key.key).to.equal('gv_created');
      scope.done();
    });
  });

  describe('plan', function () {
    it('should POST /api/files/plan with size and chunkSize', async function () {
      const scope = nock(BASE)
        .post('/api/files/plan', { size: 1000000, chunkSize: 921600 })
        .reply(200, { totalChunks: 2, chunkSize: 921600 });

      const result = await api.plan(1000000, 921600);
      expect(result.totalChunks).to.equal(2);
      scope.done();
    });
  });

  describe('uploadInit', function () {
    it('should POST /api/files/upload/init with all fields', async function () {
      const scope = nock(BASE)
        .post('/api/files/upload/init', (body) => {
          return body.fileName === 'test.mp4' && body.size === 1000 && body.fileId === undefined;
        })
        .reply(200, { fileId: 'abc', jobId: 'task-1', totalChunks: 2, chunksDone: 0, nextChunk: 0 });

      const result = await api.uploadInit({
        fileName: 'test.mp4', parentPath: '/', size: 1000, mimeType: 'video/mp4',
      });
      expect(result.fileId).to.equal('abc');
      expect(result.jobId).to.equal('task-1');
      scope.done();
    });

    it('should include fileId and taskId when provided', async function () {
      const scope = nock(BASE)
        .post('/api/files/upload/init', (body) => {
          return body.fileId === 'existing-file' && body.taskId === 'existing-task';
        })
        .reply(200, { fileId: 'existing-file', jobId: 'existing-task', totalChunks: 5, chunksDone: 3, nextChunk: 3 });

      const result = await api.uploadInit({
        fileName: 'resume.mp4', parentPath: '/', size: 5000, mimeType: 'video/mp4',
        fileId: 'existing-file', taskId: 'existing-task',
      });
      expect(result.chunksDone).to.equal(3);
      scope.done();
    });
  });

  describe('uploadChunk', function () {
    it('should POST multipart with chunk data', async function () {
      const scope = nock(BASE)
        .post('/api/files/upload/chunk', (body) => Buffer.isBuffer(body) || typeof body === 'string')
        .reply(200, { skipped: false, chunksDone: 1, totalChunks: 10, nextChunk: 1 });

      const buf = Buffer.alloc(1000);
      const result = await api.uploadChunk('file-1', 0, buf, 'task-1', 'api');
      expect(result.skipped).to.be.false;
      expect(result.chunksDone).to.equal(1);
      scope.done();
    });

    it('should return skipped:true for duplicate chunks', async function () {
      const scope = nock(BASE)
        .post('/api/files/upload/chunk')
        .reply(200, { skipped: true, chunksDone: 5, totalChunks: 10, nextChunk: 5 });

      const result = await api.uploadChunk('file-1', 3, Buffer.alloc(100), 'task-1', 'api');
      expect(result.skipped).to.be.true;
      scope.done();
    });
  });

  describe('uploadComplete', function () {
    it('should POST multipart and return result', async function () {
      const scope = nock(BASE)
        .post('/api/files/upload/complete')
        .reply(200, { id: 'file-1', name: 'test.mp4', size: 1000, chunks: 2, encrypted: true });

      const result = await api.uploadComplete('file-1', 'task-1', null, 'api', false);
      expect(result.id).to.equal('file-1');
      expect(result.encrypted).to.be.true;
      scope.done();
    });
  });

  describe('uploadCancel', function () {
    it('should POST /api/files/upload/cancel', async function () {
      const scope = nock(BASE)
        .post('/api/files/upload/cancel', { fileId: 'file-1', taskId: 'task-1' })
        .reply(200, { success: true });

      const result = await api.uploadCancel('file-1', 'task-1');
      expect(result.success).to.be.true;
      scope.done();
    });
  });

  describe('getSession', function () {
    it('should GET session details', async function () {
      const scope = nock(BASE)
        .get('/api/files/upload/session/file-1')
        .reply(200, { fileId: 'file-1', fileName: 'test.mp4', chunksDone: 5, totalChunks: 10 });

      const result = await api.getSession('file-1');
      expect(result.chunksDone).to.equal(5);
      scope.done();
    });
  });

  describe('getChunks', function () {
    it('should GET chunk indices', async function () {
      const scope = nock(BASE)
        .get('/api/files/upload/session/file-1/chunks')
        .reply(200, { fileId: 'file-1', indices: [0, 1, 2], count: 3 });

      const result = await api.getChunks('file-1');
      expect(result.indices).to.deep.equal([0, 1, 2]);
      scope.done();
    });
  });

  describe('tasks', function () {
    it('should GET /api/tasks/:id', async function () {
      const scope = nock(BASE)
        .get('/api/tasks/task-1')
        .reply(200, { id: 'task-1', status: 'processing', chunksDone: 5, chunksTotal: 10 });

      const result = await api.getTask('task-1');
      expect(result.status).to.equal('processing');
      scope.done();
    });

    it('should POST /api/tasks/:id/resume', async function () {
      const scope = nock(BASE)
        .post('/api/tasks/task-1/resume', {})
        .reply(200, { id: 'task-1', status: 'processing' });

      const result = await api.resumeTask('task-1');
      expect(result.status).to.equal('processing');
      scope.done();
    });

    it('should POST /api/tasks/:id/pause', async function () {
      const scope = nock(BASE)
        .post('/api/tasks/task-1/pause', { reason: 'Test pause' })
        .reply(200, { id: 'task-1', status: 'paused' });

      const result = await api.pauseTask('task-1', 'Test pause');
      expect(result.status).to.equal('paused');
      scope.done();
    });
  });

  describe('error handling', function () {
    it('should throw VaultApiError on non-2xx', async function () {
      nock(BASE).get('/api/tasks/task-1').reply(404, { error: 'Not found' });

      try {
        await api.getTask('task-1');
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(VaultApiError);
        expect(err.status).to.equal(404);
        expect(err.message).to.include('Not found');
      }
    });

    it('should throw descriptive 401 error', async function () {
      nock(BASE).get('/api/tasks/?active=1&resumable=0').reply(401, { error: 'Not authenticated' });

      try {
        await api.listTasks();
        expect.fail('Should have thrown');
      } catch (err) {
        expect(err).to.be.instanceOf(VaultApiError);
        expect(err.status).to.equal(401);
        expect(err.message).to.include('Not authenticated');
      }
    });

    it('should retry transient 503 errors for JSON requests', async function () {
      const scope = nock(BASE)
        .get('/api/tasks/task-1')
        .reply(503, { error: 'Unavailable' })
        .get('/api/tasks/task-1')
        .reply(200, { id: 'task-1', status: 'processing' });

      const result = await api.getTask('task-1');
      expect(result.status).to.equal('processing');
      scope.done();
    });
  });

  describe('checkAuth', function () {
    it('should return true when authenticated', async function () {
      nock(BASE).get('/api/tasks/?active=1&resumable=1').reply(200, { tasks: [] });
      expect(await api.checkAuth()).to.be.true;
    });

    it('should return false when not authenticated', async function () {
      nock(BASE).get('/api/tasks/?active=1&resumable=1').reply(401);
      expect(await api.checkAuth()).to.be.false;
    });
  });
});
