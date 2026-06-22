const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();
const { createMemoryDb, seedTestUser } = require('../helpers/setup');

describe('accounts bitbucket linking', () => {
  let db;
  let accounts;

  beforeEach(() => {
    db = createMemoryDb();
    accounts = proxyquire('../../server/services/accounts', {
      '../db/database': db,
      './github': {
        createClient: () => ({}),
        addCollaborator: async () => ({}),
      },
      './bitbucket': {
        createClient: () => ({}),
        addCollaborator: async () => ({ invited: true }),
      },
      './backup-sync': {
        runBackupSync: () => {},
      },
    });
  });

  it('creates bitbucket link tokens with bitbucket auth path', () => {
    process.env.BITBUCKET_CLIENT_ID = 'bb-id';
    process.env.BITBUCKET_CLIENT_SECRET = 'bb-secret';
    const user = seedTestUser(db);
    const link = accounts.createLinkToken(user.id, 'storage', null, 'bitbucket');
    expect(link.provider).to.equal('bitbucket');
    expect(link.url).to.include('/auth/bitbucket/link?token=');
  });

  it('links a bitbucket account with provider column', async () => {
    const user = seedTestUser(db);
    const profile = {
      id: 'bb-user-uuid',
      username: 'bbuser',
      photos: [{ value: 'https://example.com/a.png' }],
    };
    const account = await accounts.linkAccount(user.id, profile, 'bb-token', 'storage', 'bitbucket');
    expect(account.provider).to.equal('bitbucket');
    expect(account.username).to.equal('bbuser');

    const listed = accounts.listLinkedAccounts(user.id);
    expect(listed).to.have.length(1);
    expect(listed[0].provider).to.equal('bitbucket');
  });

  it('allows linking same external id on different providers', async () => {
    const user = seedTestUser(db);
    const primary = db.prepare('SELECT github_id FROM users WHERE id = ?').get(user.id);
    const profile = {
      id: primary.github_id,
      username: 'same',
      photos: [],
    };
    await accounts.linkAccount(user.id, profile, 'token', 'storage', 'bitbucket');
    const rows = db.prepare('SELECT * FROM linked_accounts WHERE user_id = ?').all(user.id);
    expect(rows).to.have.length(1);
    expect(rows[0].provider).to.equal('bitbucket');
  });
});
