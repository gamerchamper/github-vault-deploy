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

describe('playback-memory client', function () {
  let PlaybackMemory;

  before(function () {
    PlaybackMemory = loadClientModule('../public/js/playback-memory.js');
  });

  describe('effectiveDuration', function () {
    it('should prefer HLS duration from file metadata', function () {
      const dur = PlaybackMemory.effectiveDuration({ hls_duration_sec: 3600 }, { duration: 60 });
      expect(dur).to.equal(3600);
    });

    it('should fall back to element duration', function () {
      const dur = PlaybackMemory.effectiveDuration({}, { duration: 120.5 });
      expect(dur).to.equal(120.5);
    });
  });

  describe('computeProgress', function () {
    it('should mark completed at 90%', function () {
      const prog = PlaybackMemory.computeProgress(900, 1000);
      expect(prog.progress_pct).to.equal(90);
      expect(prog.completed).to.be.true;
    });

    it('should not mark completed below 90%', function () {
      const prog = PlaybackMemory.computeProgress(899, 1000);
      expect(prog.completed).to.be.false;
    });
  });

  describe('normalizeProgress', function () {
    it('should treat legacy pos/pct keys as progress', function () {
      const prog = PlaybackMemory.normalizeProgress({ pos: 42, pct: 55 });
      expect(prog.position_seconds).to.equal(42);
      expect(prog.progress_pct).to.equal(55);
    });
  });
});
