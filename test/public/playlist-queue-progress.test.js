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

  it('should merge stored progress for all playlist items', function () {
    const store = {};
    global.localStorage = {
      getItem(k) { return store[k] ?? null; },
      setItem(k, v) { store[k] = v; },
      removeItem(k) { delete store[k]; },
      key(i) { return Object.keys(store)[i] ?? null; },
      get length() { return Object.keys(store).length; },
    };

    PlaylistQueue.reset();
    PlaylistQueue.setFromPlaylist({
      id: 'pl1',
      title: 'Test',
      items: [
        { id: 'a', name: 'A.mp4' },
        { id: 'b', name: 'B.mp4' },
      ],
    }, null);

    PlaybackMemory.write(PlaybackMemory.storageKey('a', 'pl1'), { pos: 120, pct: 40, completed: false });
    PlaybackMemory.write(PlaybackMemory.storageKey('b', 'pl1'), { pos: 0, pct: 100, completed: true, seen: true });

    PlaylistQueue.loadStoredProgress();
    expect(PlaylistQueue.getProgress('a').progress_pct).to.equal(40);
    expect(PlaylistQueue.getProgress('b').completed).to.be.true;
  });
});
