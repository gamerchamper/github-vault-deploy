const { expect } = require('chai');
const proxyquire = require('proxyquire');

describe('site access key', function () {
  let siteAccess;

  beforeEach(function () {
    delete process.env.SITE_ACCESS_KEY;
    siteAccess = proxyquire('../../server/services/site-access', {});
  });

  it('is disabled when SITE_ACCESS_KEY is unset', function () {
    expect(siteAccess.isRequired()).to.equal(false);
    expect(siteAccess.keysMatch('123456')).to.equal(true);
  });

  it('requires exactly six digits', function () {
    process.env.SITE_ACCESS_KEY = '123456';
    siteAccess = proxyquire('../../server/services/site-access', {});
    expect(siteAccess.isRequired()).to.equal(true);
    expect(siteAccess.keysMatch('123456')).to.equal(true);
    expect(siteAccess.keysMatch('12345')).to.equal(false);
    expect(siteAccess.keysMatch('1234567')).to.equal(false);
    expect(siteAccess.keysMatch('abcdef')).to.equal(false);
  });

  it('tracks unlock in session', function () {
    process.env.SITE_ACCESS_KEY = '654321';
    siteAccess = proxyquire('../../server/services/site-access', {});
    const req = { session: {}, get: () => null, query: {} };
    expect(siteAccess.isGranted(req)).to.equal(false);
    siteAccess.grantSession(req);
    expect(siteAccess.isGranted(req)).to.equal(true);
    expect(siteAccess.status(req)).to.deep.equal({ required: true, unlocked: true });
  });

  it('unlocks from header and query param', function () {
    process.env.SITE_ACCESS_KEY = '111222';
    siteAccess = proxyquire('../../server/services/site-access', {});
    const reqHeader = { session: {}, get: (h) => (h === 'x-vault-access-key' ? '111222' : null), query: {} };
    expect(siteAccess.isGranted(reqHeader)).to.equal(true);
    const reqQuery = { session: {}, get: () => null, query: { access: '111222' } };
    expect(siteAccess.isGranted(reqQuery)).to.equal(true);
  });
});
