const { expect } = require('chai');
const proxyquire = require('proxyquire');
const sinon = require('sinon');

describe('view-mode service', function () {
  let viewMode;
  let dbStub;
  let getStub;
  let allStub;

  beforeEach(function () {
    getStub = sinon.stub();
    allStub = sinon.stub();
    dbStub = { prepare: sinon.stub().returns({ get: getStub, all: allStub }) };

    viewMode = proxyquire('../../server/services/view-mode', {
      '../db/database': dbStub,
    });
  });

  describe('parseViewParam', function () {
    it('should return primary for null/undefined/empty', function () {
      expect(viewMode.parseViewParam(null)).to.deep.equal({ type: 'primary' });
      expect(viewMode.parseViewParam(undefined)).to.deep.equal({ type: 'primary' });
      expect(viewMode.parseViewParam('')).to.deep.equal({ type: 'primary' });
    });

    it('should return primary for "primary"', function () {
      expect(viewMode.parseViewParam('primary')).to.deep.equal({ type: 'primary' });
    });

    it('should parse backup:id format', function () {
      const result = viewMode.parseViewParam('backup:42');
      expect(result).to.deep.equal({ type: 'backup', accountId: 42 });
    });

    it('should parse storage:id format', function () {
      const result = viewMode.parseViewParam('storage:99');
      expect(result).to.deep.equal({ type: 'storage', accountId: 99 });
    });

    it('should return primary for invalid type', function () {
      expect(viewMode.parseViewParam('invalid:1')).to.deep.equal({ type: 'primary' });
    });

    it('should return primary for non-numeric accountId', function () {
      expect(viewMode.parseViewParam('backup:abc')).to.deep.equal({ type: 'primary' });
    });

    it('should return primary for NaN accountId', function () {
      expect(viewMode.parseViewParam('backup:NaN')).to.deep.equal({ type: 'primary' });
    });
  });

  describe('getPrimaryStorageRepos', function () {
    it('should query repos with primary role or null', function () {
      getStub.returns({ username: 'test' });
      allStub.returns([
        { id: 1, full_name: 'test/repo1' },
        { id: 2, full_name: 'test/repo2' },
      ]);

      const repos = viewMode.getPrimaryStorageRepos(1);
      expect(repos.length).to.equal(2);
      const sql = dbStub.prepare.getCall(0).args[0];
      expect(sql).to.include('repo_role');
      expect(sql).to.include('is_metadata');
    });
  });
});
