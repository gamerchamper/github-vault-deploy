const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { createMemoryDb, seedTestUser, seedTestFile, seedTestRepo } = require('../helpers/setup');
const { estimateMinHlsSegmentCount } = require('../../server/services/capacity');

describe('HLS convert recovery', function () {
  let db;
  let hlsConvert;
  let user;

  beforeEach(function () {
    db = createMemoryDb();
    user = seedTestUser(db, { github_id: 'hls-recovery-user', username: 'hlsrecovery' });
    seedTestRepo(db, user.id, { full_name: 'test/hlsrepo' });

    hlsConvert = proxyquire('../../server/services/hls-convert', {
      '../db/database': db,
    });
  });

  it('estimateMinHlsSegmentCount expects many segments for multi-GB files', function () {
    const twoGb = 2 * 1024 * 1024 * 1024;
    expect(estimateMinHlsSegmentCount(twoGb)).to.be.at.least(50);
  });

  it('marks single partial segment as not recoverable for large files', function () {
    const file = seedTestFile(db, user.id, {
      id: 'big-video',
      name: 'movie.mp4',
      size: 2 * 1024 * 1024 * 1024,
      mime_type: 'video/mp4',
    });
    db.prepare(`
      INSERT INTO hls_segments (file_id, segment_index, duration, repo_id, repo_path, sha, size)
      VALUES (?, 16, 6, 1, '.vault/hls/big-video/00016.dat', 'abc', 1200)
    `).run(file.id);

    const state = hlsConvert.analyzeHlsSegmentState(file.id, file.size);
    expect(state.count).to.equal(1);
    expect(state.recoverable).to.equal(false);
    expect(state.gaps.length).to.be.greaterThan(0);
  });

  it('marks contiguous full segment set as recoverable', function () {
    const file = seedTestFile(db, user.id, {
      id: 'small-video',
      name: 'clip.mp4',
      size: 8 * 1024 * 1024,
      mime_type: 'video/mp4',
    });
    const min = estimateMinHlsSegmentCount(file.size);
    for (let i = 0; i < min; i++) {
      db.prepare(`
        INSERT INTO hls_segments (file_id, segment_index, duration, repo_id, repo_path, sha, size)
        VALUES (?, ?, 6, 1, ?, 'abc', 1200)
      `).run(file.id, i, `.vault/hls/small-video/${String(i).padStart(5, '0')}.dat`);
    }

    const state = hlsConvert.analyzeHlsSegmentState(file.id, file.size);
    expect(state.count).to.equal(min);
    expect(state.recoverable).to.equal(true);
  });
});
