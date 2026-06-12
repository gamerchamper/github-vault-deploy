const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { createMemoryDb, seedTestUser } = require('../helpers/setup');

describe('accounts upload client', function () {
  let db;
  let accounts;
  let lastClientToken;

  beforeEach(function () {
    db = createMemoryDb();
    const user = seedTestUser(db, {
      github_id: 'acct-upload-user',
      username: 'primaryuser',
      access_token: 'primary-token',
    });

    db.prepare(`
      INSERT INTO linked_accounts (user_id, github_id, username, access_token, role, is_active)
      VALUES (?, 'linked-gh', 'linkeduser', 'linked-token', 'storage', 1)
    `).run(user.id);
    const linkedId = db.prepare('SELECT id FROM linked_accounts WHERE user_id = ?').get(user.id).id;

    db.prepare(`
      INSERT INTO storage_repos (user_id, owner, name, full_name, default_branch, linked_account_id, repo_role)
      VALUES (?, 'linkeduser', 'vault-storage-1', 'linkeduser/vault-storage-1', 'main', ?, 'primary')
    `).run(user.id, linkedId);

    const rateLimit = {
      keyForToken: (t) => `key:${t}`,
      getQuotaStatus: (key) => {
        if (key === 'key:linked-token') return { remaining: 5, exhausted: false };
        return { remaining: 5000, exhausted: false };
      },
      isPaused: () => false,
    };

    const mockGithub = {
      createClient: (token) => {
        lastClientToken = token;
        return { token };
      },
    };

    accounts = proxyquire('../../server/services/accounts', {
      '../db/database': db,
      './github': mockGithub,
      './github-rate-limit': rateLimit,
    });
  });

  it('createClientForUpload always uses the repo owner token even when quota is low', function () {
    const repo = db.prepare('SELECT * FROM storage_repos WHERE full_name = ?')
      .get('linkeduser/vault-storage-1');
    accounts.createClientForUpload(
      db.prepare('SELECT id FROM users LIMIT 1').get().id,
      repo
    );
    expect(lastClientToken).to.equal('linked-token');
  });
});
