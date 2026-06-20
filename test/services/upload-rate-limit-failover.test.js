const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { createMemoryDb, seedTestUser } = require('../helpers/setup');

describe('upload rate-limit account failover', function () {
  let db;
  let storage;
  let rateLimitState;
  let userId;
  let linkedId;

  function makeStorage() {
    return proxyquire('../../server/services/storage', {
      '../db/database': db,
      './accounts': {
        createClientForUpload: () => ({}),
        createClientForRepo: () => ({}),
        getTokenForRepo: (uid, repo) => (
          repo.linked_account_id ? 'linked-token' : 'primary-token'
        ),
        deferMirrorChunk: () => {},
      },
      './github': {
        createClient: () => ({}),
        getRepoInfo: async () => ({ default_branch: 'main' }),
        uploadChunk: async () => 'sha',
      },
      './github-rate-limit': {
        keyForToken: (token) => (token === 'primary-token' ? 'primary' : 'linked'),
        getQuotaStatus: (key) => rateLimitState[key] || { remaining: 5000, exhausted: false },
        isPaused: (key) => !!(rateLimitState[key]?.paused),
        isRateLimitError: (err) => !!err?.isRateLimitFailFast,
        noteHeaders: () => {},
        setWaitCallback: () => () => {},
        runWithSubsystem: (_name, fn) => fn(),
      },
      './thumbnails': { generate: async () => null, isVideo: () => false, isAudio: () => false },
      './capacity': require('../../server/services/capacity'),
      './video-formats': require('../../server/services/video-formats'),
    });
  }

  beforeEach(function () {
    db = createMemoryDb();
    const user = seedTestUser(db, {
      github_id: 'failover-user',
      username: 'primaryuser',
      access_token: 'primary-token',
    });
    userId = user.id;

    db.prepare(`
      INSERT INTO linked_accounts (user_id, github_id, username, access_token, role, is_active)
      VALUES (?, 'linked-gh', 'storageuser', 'linked-token', 'storage', 1)
    `).run(userId);
    linkedId = db.prepare('SELECT id FROM linked_accounts WHERE user_id = ?').get(userId).id;

    db.prepare(`
      INSERT INTO storage_repos (user_id, owner, name, full_name, default_branch, linked_account_id, repo_role, is_active, is_metadata)
      VALUES (?, 'primaryuser', 'vault-storage-1', 'primaryuser/vault-storage-1', 'main', NULL, 'primary', 1, 0)
    `).run(userId);
    db.prepare(`
      INSERT INTO storage_repos (user_id, owner, name, full_name, default_branch, linked_account_id, repo_role, is_active, is_metadata)
      VALUES (?, 'storageuser', 'vault-storage-1', 'storageuser/vault-storage-1', 'main', ?, 'primary', 1, 0)
    `).run(userId, linkedId);

    rateLimitState = {
      primary: { paused: true, exhausted: true, remaining: 0 },
      linked: { paused: false, exhausted: false, remaining: 4500 },
    };
    db.exec('ALTER TABLE files ADD COLUMN upload_account_ids TEXT');
    storage = makeStorage();
  });

  it('replans upload accounts when selected account is rate limited', function () {
    const fileId = 'file-rate-limit-test';

    db.prepare(`
      INSERT INTO files (id, user_id, name, path, size, chunk_count, upload_status, upload_account_ids)
      VALUES (?, ?, 'test.bin', '/test.bin', 1000, 2, 'uploading', ?)
    `).run(fileId, userId, JSON.stringify(['primary']));

    const { repos, replanned } = storage.getUploadReposForChunk(userId, fileId, null);
    expect(replanned).to.equal(true);
    expect(repos).to.have.length(1);
    expect(repos[0].full_name).to.equal('storageuser/vault-storage-1');

    const stored = storage.getUploadAccountIdsForFile(fileId);
    expect(stored).to.deep.equal([String(linkedId)]);
  });

  it('returns only healthy repos when multiple accounts are selected', function () {
    const fileId = 'file-healthy-pool';
    db.prepare(`
      INSERT INTO files (id, user_id, name, path, size, chunk_count, upload_status, upload_account_ids)
      VALUES (?, ?, 'test.bin', '/test.bin', 1000, 2, 'uploading', ?)
    `).run(fileId, userId, JSON.stringify(['primary', String(linkedId)]));

    const { repos, replanned } = storage.getUploadReposForChunk(userId, fileId, null);
    expect(replanned).to.equal(false);
    expect(repos).to.have.length(1);
    expect(repos[0].full_name).to.equal('storageuser/vault-storage-1');
  });

  it('plans distribution using accounts with available quota', function () {
    const plan = storage.planUpload(1000, 921600, userId, {
      uploadAccountIds: ['primary', String(linkedId)],
    });
    expect(plan.repoCount).to.equal(1);
    expect(Object.keys(plan.perRepo)).to.deep.equal(['storageuser/vault-storage-1']);
  });
});
