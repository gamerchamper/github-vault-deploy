const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { createMemoryDb, seedTestUser, seedTestFile, seedTestRepo } = require('../helpers/setup');

describe('Storage service (upload session)', function () {
  let db;
  let userId;
  let repoId;
  let storage;

  before(function () {
    db = createMemoryDb();
    const user = seedTestUser(db, { github_id: 'storage-test', username: 'storagetest', master_key: 'x'.repeat(44) });
    userId = user.id;
    const repo = seedTestRepo(db, userId, { full_name: 'test/storagerepo', default_branch: 'main' });
    repoId = repo.id;

    storage = proxyquire('../../server/services/storage', {
      '../db/database': db,
    });
  });

  describe('getUploadedChunkIndices', function () {
    it('should return empty array for file with no chunks', function () {
      seedTestFile(db, userId, {
        id: 'indices-empty',
        name: 'empty.mp4', path: '/empty.mp4', size: 1000, chunk_count: 5,
      });
      expect(storage.getUploadedChunkIndices('indices-empty')).to.deep.equal([]);
    });

    it('should return all chunk indices in order', function () {
      const fileId = 'indices-full';
      seedTestFile(db, userId, {
        id: fileId, name: 'full.mp4', path: '/full.mp4', size: 10000, chunk_count: 5,
      });
      for (let i = 0; i < 5; i++) {
        db.prepare(`INSERT INTO chunks (file_id, chunk_index, repo_id, repo_path, sha, size) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(fileId, i, repoId, `.vault/chunks/${fileId}/${String(i).padStart(5, '0')}.bin`, `sha-${i}`, 2000);
      }
      expect(storage.getUploadedChunkIndices(fileId)).to.deep.equal([0, 1, 2, 3, 4]);
    });

    it('should return correct indices for non-contiguous chunks', function () {
      const fileId = 'indices-gap';
      seedTestFile(db, userId, {
        id: fileId, name: 'gap.mp4', path: '/gap.mp4', size: 10000, chunk_count: 10,
      });
      for (const idx of [0, 2, 5, 9]) {
        db.prepare(`INSERT INTO chunks (file_id, chunk_index, repo_id, repo_path, sha, size) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(fileId, idx, repoId, `.vault/chunks/${fileId}/${String(idx).padStart(5, '0')}.bin`, `sha-${idx}`, 2000);
      }
      expect(storage.getUploadedChunkIndices(fileId)).to.deep.equal([0, 2, 5, 9]);
    });
  });

  describe('getUploadSession (includes failed status)', function () {
    it('should return session for file with upload_status = uploading', function () {
      const fileId = 'get-session-active';
      seedTestFile(db, userId, {
        id: fileId, name: 'active.mp4', path: '/active.mp4', size: 500000, chunk_count: 10,
        upload_status: 'uploading',
      });
      const session = storage.getUploadSession(userId, fileId);
      expect(session).to.be.an('object');
      expect(session.fileId).to.equal(fileId);
      expect(session.resumable).to.be.true;
    });

    it('should return session for file with upload_status = failed', function () {
      const fileId = 'get-session-failed';
      seedTestFile(db, userId, {
        id: fileId, name: 'failed.mp4', path: '/failed.mp4', size: 500000, chunk_count: 10,
        upload_status: 'failed',
      });
      const session = storage.getUploadSession(userId, fileId);
      expect(session).to.be.an('object');
      expect(session.fileId).to.equal(fileId);
      expect(session.resumable).to.be.true;
    });
  });

  describe('initUploadSession resume (findBestUploadSession fix)', function () {
    it('should find existing failed session when fileId is null (findBestUploadSession includes failed)', async function () {
      const fileId = 'fbs-failed-resume';
      seedTestFile(db, userId, {
        id: fileId, name: 'resume-me.mp4', path: '/resume-me.mp4', size: 500000, chunk_count: 10,
        upload_status: 'failed',
      });
      // Insert some chunks so chunksDone > 0
      for (let i = 0; i < 3; i++) {
        db.prepare(`INSERT INTO chunks (file_id, chunk_index, repo_id, repo_path, sha, size) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(fileId, i, repoId, `.vault/chunks/${fileId}/${String(i).padStart(5, '0')}.bin`, `sha-${i}`, 2000);
      }

      const result = await storage.initUploadSession(userId, {
        fileName: 'resume-me.mp4',
        parentPath: '/',
        size: 500000,
        mimeType: 'video/mp4',
        chunkSize: 200000,
        fileId: null,
      });

      // Should have found the failed session and returned chunksDone=3
      expect(result.fileId).to.equal(fileId);
      expect(result.chunksDone).to.equal(3);
      expect(result.nextChunk).to.equal(3);
      expect(result.resumable).to.be.true;
    });

    it('should find existing uploading session when fileId is provided', async function () {
      const fileId = 'init-existing-fileid';
      seedTestFile(db, userId, {
        id: fileId, name: 'by-fileid.mp4', path: '/by-fileid.mp4', size: 500000, chunk_count: 10,
        upload_status: 'uploading',
      });
      for (let i = 0; i < 5; i++) {
        db.prepare(`INSERT INTO chunks (file_id, chunk_index, repo_id, repo_path, sha, size) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(fileId, i, repoId, `.vault/chunks/${fileId}/${String(i).padStart(5, '0')}.bin`, `sha-${i}`, 2000);
      }

      const result = await storage.initUploadSession(userId, {
        fileName: 'by-fileid.mp4',
        parentPath: '/',
        size: 500000,
        mimeType: 'video/mp4',
        chunkSize: 200000,
        fileId: fileId,
      });

      expect(result.fileId).to.equal(fileId);
      expect(result.chunksDone).to.equal(5);
      expect(result.nextChunk).to.equal(5);
    });
  });

  describe('uploadPlainChunk handles failed sessions', function () {
    let mockGithub;
    let mockAccounts;
    let mockStorage;

    before(function () {
      mockGithub = {
        uploadChunk: async () => 'mocked-sha',
        getRepoInfo: async () => ({ default_branch: 'main' }),
      };
      mockAccounts = {
        createClientForUpload: () => ({}),
        createClientForRepo: () => ({}),
        getTokenForRepo: () => 'mock-token',
        ensureBackupReposForAllAccounts: async () => {},
      };
      const mockCrypto = {
        getMasterKey: () => Buffer.alloc(32),
        generateKey: () => Buffer.alloc(32),
        wrapFileKey: () => ({ wrapped_key: 'AAA', wrap_iv: 'AAA', wrap_tag: 'AAA' }),
        encryptChunk: () => ({ encrypted: Buffer.alloc(100), iv: Buffer.alloc(16), authTag: Buffer.alloc(16) }),
        deserializeEncryption: () => Buffer.alloc(32),
      };

      mockStorage = proxyquire('../../server/services/storage', {
        '../db/database': db,
        '../services/github': mockGithub,
        '../services/accounts': mockAccounts,
        '../services/crypto': mockCrypto,
      });
    });

    it('should resume chunk upload on a failed session', async function () {
      const fileId = 'failed-session-resume-test';
      seedTestFile(db, userId, {
        id: fileId, name: 'resume-failed.mp4', path: '/resume-failed.mp4',
        size: 500000, chunk_count: 3, upload_status: 'failed',
        mime_type: 'video/mp4', has_thumbnail: 0,
        encryption_meta: JSON.stringify({ wrapped_key: 'AAA', wrap_iv: 'AAA', wrap_tag: 'AAA' }),
        encryption_mode: 'chunk',
      });

      const result = await mockStorage.uploadPlainChunk(userId, fileId, 0, Buffer.alloc(100));
      expect(result.skipped).to.equal(false);
      expect(result.chunksDone).to.equal(1);

      const updated = db.prepare('SELECT upload_status FROM files WHERE id = ?').get(fileId);
      expect(updated.upload_status).to.equal('uploading');
    });

    it('should skip inaccessible repos and upload to the next available repo', async function () {
      db.prepare('UPDATE storage_repos SET chunk_count = 5 WHERE id = ?').run(repoId);
      db.prepare(`
        INSERT INTO storage_repos (user_id, owner, name, full_name, default_branch, repo_role, is_active, chunk_count)
        VALUES (?, 'bad', 'vault-storage-1', 'bad/vault-storage-1', 'main', 'primary', 1, 0)
      `).run(userId);

      const badRepoId = db.prepare('SELECT id FROM storage_repos WHERE full_name = ?').get('bad/vault-storage-1').id;
      const fileId = 'repo-fallback-test';
      seedTestFile(db, userId, {
        id: fileId, name: 'fallback.mp4', path: '/fallback.mp4',
        size: 500000, chunk_count: 3, upload_status: 'uploading',
        mime_type: 'video/mp4', has_thumbnail: 0,
        encryption_meta: JSON.stringify({ wrapped_key: 'AAA', wrap_iv: 'AAA', wrap_tag: 'AAA' }),
        encryption_mode: 'chunk',
      });

      const failingGithub = {
        uploadChunk: async () => 'mocked-sha',
        getRepoInfo: async (octokit, owner) => {
          if (owner === 'bad') {
            const err = new Error('Not Found');
            err.status = 404;
            throw err;
          }
          return { default_branch: 'main' };
        },
      };
      const fallbackStorage = proxyquire('../../server/services/storage', {
        '../db/database': db,
        '../services/github': failingGithub,
        '../services/accounts': mockAccounts,
        '../services/crypto': {
          getMasterKey: () => Buffer.alloc(32),
          generateKey: () => Buffer.alloc(32),
          wrapFileKey: () => ({ wrapped_key: 'AAA', wrap_iv: 'AAA', wrap_tag: 'AAA' }),
          encryptChunk: () => ({ encrypted: Buffer.alloc(100), iv: Buffer.alloc(16), authTag: Buffer.alloc(16) }),
          deserializeEncryption: () => Buffer.alloc(32),
        },
      });

      const result = await fallbackStorage.uploadPlainChunk(userId, fileId, 0, Buffer.alloc(100));
      expect(result.currentRepo).to.equal('test/storagerepo');

      const badRepo = db.prepare('SELECT is_active FROM storage_repos WHERE id = ?').get(badRepoId);
      expect(badRepo.is_active).to.equal(0);

      const chunk = db.prepare('SELECT repo_id FROM chunks WHERE file_id = ? AND chunk_index = 0').get(fileId);
      expect(chunk.repo_id).to.equal(repoId);
    });
  });

  describe('verifyFileChunksOnGitHub', function () {
    let verifyStorage;
    const presentPaths = new Set();

    before(function () {
      verifyStorage = proxyquire('../../server/services/storage', {
        '../db/database': db,
        './github': {
          getFileSha: async (_octokit, _owner, _repo, path) => (
            presentPaths.has(path) ? 'remote-sha-ok' : null
          ),
          uploadChunk: async () => 'repaired-sha',
          getRepoInfo: async () => ({ default_branch: 'main' }),
        },
        './accounts': {
          createClientForRepo: () => ({}),
          createClientForUpload: () => ({}),
          getTokenForRepo: () => 'token',
          ensureBackupReposForAllAccounts: async () => {},
        },
        './metadata': {
          getMetadataRepo: () => null,
          saveFileManifest: async () => {},
        },
        './backup-sync': { startAllBackupSyncs: () => {} },
      });
    });

    beforeEach(function () {
      presentPaths.clear();
    });

    it('should report valid when every chunk exists on GitHub', async function () {
      const fileId = 'verify-all-present';
      seedTestFile(db, userId, {
        id: fileId, name: 'ok.bin', path: '/ok.bin', size: 6000, chunk_count: 3,
        upload_status: 'ready',
      });
      for (let i = 0; i < 3; i++) {
        const repoPath = `.vault/chunks/${fileId}/${String(i).padStart(5, '0')}.bin`;
        presentPaths.add(repoPath);
        db.prepare(`INSERT INTO chunks (file_id, chunk_index, repo_id, repo_path, sha, size, plain_size) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(fileId, i, repoId, repoPath, `sha-${i}`, 2000, 2000);
      }

      const result = await verifyStorage.verifyFileChunksOnGitHub(userId, fileId);
      expect(result.valid).to.equal(true);
      expect(result.missing).to.deep.equal([]);
      expect(result.verified).to.equal(3);
    });

    it('should detect missing DB rows and missing GitHub blobs', async function () {
      const fileId = 'verify-missing';
      seedTestFile(db, userId, {
        id: fileId, name: 'bad.bin', path: '/bad.bin', size: 6000, chunk_count: 3,
        upload_status: 'ready',
      });
      const repoPath = `.vault/chunks/${fileId}/${String(0).padStart(5, '0')}.bin`;
      presentPaths.add(repoPath);
      db.prepare(`INSERT INTO chunks (file_id, chunk_index, repo_id, repo_path, sha, size, plain_size) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(fileId, 0, repoId, repoPath, 'sha-0', 2000, 2000);
      db.prepare(`INSERT INTO chunks (file_id, chunk_index, repo_id, repo_path, sha, size, plain_size) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(fileId, 1, repoId, `.vault/chunks/${fileId}/00001.bin`, 'sha-1', 2000, 2000);

      const result = await verifyStorage.verifyFileChunksOnGitHub(userId, fileId);
      expect(result.valid).to.equal(false);
      expect(result.missing).to.deep.equal([1, 2]);
      expect(result.verified).to.equal(1);
    });
  });
});
