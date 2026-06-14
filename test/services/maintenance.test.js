const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { createMemoryDb, seedTestUser } = require('../helpers/setup');

describe('maintenance', function () {
  let db;
  let maintenance;

  before(function () {
    db = createMemoryDb();
    seedTestUser(db, { github_id: 'maint-user' });
    maintenance = proxyquire('../../server/services/maintenance', {
      '../db/database': db,
      './cache': { cacheDir: require('path').join(require('os').tmpdir(), 'vault-maint-test-cache') },
    });
  });

  it('prunes old bandwidth log rows', function () {
    db.prepare(`
      INSERT INTO bandwidth_log (user_id, file_id, bytes, type, recorded_at)
      VALUES (1, 'f1', 100, 'stream', datetime('now', '-40 days'))
    `).run();
    db.prepare(`
      INSERT INTO bandwidth_log (user_id, file_id, bytes, type, recorded_at)
      VALUES (1, 'f2', 200, 'stream', datetime('now', '-1 day'))
    `).run();

    const deleted = maintenance.pruneBandwidthLog();
    expect(deleted).to.equal(1);
    const remaining = db.prepare('SELECT COUNT(*) AS c FROM bandwidth_log').get();
    expect(remaining.c).to.equal(1);
  });

  it('checkpoints WAL without throwing', function () {
    expect(maintenance.checkpointWal()).to.equal(true);
  });
});
