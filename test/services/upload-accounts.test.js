const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { createMemoryDb, seedTestUser } = require('../helpers/setup');

describe('upload account targeting', function () {
  let db;
  let storage;

  beforeEach(function () {
    db = createMemoryDb();
    const user = seedTestUser(db, {
      github_id: 'upload-target-user',
      username: 'primaryuser',
      access_token: 'primary-token',
    });

    db.prepare(`
      INSERT INTO linked_accounts (user_id, github_id, username, access_token, role, is_active, created_at)
      VALUES (?, 'linked-gh', 'storageuser', 'linked-token', 'storage', 1, '2024-06-01T00:00:00.000Z')
    `).run(user.id);
    const linkedId = db.prepare('SELECT id FROM linked_accounts WHERE user_id = ?').get(user.id).id;

    db.prepare(`
      INSERT INTO storage_repos (user_id, owner, name, full_name, default_branch, linked_account_id, repo_role, is_active, is_metadata)
      VALUES (?, 'primaryuser', 'vault-storage-1', 'primaryuser/vault-storage-1', 'main', NULL, 'primary', 1, 0)
    `).run(user.id);
    db.prepare(`
      INSERT INTO storage_repos (user_id, owner, name, full_name, default_branch, linked_account_id, repo_role, is_active, is_metadata)
      VALUES (?, 'storageuser', 'vault-storage-1', 'storageuser/vault-storage-1', 'main', ?, 'primary', 1, 0)
    `).run(user.id, linkedId);

    storage = proxyquire('../../server/services/storage', {
      '../db/database': db,
      './accounts': {
        createClientForUpload: () => ({}),
        createClientForRepo: () => ({}),
        getTokenForRepo: () => 'token',
        deferMirrorChunk: () => {},
      },
      './github': {
        getRepoInfo: async () => ({ default_branch: 'main' }),
        uploadChunk: async () => 'sha',
      },
      './github-rate-limit': {
        keyForToken: () => 'k',
        getQuotaStatus: () => ({ remaining: 5000, exhausted: false }),
        isPaused: () => false,
        waitForQuota: async () => {},
        recordRequest: () => {},
      },
      './thumbnails': { generate: async () => null, isVideo: () => false, isAudio: () => false },
      './capacity': require('../../server/services/capacity'),
      './video-formats': require('../../server/services/video-formats'),
    });
  });

  it('lists primary and storage upload targets', function () {
    const userId = db.prepare('SELECT id FROM users LIMIT 1').get().id;
    const linkedId = db.prepare('SELECT id FROM linked_accounts LIMIT 1').get().id;
    const targets = storage.listUploadTargets(userId);
    expect(targets).to.have.length(2);
    expect(targets.map((t) => t.id).sort()).to.deep.equal(['primary', String(linkedId)].sort());
  });

  it('filters upload plan to selected storage account only', function () {
    const userId = db.prepare('SELECT id FROM users LIMIT 1').get().id;
    const linkedId = db.prepare('SELECT id FROM linked_accounts LIMIT 1').get().id;
    const planAll = storage.planUpload(1000, 921600, userId, {});
    expect(planAll.repoCount).to.equal(2);
    const planStorage = storage.planUpload(1000, 921600, userId, { uploadAccountIds: [String(linkedId)] });
    expect(planStorage.repoCount).to.equal(1);
  });

  it('prefers newer linked account repos before primary for uploads', function () {
    const userId = db.prepare('SELECT id FROM users LIMIT 1').get().id;

    db.prepare(`
      INSERT INTO linked_accounts (user_id, github_id, username, access_token, role, is_active, created_at)
      VALUES (?, 'older-gh', 'olderacct', 'older-token', 'storage', 1, '2024-01-01T00:00:00.000Z')
    `).run(userId);
    const olderId = db.prepare("SELECT id FROM linked_accounts WHERE username = 'olderacct'").get().id;

    db.prepare(`
      INSERT INTO linked_accounts (user_id, github_id, username, access_token, role, is_active, created_at)
      VALUES (?, 'newer-gh', 'neweracct', 'newer-token', 'storage', 1, '2030-01-01T00:00:00.000Z')
    `).run(userId);
    const newerId = db.prepare("SELECT id FROM linked_accounts WHERE username = 'neweracct'").get().id;

    db.prepare(`
      INSERT INTO storage_repos (user_id, owner, name, full_name, default_branch, linked_account_id, repo_role, is_active, is_metadata)
      VALUES (?, 'olderacct', 'vault-storage-1', 'olderacct/vault-storage-1', 'main', ?, 'primary', 1, 0)
    `).run(userId, olderId);
    db.prepare(`
      INSERT INTO storage_repos (user_id, owner, name, full_name, default_branch, linked_account_id, repo_role, is_active, is_metadata)
      VALUES (?, 'neweracct', 'vault-storage-1', 'neweracct/vault-storage-1', 'main', ?, 'primary', 1, 0)
    `).run(userId, newerId);

    const plan = storage.planUpload(1000, 921600, userId, {});
    expect(plan.repoCount).to.equal(4);
    expect(plan.distribution[0].repo).to.equal('neweracct/vault-storage-1');
  });
});
