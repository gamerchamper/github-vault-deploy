const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { createMemoryDb, seedTestUser } = require('../helpers/setup');

describe('linked account both role', function () {
  it('recognizes storage and backup capabilities for both role', function () {
    const accounts = require('../../server/services/accounts');
    expect(accounts.isStorageRole('both')).to.equal(true);
    expect(accounts.isBackupRole('both')).to.equal(true);
    expect(accounts.isStorageRole('storage')).to.equal(true);
    expect(accounts.isBackupRole('backup')).to.equal(true);
    expect(accounts.isStorageRole('backup')).to.equal(false);
    expect(accounts.isBackupRole('storage')).to.equal(false);
    expect(accounts.VALID_ROLES.has('both')).to.equal(true);
    expect(accounts.parseLinkRole('both')).to.equal('both');
  });

  it('lists both-role account in storage repo queries', function () {
    const db = createMemoryDb();
    const user = seedTestUser(db, { github_id: 'both-role-user', username: 'bothuser' });
    db.prepare(`
      INSERT INTO linked_accounts (user_id, github_id, username, access_token, role, is_active, created_at)
      VALUES (?, 'both-gh', 'bothacct', 'token', 'both', 1, datetime('now'))
    `).run(user.id);
    const linkedId = db.prepare('SELECT id FROM linked_accounts WHERE user_id = ?').get(user.id).id;

    db.prepare(`
      INSERT INTO storage_repos (user_id, owner, name, full_name, default_branch, linked_account_id, repo_role, is_active, is_metadata)
      VALUES (?, 'bothacct', 'vault-storage-1', 'bothacct/vault-storage-1', 'main', ?, 'primary', 1, 0)
    `).run(user.id, linkedId);

    const storage = proxyquire('../../server/services/storage', {
      '../db/database': db,
      './accounts': {
        createClientForUpload: () => ({}),
        createClientForRepo: () => ({}),
        getTokenForRepo: () => 'token',
        deferMirrorChunk: () => {},
      },
      './github-rate-limit': {
        keyForToken: () => 'k',
        getQuotaStatus: () => ({ remaining: 5000, exhausted: false }),
        isPaused: () => false,
      },
    });

    const repos = storage.listUploadTargets(user.id);
    expect(repos.some((target) => target.linkedAccountId === linkedId)).to.equal(true);
  });
});
