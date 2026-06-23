const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { createMemoryDb, seedTestUser } = require('../helpers/setup');

function seedBackupFixture(db, userId) {
  const primaryRepo = db.prepare(`
    INSERT INTO storage_repos (user_id, owner, name, full_name, default_branch, linked_account_id, repo_role, is_active, is_metadata)
    VALUES (?, 'primaryuser', 'vault-storage-1', 'primaryuser/vault-storage-1', 'main', NULL, 'primary', 1, 0)
  `).run(userId).lastInsertRowid;

  const fileId = 'file-1';
  db.prepare(`
    INSERT INTO files (id, user_id, name, path, size, upload_status)
    VALUES (?, ?, 'test.bin', '/test.bin', 100, 'ready')
  `).run(fileId, userId);

  const chunkId = db.prepare(`
    INSERT INTO chunks (file_id, chunk_index, repo_id, repo_path, size)
    VALUES (?, 0, ?, 'chunks/test.bin.0', 100)
  `).run(fileId, primaryRepo).lastInsertRowid;

  const insertAccount = (githubId, username, role) => db.prepare(`
    INSERT INTO linked_accounts (user_id, github_id, username, access_token, role, is_active, created_at)
    VALUES (?, ?, ?, 'token', ?, 1, datetime('now'))
  `).run(userId, githubId, username, role).lastInsertRowid;

  const backupA = insertAccount('backup-a', 'backupA', 'backup');
  const backupB = insertAccount('backup-b', 'backupB', 'both');

  for (const [linkedId, username] of [[backupA, 'backupA'], [backupB, 'backupB']]) {
    db.prepare(`
      INSERT INTO storage_repos (user_id, owner, name, full_name, default_branch, linked_account_id, repo_role, mirrors_repo_id, is_active, is_metadata)
      VALUES (?, ?, 'vault-storage-1', ?, 'main', ?, 'backup', ?, 1, 0)
    `).run(userId, username, `${username}/vault-storage-1`, linkedId, primaryRepo);
  }

  return { primaryRepo, chunkId, backupA, backupB };
}

