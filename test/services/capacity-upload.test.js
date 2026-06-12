const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { createMemoryDb, seedTestUser, seedTestRepo, seedTestFile } = require('../helpers/setup');

describe('upload capacity with HLS reserve', function () {
  let db;
  let capacity;
  let userId;

  beforeEach(function () {
    db = createMemoryDb();
    const user = seedTestUser(db, { github_id: 'cap-upload-user', username: 'capupload' });
    userId = user.id;
    seedTestRepo(db, userId, { full_name: 'test/caprepo', default_branch: 'main' });
    db.prepare('UPDATE storage_repos SET total_bytes = 0, reserved_bytes = 0 WHERE user_id = ?').run(userId);
    capacity = proxyquire('../../server/services/capacity', {
      '../db/database': db,
    });
  });

  it('counts encrypted file and HLS segments in total storage projection', function () {
    const repos = db.prepare('SELECT * FROM storage_repos WHERE user_id = ?').all(userId);
    const plain = capacity.projectUploadStorage(repos, 500_000_000, 900_000, false);
    const withHls = capacity.projectUploadStorage(repos, 500_000_000, 900_000, true);

    expect(withHls.totalBytes).to.be.greaterThan(plain.totalBytes);
    expect(withHls.hlsBytes).to.be.greaterThan(400_000_000);
    expect(withHls.uploadBytes).to.equal(plain.uploadBytes);
  });

  it('reserves HLS bytes on repos until segments are uploaded', function () {
    const repos = db.prepare('SELECT * FROM storage_repos WHERE user_id = ?').all(userId);
    seedTestFile(db, userId, { id: 'file-hls-1', name: 'clip.mp4', path: '/clip.mp4', upload_status: 'uploading' });
    capacity.reserveHlsStorage(userId, 'file-hls-1', 100_000_000, repos);

    const repo = db.prepare('SELECT reserved_bytes, total_bytes FROM storage_repos WHERE user_id = ?').get(userId);
    expect(repo.reserved_bytes).to.equal(capacity.estimateHlsBytes(100_000_000));
    expect(repo.total_bytes).to.equal(0);

    capacity.consumeHlsReserve(userId, 'file-hls-1', repos[0].id, 2_000_000);
    const after = db.prepare('SELECT reserved_bytes, total_bytes FROM storage_repos WHERE user_id = ?').get(userId);
    expect(after.reserved_bytes).to.equal(capacity.estimateHlsBytes(100_000_000) - 2_000_000);
  });

  it('marks a nearly full repo as insufficient when HLS is enabled', function () {
    db.prepare(`
      UPDATE storage_repos
      SET total_bytes = ?
      WHERE user_id = ?
    `).run(capacity.REPO_CAPACITY_BYTES - 20_000_000, userId);

    const repos = db.prepare('SELECT * FROM storage_repos WHERE user_id = ?').all(userId);
    const projection = capacity.projectUploadStorage(repos, 500_000_000, 900_000, true);
    expect(projection.fits).to.equal(false);
    expect(projection.insufficientBytes).to.be.greaterThan(0);
  });
});
