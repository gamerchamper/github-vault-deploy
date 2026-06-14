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

describe('playlist-queue progress', function () {
  let PlaylistQueue;

  before(function () {
    global.PlaybackMemory = loadClientModule('../public/js/playback-memory.js');
    PlaylistQueue = loadClientModule('../public/js/playlist-queue.js');
  });

  it('should treat 90% as seen', function () {
    expect(PlaylistQueue.isSeen({ progress_pct: 89, completed: false })).to.be.false;
    expect(PlaylistQueue.isSeen({ progress_pct: 90, completed: false })).to.be.true;
    expect(PlaylistQueue.isSeen({ progress_pct: 10, completed: true })).to.be.true;
  });

  it('should normalize completed progress on setProgress', function () {
    PlaylistQueue.setProgress('f1', { progress_pct: 92, completed: false, position_seconds: 100 });
    const prog = PlaylistQueue.getProgress('f1');
    expect(prog.completed).to.be.true;
    expect(prog.progress_pct).to.equal(100);
  });
});
