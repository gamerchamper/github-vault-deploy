const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();
const { createMemoryDb, seedTestUser } = require('../helpers/setup');

describe('accounts bitbucket chunk operations', () => {
  let db;
  let accounts;
  let downloadCalls;

  beforeEach(() => {
    db = createMemoryDb();
    downloadCalls = [];

    const mockBitbucket = {
      createClient: (token) => ({ accessToken: token, provider: 'bitbucket', tokenKey: `bb:${token}` }),
      downloadChunk: async (client, owner, repo, path, branch) => {
        downloadCalls.push({ owner, repo, path, branch, token: client.accessToken });
        return Buffer.from('bitbucket-chunk-data');
      },
      uploadChunk: async () => 'bb-sha',
      addCollaborator: async () => ({ invited: true }),
    };

    const mockGithub = {
      createClient: () => ({}),
      downloadChunk: async () => Buffer.from('github-chunk'),
      addCollaborator: async () => ({}),
    };

    const rateLimit = {
      keyForToken: (t) => `key:${t}`,
      getQuotaStatus: () => ({ remaining: 900, exhausted: false }),
      isPaused: () => false,
    };

    accounts = proxyquire('../../server/services/accounts', {
      '../db/database': db,
      './storage-provider': {
        normalizeProvider: (p) => p || 'github',
        getModule: (p) => (p === 'bitbucket' ? mockBitbucket : mockGithub),
        getProvider: (p) => ({
          defaultRateLimitHour: p === 'bitbucket' ? 1000 : 5000,
          label: p === 'bitbucket' ? 'Bitbucket' : 'GitHub',
        }),
        getProviderForRepo: (repo) => ({
          defaultRateLimitHour: repo?.provider === 'bitbucket' ? 1000 : 5000,
          label: repo?.provider === 'bitbucket' ? 'Bitbucket' : 'GitHub',
        }),
        getRateLimit: () => rateLimit,
        getRateLimitForRepo: () => rateLimit,
      },
      './github': mockGithub,
      './bitbucket': mockBitbucket,
      './backup-sync': { runBackupSync: () => {} },
    });
  });

  it('downloads chunks via bitbucket adapter for bitbucket repos', async () => {
    const user = seedTestUser(db);
    db.prepare(`
      INSERT INTO linked_accounts (user_id, github_id, username, access_token, role, provider, is_active)
      VALUES (?, 'bb-ext', 'bbuser', 'bb-token', 'storage', 'bitbucket', 1)
    `).run(user.id);
    const linkedId = db.prepare('SELECT id FROM linked_accounts WHERE user_id = ?').get(user.id).id;

    db.prepare(`
      INSERT INTO storage_repos (user_id, owner, name, full_name, default_branch, linked_account_id, provider, is_active)
      VALUES (?, 'bbuser', 'vault-storage-1', 'bbuser/vault-storage-1', 'main', ?, 'bitbucket', 1)
    `).run(user.id, linkedId);
    const repo = db.prepare('SELECT * FROM storage_repos WHERE provider = ?').get('bitbucket');

    db.prepare(`
      INSERT INTO files (id, user_id, name, path, size, mime_type, chunk_count, upload_status)
      VALUES ('file-1', ?, 'test.bin', '/test.bin', 1024, 'application/octet-stream', 1, 'ready')
    `).run(user.id);
    db.prepare(`
      INSERT INTO chunks (file_id, chunk_index, repo_id, repo_path, sha, size)
      VALUES ('file-1', 0, ?, '.vault/chunks/file-1/00000.bin', 'bb-sha', 512)
    `).run(repo.id);
    const chunk = db.prepare('SELECT * FROM chunks WHERE file_id = ?').get('file-1');

    const data = await accounts.downloadChunkFromPrimary(user.id, chunk);

    expect(data.toString()).to.equal('bitbucket-chunk-data');
    expect(downloadCalls).to.have.length(1);
    expect(downloadCalls[0].token).to.equal('bb-token');
    expect(downloadCalls[0].owner).to.equal('bbuser');
  });
});
