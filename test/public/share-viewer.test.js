const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

function loadClientModule(relPath) {
  const fullPath = path.resolve(__dirname, '..', relPath);
  const code = fs.readFileSync(fullPath, 'utf8');
  const varMatch = code.match(/\b(const|let|var)\s+(\w+)\s*=\s*\{/);
  if (!varMatch) throw new Error('Could not find object literal assignment in ' + relPath);
  const varName = varMatch[2];
  const fn = new Function('require', `"use strict";\n${code};\nreturn ${varName};`);
  return fn(require);
}

describe('share-viewer client', function () {
  let ShareViewer;

  before(function () {
    global.formatSize = (bytes) => {
      if (!bytes || bytes < 1) return '0 B';
      const units = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
      return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
    };
    ShareViewer = loadClientModule('../public/js/share-viewer.js');
  });

  describe('mediaType', function () {
    it('should detect video by mime type', function () {
      expect(ShareViewer.mediaType('test.mp4', 'video/mp4')).to.equal('video');
      expect(ShareViewer.mediaType('test.webm', 'video/webm')).to.equal('video');
    });

    it('should detect video by extension', function () {
      expect(ShareViewer.mediaType('test.mp4', null)).to.equal('video');
      expect(ShareViewer.mediaType('test.mkv', null)).to.equal('video');
      expect(ShareViewer.mediaType('test.mov', null)).to.equal('video');
      expect(ShareViewer.mediaType('test.avi', null)).to.equal('video');
    });

    it('should detect audio by mime type', function () {
      expect(ShareViewer.mediaType('test.mp3', 'audio/mpeg')).to.equal('audio');
      expect(ShareViewer.mediaType('test.wav', 'audio/wav')).to.equal('audio');
    });

    it('should detect audio by extension', function () {
      expect(ShareViewer.mediaType('test.mp3', null)).to.equal('audio');
      expect(ShareViewer.mediaType('test.flac', null)).to.equal('audio');
      expect(ShareViewer.mediaType('test.aac', null)).to.equal('audio');
    });

    it('should detect image by mime type', function () {
      expect(ShareViewer.mediaType('test.jpg', 'image/jpeg')).to.equal('image');
      expect(ShareViewer.mediaType('test.png', 'image/png')).to.equal('image');
    });

    it('should detect image by extension', function () {
      expect(ShareViewer.mediaType('test.jpg', null)).to.equal('image');
      expect(ShareViewer.mediaType('test.png', null)).to.equal('image');
      expect(ShareViewer.mediaType('test.gif', null)).to.equal('image');
    });

    it('should return null for unknown types', function () {
      expect(ShareViewer.mediaType('test.txt', 'text/plain')).to.be.null;
      expect(ShareViewer.mediaType('test.pdf', null)).to.be.null;
    });
  });

  describe('shouldUseHls', function () {
    it('should return false for non-MP4 files', function () {
      expect(ShareViewer.shouldUseHls({ name: 'audio.mp3', mime_type: 'audio/mpeg', chunk_count: 10 })).to.be.false;
    });

    it('should return false for files with < 2 chunks', function () {
      expect(ShareViewer.shouldUseHls({ name: 'video.mp4', mime_type: 'video/mp4', chunk_count: 1 })).to.be.false;
      expect(ShareViewer.shouldUseHls({ name: 'video.mp4', mime_type: 'video/mp4', chunk_count: 0 })).to.be.false;
    });

    it('should return true for MP4 with >= 2 chunks and no status', function () {
      expect(ShareViewer.shouldUseHls({ name: 'video.mp4', mime_type: 'video/mp4', chunk_count: 5 })).to.be.true;
    });

    it('should return false when status.use_hls is false', function () {
      const info = { name: 'video.mp4', mime_type: 'video/mp4', chunk_count: 5 };
      const status = { use_hls: false };
      expect(ShareViewer.shouldUseHls(info, status)).to.be.false;
    });

    it('should return false when mode is faststart', function () {
      const info = { name: 'video.mp4', mime_type: 'video/mp4', chunk_count: 5 };
      const status = { mode: 'faststart', use_hls: false };
      expect(ShareViewer.shouldUseHls(info, status)).to.be.false;
    });

    it('should return false when mode is cached', function () {
      const info = { name: 'video.mp4', mime_type: 'video/mp4', chunk_count: 5 };
      const status = { mode: 'cached', use_hls: false };
      expect(ShareViewer.shouldUseHls(info, status)).to.be.false;
    });

    it('should return true when status.use_hls is true', function () {
      const info = { name: 'video.mp4', mime_type: 'video/mp4', chunk_count: 5 };
      const status = { use_hls: true };
      expect(ShareViewer.shouldUseHls(info, status)).to.be.true;
    });
  });

  describe('usesClientStream', function () {
    it('should return true when client_stream is set', function () {
      expect(ShareViewer.usesClientStream({ client_stream: true })).to.be.true;
    });

    it('should return false when client_stream is not set', function () {
      expect(ShareViewer.usesClientStream({})).to.be.false;
      expect(ShareViewer.usesClientStream({ client_stream: false })).to.be.false;
    });

    it('should handle null input', function () {
      expect(ShareViewer.usesClientStream(null)).to.be.false;
    });
  });

  describe('formatDuration', function () {
    it('should return dash for invalid inputs', function () {
      expect(ShareViewer.formatDuration(null)).to.equal('—');
      expect(ShareViewer.formatDuration(undefined)).to.equal('—');
      expect(ShareViewer.formatDuration(NaN)).to.equal('—');
      expect(ShareViewer.formatDuration(Infinity)).to.equal('—');
    });

    it('should format seconds as m:ss', function () {
      expect(ShareViewer.formatDuration(65)).to.equal('1:05');
    });

    it('should format with h:mm:ss for >= 1 hour', function () {
      expect(ShareViewer.formatDuration(3600)).to.equal('1:00:00');
      expect(ShareViewer.formatDuration(3661)).to.equal('1:01:01');
    });
  });

  describe('formatSpeed', function () {
    it('should return dash for zero/negative', function () {
      expect(ShareViewer.formatSpeed(0)).to.equal('—');
      expect(ShareViewer.formatSpeed(-1)).to.equal('—');
    });

    it('should format positive speeds', function () {
      expect(ShareViewer.formatSpeed(1000000)).to.match(/\/s$/);
    });
  });

  describe('fileParam', function () {
    it('should return empty string for null/undefined', function () {
      expect(ShareViewer.fileParam(null)).to.equal('');
      expect(ShareViewer.fileParam(undefined)).to.equal('');
    });

    it('should return ?file=encodedId for fileId', function () {
      expect(ShareViewer.fileParam('abc 123')).to.equal('?file=abc%20123');
    });
  });

  describe('estimateBytes', function () {
    it('should return file.size when buffered', function () {
      expect(ShareViewer.estimateBytes({ buffered: true }, { size: 500 })).to.equal(500);
    });

    it('should return bytes_ready when positive', function () {
      expect(ShareViewer.estimateBytes({ bytes_ready: 300, total_segments: 10, segments: 5 }, { size: 1000 })).to.equal(300);
    });

    it('should estimate from segments ratio', function () {
      const result = ShareViewer.estimateBytes({ total_segments: 10, segments: 3 }, { size: 1000 });
      expect(result).to.equal(300);
    });

    it('should estimate from progress', function () {
      const result = ShareViewer.estimateBytes({ progress: 50 }, { size: 1000 });
      expect(result).to.equal(500);
    });

    it('should return 0 when no data', function () {
      expect(ShareViewer.estimateBytes({}, { size: 1000 })).to.equal(0);
    });
  });

  describe('stageLabel', function () {
    it('should return human-readable labels', function () {
      expect(ShareViewer.stageLabel('streaming')).to.equal('Buffering');
      expect(ShareViewer.stageLabel('ready')).to.equal('Ready');
      expect(ShareViewer.stageLabel('error')).to.equal('Error');
      expect(ShareViewer.stageLabel('hls')).to.equal('HLS streaming');
    });

    it('should return original for unknown stages', function () {
      expect(ShareViewer.stageLabel('unknown_stage')).to.equal('unknown_stage');
    });

    it('should return Loading for null/undefined', function () {
      expect(ShareViewer.stageLabel(null)).to.equal('Loading');
      expect(ShareViewer.stageLabel(undefined)).to.equal('Loading');
    });
  });
});
