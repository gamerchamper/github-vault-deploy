const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { createMemoryDb, seedTestUser, seedTestFile } = require('../helpers/setup');

describe('tasks HLS upload cleanup', function () {
  let db;
  let tasks;
  let userId;

  beforeEach(function () {
    db = createMemoryDb();
    const user = seedTestUser(db, { github_id: 'tasks-hls-user', username: 'taskshls' });
    userId = user.id;
    tasks = proxyquire('../../server/services/tasks', {
      '../db/database': db,
      './backup-sync': { dedupeAllBackupTasks: () => {} },
    });
  });

  it('does not auto-complete upload tasks while HLS conversion is still pending', function () {
    const file = seedTestFile(db, userId, {
      id: 'hls-pending-file',
      name: 'clip.mp4',
      path: '/clip.mp4',
      upload_status: 'ready',
      mime_type: 'video/mp4',
    });
    db.prepare('UPDATE files SET has_hls = 0 WHERE id = ?').run(file.id);

    tasks.create(userId, {
      id: 'upload-hls-task',
      type: 'upload',
      title: 'clip.mp4',
      payload: {
        fileId: file.id,
        convertHls: true,
        resumable: true,
      },
    });
    tasks.update('upload-hls-task', userId, {
      status: 'processing',
      phase: 'hls-convert',
      percent: 10,
    });

    const listed = tasks.list(userId, { includeResumable: true });
    const row = listed.find((t) => t.id === 'upload-hls-task');
    expect(row).to.exist;
    expect(row.status).to.equal('processing');
    expect(row.phase).to.equal('hls-convert');
  });

  it('auto-completes upload tasks when convertHls is false and file is ready', function () {
    const file = seedTestFile(db, userId, {
      id: 'plain-file',
      name: 'doc.bin',
      path: '/doc.bin',
      upload_status: 'ready',
    });

    tasks.create(userId, {
      id: 'upload-plain-task',
      type: 'upload',
      title: 'doc.bin',
      payload: { fileId: file.id, convertHls: false, resumable: true },
    });
    tasks.update('upload-plain-task', userId, { status: 'processing', phase: 'metadata', percent: 96 });

    tasks.list(userId, { includeResumable: true });
    const row = tasks.get('upload-plain-task', userId);
    expect(row?.status).to.equal('done');
  });
});
