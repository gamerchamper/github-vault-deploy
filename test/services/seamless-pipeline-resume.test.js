const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { createMemoryDb, seedTestUser, seedTestRepo } = require('../helpers/setup');
const path = require('path');
const fs = require('fs');

describe('seamless pipeline resume after finalize', function () {
  let db;
  let seamless;
  let userId;
  let fileId;
  let taskId;
  let seamlessDir;
  let hlsCalls;

  beforeEach(function () {
    db = createMemoryDb();
    db.exec('ALTER TABLE files ADD COLUMN upload_account_ids TEXT');
    const user = seedTestUser(db, {
      github_id: 'seamless-resume-user',
      username: 'seamlessuser',
      access_token: 'token',
      master_key: 'x'.repeat(44),
    });
    userId = user.id;
    const repo = seedTestRepo(db, userId, { full_name: 'user/vault', default_branch: 'main' });

    fileId = 'file-ready-hls';
    taskId = 'task-upload-hls';
    seamlessDir = path.join(__dirname, '../../data/seamless-uploads', String(userId), fileId);
    fs.mkdirSync(path.dirname(path.join(seamlessDir, 'source')), { recursive: true });
    fs.writeFileSync(path.join(seamlessDir, 'source'), Buffer.alloc(1000));

    db.prepare(`
      INSERT INTO files (id, user_id, name, path, size, mime_type, parent_path, chunk_count,
        encryption_meta, encryption_mode, upload_status, has_hls)
      VALUES (?, ?, 'video.mkv', '/video.mkv', 1000, 'video/x-matroska', '/', 1,
        '{"wrapped_key":"AAA","wrap_iv":"AAA","wrap_tag":"AAA"}', 'chunk', 'ready', 0)
    `).run(fileId, userId);

    db.prepare(`
      INSERT INTO chunks (file_id, chunk_index, repo_id, repo_path, sha, size, chunk_iv, chunk_tag, plain_size)
      VALUES (?, 0, ?, '.vault/chunks/x/00000.bin', 'sha', 1000, 'iv', 'tag', 1000)
    `).run(fileId, repo.id);

    db.prepare(`
      INSERT INTO tasks (id, user_id, type, status, title, payload, created_at)
      VALUES (?, ?, 'upload', 'error', 'video.mkv', ?, datetime('now'))
    `).run(taskId, userId, JSON.stringify({
      fileId,
      uploadMode: 'seamless',
      convertHls: true,
      seamlessPartsReceived: [0],
      seamlessPartsTotal: 1,
    }));

    hlsCalls = 0;
    const tasks = proxyquire('../../server/services/tasks', { '../db/database': db });
    const mockStorage = {
      getUploadedChunkCount: () => 1,
      getUploadedChunkIndices: () => [0],
      getChunkSizeForFile: () => 1000,
      CHUNK_SIZE: 1000,
      finalizeUpload: async () => ({ id: fileId, alreadyFinalized: true }),
      uploadPlainChunk: async () => ({ skipped: false, chunksDone: 1, totalChunks: 1 }),
      normalizeUploadAccountIds: (v) => v,
    };

    seamless = proxyquire('../../server/services/seamless-upload', {
      '../db/database': db,
      './storage': mockStorage,
      './tasks': tasks,
      './hls-convert': {
        isFfmpegAvailable: async () => true,
        convertFile: async () => {
          hlsCalls += 1;
          return { fileId, hls: true };
        },
      },
      './thumbnails': { previewByteLimit: () => 0 },
    });
  });

  afterEach(function () {
    try { fs.rmSync(path.join(__dirname, '../../data/seamless-uploads'), { recursive: true, force: true }); } catch {}
  });

  it('resumes HLS when upload session is already ready', async function () {
    await seamless.processPipeline(userId, fileId, taskId, { convertHls: true });
    expect(hlsCalls).to.equal(1);

    const task = db.prepare('SELECT status, phase FROM tasks WHERE id = ?').get(taskId);
    expect(task.status).to.equal('done');
    expect(task.phase).to.equal('done');
  });

  it('reports uploadComplete in seamless status for ready files', function () {
    const status = seamless.getSeamlessStatus(userId, fileId);
    expect(status.uploadComplete).to.equal(true);
    expect(status.hlsPending).to.equal(true);
    expect(status.stagingComplete).to.equal(true);
  });
});
