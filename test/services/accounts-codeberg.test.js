const { expect } = require('chai');
const proxyquire = require('proxyquire').noCallThru();
const { createMemoryDb, seedTestUser } = require('../helpers/setup');

describe('accounts codeberg linking', () => {
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
      './codeberg': {
        createClient: () => ({}),
        addCollaborator: async () => ({ invited: true }),
      },
      './backup-sync': {
        runBackupSync: () => {},
      },
    });
  });

  it('creates codeberg link tokens with codeberg auth path', () => {
    process.env.CODEBERG_CLIENT_ID = 'cb-id';
    process.env.CODEBERG_CLIENT_SECRET = 'cb-secret';
    const user = seedTestUser(db);
    const link = accounts.createLinkToken(user.id, 'storage', null, 'codeberg');
    expect(link.provider).to.equal('codeberg');
    expect(link.url).to.include('/auth/codeberg/link?token=');
  });

  it('links a codeberg account with provider column', async () => {
    const user = seedTestUser(db);
    const profile = {
      id: 'cb-user-1',
      username: 'cbuser',
      photos: [{ value: 'https://codeberg.org/avatars/1.png' }],
    };
    const account = await accounts.linkAccount(user.id, profile, 'cb-token', 'backup', 'codeberg');
    expect(account.provider).to.equal('codeberg');
    expect(account.username).to.equal('cbuser');
    expect(account.role).to.equal('backup');

    const listed = accounts.listLinkedAccounts(user.id);
    expect(listed).to.have.length(1);
    expect(listed[0].provider).to.equal('codeberg');
  });
});