describe('backup sync multiple accounts', function () {
  it('reports sync status independently for each backup account', function () {
    const db = createMemoryDb();
    const user = seedTestUser(db);
    const { backupA, backupB, chunkId } = seedBackupFixture(db, user.id);

    const backupRepoA = db.prepare(`
      SELECT id FROM storage_repos WHERE linked_account_id = ? AND repo_role = 'backup'
    `).get(backupA).id;
    db.prepare('INSERT INTO chunk_backups (chunk_id, repo_id, sha) VALUES (?, ?, ?)')
      .run(chunkId, backupRepoA, 'sha-a');

    const rlMock = {
      keyForToken: () => 'k',
      isPaused: () => false,
      getPauseInfo: () => null,
      setWaitCallback: () => () => {},
      getRecommendedConcurrency: (_key, def) => def,
      runWithSubsystem: (_name, fn) => fn(),
    };

    const backupSync = proxyquire('../../server/services/backup-sync', {
      '../db/database': db,
      './accounts': proxyquire('../../server/services/accounts', { '../db/database': db }),
      './tasks': proxyquire('../../server/services/tasks', { '../db/database': db }),
      './storage-provider': {
        getRateLimit: () => rlMock,
      },
      './github-rate-limit': rlMock,
      './workload-governor': {
        runBackground: (_userId, fn) => fn(),
        shouldDeferBackground: () => false,
      },
      './chunk-lookup-cache': {
        shouldRetrySync: () => true,
        clearSyncFailure: () => {},
        recordSyncFailure: () => {},
        loadSyncFailure: () => null,
        clearSyncFailuresForAccount: () => {},
      },
    });

    const status = backupSync.getSyncStatus(user.id);
    expect(status).to.have.length(2);
    expect(status.find((s) => s.account_id === backupA).up_to_date).to.equal(true);
    expect(status.find((s) => s.account_id === backupB).up_to_date).to.equal(false);
    expect(status.find((s) => s.account_id === backupB).missing_chunks).to.equal(1);
  });

  it('includes both-role accounts alongside dedicated backup accounts', function () {
    const db = createMemoryDb();
    const user = seedTestUser(db);
    const { backupA, backupB } = seedBackupFixture(db, user.id);

    const rlMock = {
      keyForToken: () => 'k',
      isPaused: () => false,
      getPauseInfo: () => null,
      setWaitCallback: () => () => {},
      getRecommendedConcurrency: (_key, def) => def,
      runWithSubsystem: (_name, fn) => fn(),
    };

    const backupSync = proxyquire('../../server/services/backup-sync', {
      '../db/database': db,
      './accounts': proxyquire('../../server/services/accounts', { '../db/database': db }),
      './tasks': proxyquire('../../server/services/tasks', { '../db/database': db }),
      './storage-provider': {
        getRateLimit: () => rlMock,
      },
      './github-rate-limit': rlMock,
      './workload-governor': {
        runBackground: (_userId, fn) => fn(),
        shouldDeferBackground: () => false,
      },
      './chunk-lookup-cache': {
        shouldRetrySync: () => true,
        clearSyncFailure: () => {},
        recordSyncFailure: () => {},
        loadSyncFailure: () => null,
        clearSyncFailuresForAccount: () => {},
      },
    });

    const roles = db.prepare(`
      SELECT id, role FROM linked_accounts WHERE user_id = ? ORDER BY id
    `).all(user.id);
    expect(roles).to.deep.equal([
      { id: backupA, role: 'backup' },
      { id: backupB, role: 'both' },
    ]);

    const status = backupSync.getSyncStatus(user.id);
    expect(status.map((s) => s.account_id)).to.deep.equal([backupA, backupB]);
  });

  it('keeps separate backup-sync tasks per account', function () {
    const db = createMemoryDb();
    const user = seedTestUser(db);
    const { backupA, backupB } = seedBackupFixture(db, user.id);
    const tasks = proxyquire('../../server/services/tasks', { '../db/database': db });

    const taskA = tasks.create(user.id, {
      type: 'backup-sync',
      title: 'Backup sync (@backupA)',
      payload: { accountId: backupA, linkedAccountId: backupA, backupUsername: 'backupA', resumable: true },
    });
    const taskB = tasks.create(user.id, {
      type: 'backup-sync',
      title: 'Backup sync (@backupB)',
      payload: { accountId: backupB, linkedAccountId: backupB, backupUsername: 'backupB', resumable: true },
    });

    const rlMock = {
      keyForToken: (token) => `key-${token}`,
      isPaused: () => false,
      getPauseInfo: () => null,
      setWaitCallback: () => () => {},
      getRecommendedConcurrency: (_key, def) => def,
      runWithSubsystem: (_name, fn) => fn(),
    };

    const backupSync = proxyquire('../../server/services/backup-sync', {
      '../db/database': db,
      './accounts': proxyquire('../../server/services/accounts', { '../db/database': db }),
      './tasks': tasks,
      './storage-provider': {
        getRateLimit: () => rlMock,
      },
      './github-rate-limit': rlMock,
      './workload-governor': {
        runBackground: (_userId, fn) => fn(),
        shouldDeferBackground: () => false,
      },
      './chunk-lookup-cache': {
        shouldRetrySync: () => true,
        clearSyncFailure: () => {},
        recordSyncFailure: () => {},
        loadSyncFailure: () => null,
        clearSyncFailuresForAccount: () => {},
      },
    });

    tasks.create(user.id, {
      type: 'backup-sync',
      title: 'Backup sync (@backupA duplicate)',
      payload: { accountId: backupA, linkedAccountId: backupA, backupUsername: 'backupA', resumable: true },
    });

    backupSync.dedupeAllBackupTasks(user.id);

    const rows = db.prepare(`
      SELECT payload FROM tasks WHERE user_id = ? AND type = 'backup-sync'
    `).all(user.id);
    const accountIds = rows.map((row) => JSON.parse(row.payload).accountId).sort((a, b) => a - b);
    expect(accountIds).to.deep.equal([backupA, backupB]);
    expect(rows.filter((row) => JSON.parse(row.payload).accountId === backupA)).to.have.length(1);
  });
});