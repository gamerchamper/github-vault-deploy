const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();
const { createMemoryDb, seedTestUser } = require('../helpers/setup');

describe('accounts pastebin linking', () => {
  let db;
  let accounts;

  beforeEach(() => {
    process.env.PASTEBIN_DEV_KEY = 'dev-key-test';
    db = createMemoryDb();
    accounts = proxyquire('../../server/services/accounts', {
      '../db/database': db,
      './github': { createClient: () => ({}), addCollaborator: async () => ({}) },
      './bitbucket': { createClient: () => ({}), addCollaborator: async () => ({}) },
      './pastebin': {
        createClient: () => ({}),
        addCollaborator: async () => ({ invited: false }),
      },
      './backup-sync': { runBackupSync: () => {} },
    });
  });

  it('creates pastebin link tokens', () => {
    const user = seedTestUser(db);
    const link = accounts.createLinkToken(user.id, 'storage', null, 'pastebin');
    expect(link.provider).to.equal('pastebin');
    expect(link.url).to.include('/auth/pastebin/link?token=');
  });

  it('links a pastebin account with provider column', async () => {
    const user = seedTestUser(db);
    const profile = {
      id: 'pasteuser',
      username: 'pasteuser',
      photos: [{ value: 'https://pastebin.com/cache/a/1.jpg' }],
    };
    const account = await accounts.linkAccount(user.id, profile, 'api-user-key', 'storage', 'pastebin');
    expect(account.provider).to.equal('pastebin');
    expect(account.username).to.equal('pasteuser');
  });
});
