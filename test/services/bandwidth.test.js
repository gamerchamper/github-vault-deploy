const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

describe('bandwidth service', function () {
  let bandwidth;
  let dbStub;
  let prepareStub;
  let runStub;
  let getStub;
  let allStub;
  let clock;

  beforeEach(function () {
    clock = sinon.useFakeTimers(new Date('2026-06-10T12:00:00Z').getTime());

    runStub = sinon.stub();
    getStub = sinon.stub();
    allStub = sinon.stub();

    prepareStub = sinon.stub();
    prepareStub.returns({ run: runStub, get: getStub, all: allStub });

    dbStub = {
      prepare: prepareStub,
    };

    bandwidth = proxyquire('../../server/services/bandwidth', {
      '../db/database': dbStub,
    });
  });

  afterEach(function () {
    sinon.restore();
  });

  describe('recordBytes', function () {
    it('should insert a bandwidth_log row and update user bandwidth', function () {
      bandwidth.recordBytes(1, 'file1', 500, 'stream');

      expect(prepareStub.callCount).to.equal(2);

      const firstCall = prepareStub.getCall(0);
      expect(firstCall.args[0]).to.include('INSERT INTO bandwidth_log');
      expect(runStub.getCall(0).args).to.deep.equal([1, 'file1', 500, 'stream', '2026-06-10T12:00:00.000Z']);

      const secondCall = prepareStub.getCall(1);
      expect(secondCall.args[0]).to.include('UPDATE users');
      expect(runStub.getCall(1).args).to.deep.equal([500, 1]);
    });

    it('should accept null fileId', function () {
      bandwidth.recordBytes(1, null, 200, 'view');
      expect(runStub.getCall(0).args).to.deep.equal([1, null, 200, 'view', '2026-06-10T12:00:00.000Z']);
    });

    it('should default type to stream', function () {
      bandwidth.recordBytes(1, null, 100);
      expect(runStub.getCall(0).args[3]).to.equal('stream');
    });

    it('should return early if userId is missing', function () {
      bandwidth.recordBytes(null, 'f1', 500);
      expect(prepareStub.called).to.be.false;
    });

    it('should return early if bytes <= 0', function () {
      bandwidth.recordBytes(1, 'f1', 0);
      expect(prepareStub.called).to.be.false;

      bandwidth.recordBytes(1, 'f1', -1);
      expect(prepareStub.called).to.be.false;
    });
  });

  describe('getBandwidth', function () {
    it('should return zeros when no data exists (with period)', function () {
      allStub.returns([]);

      const result = bandwidth.getBandwidth(1, 'hour');

      expect(result.totalBytes).to.equal(0);
      expect(result.streamBytes).to.equal(0);
      expect(result.downloadBytes).to.equal(0);
      expect(result.period).to.equal('hour');
    });

    it('should accumulate bytes by type for period queries', function () {
      allStub.returns([
        { total: 1000, type: 'stream' },
        { total: 500, type: 'download' },
        { total: 200, type: 'view' },
      ]);

      const result = bandwidth.getBandwidth(1, 'day');

      expect(result.streamBytes).to.equal(1000);
      expect(result.downloadBytes).to.equal(500);
      expect(result.viewBytes).to.equal(200);
      expect(result.totalBytes).to.equal(1700);
      expect(result.period).to.equal('day');
    });

    it('should handle hls_upload type', function () {
      allStub.returns([
        { total: 300, type: 'hls_upload' },
      ]);

      const result = bandwidth.getBandwidth(1, 'month');
      expect(result.hlsUploadBytes).to.equal(300);
    });

    it('should use users.bandwidth_bytes for period=all', function () {
      getStub.returns({ total: 9999 });

      const result = bandwidth.getBandwidth(1, 'all');

      expect(result.totalBytes).to.equal(9999);
      expect(result.period).to.equal('all');
      const sql = prepareStub.getCall(0).args[0];
      expect(sql).to.include('bandwidth_bytes');
    });
  });

  describe('getBandwidthSummary', function () {
    it('should return hour, day, month, total and topFiles', function () {
      getStub.onFirstCall().returns({ total: 0 });
      getStub.onSecondCall().returns({ total: 0 });
      getStub.onThirdCall().returns({ total: 0 });
      allStub.returns([
        { name: 'video.mp4', size: 1000, mime_type: 'video/mp4', total_bytes: 500 },
      ]);

      const result = bandwidth.getBandwidthSummary(1);

      expect(result).to.have.all.keys('hour', 'day', 'month', 'total', 'topFiles');
      expect(result.topFiles).to.be.an('array');
      expect(result.topFiles[0].name).to.equal('video.mp4');
    });
  });
});
