const { expect } = require('chai');
const { formatBytes, formatSpeed, formatTime, renderProgressLine, renderTable } = require('../src/progress');

describe('progress helpers', function () {
  describe('formatBytes', function () {
    it('should return 0 B for zero', function () {
      expect(formatBytes(0)).to.equal('0 B');
    });

    it('should format bytes', function () {
      expect(formatBytes(500)).to.equal('500 B');
    });

    it('should format KB', function () {
      expect(formatBytes(2048)).to.equal('2.0 KB');
    });

    it('should format MB', function () {
      expect(formatBytes(5 * 1024 * 1024)).to.equal('5.0 MB');
    });

    it('should format GB', function () {
      expect(formatBytes(2 * 1024 * 1024 * 1024)).to.equal('2.0 GB');
    });
  });

  describe('formatSpeed', function () {
    it('should return --/s for zero', function () {
      expect(formatSpeed(0)).to.equal('--/s');
    });

    it('should format positive speed', function () {
      expect(formatSpeed(1024 * 1024)).to.include('MB');
    });
  });

  describe('formatTime', function () {
    it('should return -- for invalid inputs', function () {
      expect(formatTime(0)).to.equal('--');
      expect(formatTime(-1)).to.equal('--');
      expect(formatTime(null)).to.equal('--');
    });

    it('should format seconds', function () {
      expect(formatTime(45)).to.equal('45s');
    });

    it('should format minutes and seconds', function () {
      expect(formatTime(125)).to.equal('2m 5s');
    });

    it('should format hours and minutes', function () {
      expect(formatTime(7500)).to.equal('2h 5m');
    });
  });

  describe('renderProgressLine', function () {
    it('should produce a progress bar string', function () {
      const line = renderProgressLine({ chunksDone: 5, totalChunks: 10, percent: 50, bytesUploaded: 5000, speed: 1000, eta: 30 });
      expect(line).to.be.a('string');
      expect(line).to.include('50%');
      expect(line).to.include('5/10');
    });
  });

  describe('renderTable', function () {
    it('should return message for empty list', function () {
      expect(renderTable([])).to.include('No sessions found.');
    });

    it('should render session rows', function () {
      const sessions = [
        { taskId: 'task-1', fileName: 'test.mp4', status: 'uploading', chunksDone: 3, totalChunks: 10 },
        { taskId: 'task-2', fileName: 'big.mkv', status: 'error', chunksDone: 50, totalChunks: 100 },
      ];
      const table = renderTable(sessions);
      expect(table).to.include('task-1');
      expect(table).to.include('test.mp4');
      expect(table).to.include('uploading');
      expect(table).to.include('3/10');
      expect(table).to.include('task-2');
      expect(table).to.include('big.mkv');
      expect(table).to.include('error');
      expect(table).to.include('50/100');
    });
  });
});
