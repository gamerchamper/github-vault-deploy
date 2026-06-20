const { expect } = require('chai');
const proxyquire = require('proxyquire');
const Database = require('better-sqlite3');

function makeSiteAccess(env = {}) {
  Object.keys(process.env).forEach((k) => {
    if (k === 'SITE_ACCESS_KEY') delete process.env.SITE_ACCESS_KEY;
  });
  if (env.SITE_ACCESS_KEY !== undefined) process.env.SITE_ACCESS_KEY = env.SITE_ACCESS_KEY;

  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE server_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  return {
    siteAccess: proxyquire('../../server/services/site-access', { '../db/database': db }),
    db,
  };
}

describe('site access key', function () {
  let siteAccess;
  let db;

  afterEach(function () {
    delete process.env.SITE_ACCESS_KEY;
    db?.close();
  });

  it('is disabled when no key is configured', function () {
    ({ siteAccess } = makeSiteAccess());
    expect(siteAccess.isRequired()).to.equal(false);
    expect(siteAccess.keysMatch('123456')).to.equal(true);
  });

  it('requires exactly six digits from environment', function () {
    ({ siteAccess } = makeSiteAccess({ SITE_ACCESS_KEY: '123456' }));
    expect(siteAccess.isRequired()).to.equal(true);
    expect(siteAccess.keysMatch('123456')).to.equal(true);
    expect(siteAccess.keysMatch('12345')).to.equal(false);
    expect(siteAccess.keysMatch('1234567')).to.equal(false);
    expect(siteAccess.keysMatch('abcdef')).to.equal(false);
  });

  it('tracks unlock in session', function () {
    ({ siteAccess } = makeSiteAccess({ SITE_ACCESS_KEY: '654321' }));
    const req = { session: {}, get: () => null, query: {} };
    expect(siteAccess.isGranted(req)).to.equal(false);
    siteAccess.grantSession(req);
    expect(siteAccess.isGranted(req)).to.equal(true);
    expect(siteAccess.status(req)).to.deep.equal({ required: true, unlocked: true });
  });

  it('unlocks from header and query param', function () {
    ({ siteAccess } = makeSiteAccess({ SITE_ACCESS_KEY: '111222' }));
    const reqHeader = { session: {}, get: (h) => (h === 'x-vault-access-key' ? '111222' : null), query: {} };
    expect(siteAccess.isGranted(reqHeader)).to.equal(true);
    const reqQuery = { session: {}, get: () => null, query: { access: '111222' } };
    expect(siteAccess.isGranted(reqQuery)).to.equal(true);
  });

  it('stores and reads key from database', function () {
    ({ siteAccess } = makeSiteAccess());
    siteAccess.setConfiguredKey('987654');
    expect(siteAccess.getConfiguredKey()).to.equal('987654');
    expect(siteAccess.getAdminStatus()).to.include({ source: 'database', required: true, key_hint: '••••54' });
  });

  it('database key overrides environment', function () {
    ({ siteAccess } = makeSiteAccess({ SITE_ACCESS_KEY: '111111' }));
    siteAccess.setConfiguredKey('222222');
    expect(siteAccess.getConfiguredKey()).to.equal('222222');
    expect(siteAccess.keysMatch('111111')).to.equal(false);
    expect(siteAccess.keysMatch('222222')).to.equal(true);
  });

  it('explicit disable overrides environment', function () {
    ({ siteAccess } = makeSiteAccess({ SITE_ACCESS_KEY: '333333' }));
    siteAccess.clearConfiguredKey();
    expect(siteAccess.isRequired()).to.equal(false);
    expect(siteAccess.getAdminStatus()).to.include({ source: 'disabled', explicitly_disabled: true });
  });

  it('reset to environment removes database override', function () {
    ({ siteAccess } = makeSiteAccess({ SITE_ACCESS_KEY: '444444' }));
    siteAccess.setConfiguredKey('555555');
    siteAccess.resetToEnvironment();
    expect(siteAccess.getConfiguredKey()).to.equal('444444');
    expect(siteAccess.getAdminStatus().source).to.equal('environment');
  });
});
