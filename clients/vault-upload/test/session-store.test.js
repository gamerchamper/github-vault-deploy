const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { SessionStore } = require('../src/session-store');
const { SESSION_DIR } = require('../src/config');

describe('SessionStore', function () {
  beforeEach(function () {
    // Clean session dir
    if (fs.existsSync(SESSION_DIR)) {
      for (const f of fs.readdirSync(SESSION_DIR)) {
        fs.unlinkSync(path.join(SESSION_DIR, f));
      }
    }
  });

  describe('create', function () {
    it('should create a session file with default fields', function () {
      const file = { name: 'test.mp4', path: '/tmp/test.mp4', size: 1000 };
      const session = SessionStore.create('task-1', file);
      expect(session.taskId).to.equal('task-1');
      expect(session.fileName).to.equal('test.mp4');
      expect(session.fileSize).to.equal(1000);
      expect(session.fileId).to.be.null;
      expect(session.status).to.equal('pending');
      expect(session.chunksDone).to.equal(0);
      expect(session.createdAt).to.be.a('number');
    });

    it('should persist to disk', function () {
      const file = { name: 'persist.mp4', path: '/tmp/persist.mp4', size: 5000 };
      SessionStore.create('task-persist', file);
      const loaded = SessionStore.get('task-persist');
      expect(loaded).to.not.be.null;
      expect(loaded.fileName).to.equal('persist.mp4');
    });
  });

  describe('get', function () {
    it('should return null for non-existent task', function () {
      expect(SessionStore.get('nonexistent')).to.be.null;
    });

    it('should return the saved session', function () {
      SessionStore.create('task-get', { name: 'get.mp4', path: '/tmp/get.mp4', size: 100 });
      const s = SessionStore.get('task-get');
      expect(s.taskId).to.equal('task-get');
    });
  });

  describe('save', function () {
    it('should update fields on disk', function () {
      SessionStore.create('task-save', { name: 'save.mp4', path: '/tmp/save.mp4', size: 100 });
      const s = SessionStore.get('task-save');
      s.chunksDone = 5;
      s.status = 'uploading';
      SessionStore.save(s);
      const reloaded = SessionStore.get('task-save');
      expect(reloaded.chunksDone).to.equal(5);
      expect(reloaded.status).to.equal('uploading');
    });
  });

  describe('remove', function () {
    it('should delete the session file', function () {
      SessionStore.create('task-remove', { name: 'rm.mp4', path: '/tmp/rm.mp4', size: 100 });
      expect(SessionStore.get('task-remove')).to.not.be.null;
      SessionStore.remove('task-remove');
      expect(SessionStore.get('task-remove')).to.be.null;
    });
  });

  describe('list', function () {
    it('should return all sessions', function () {
      SessionStore.create('list-1', { name: 'a.mp4', path: '/tmp/a.mp4', size: 100 });
      SessionStore.create('list-2', { name: 'b.mp4', path: '/tmp/b.mp4', size: 200 });
      const all = SessionStore.list();
      expect(all.length).to.equal(2);
    });
  });

  describe('listInterrupted', function () {
    it('should only return interrupted sessions', function () {
      SessionStore.create('done-task', { name: 'done.mp4', path: '/tmp/done.mp4', size: 100 });
      const s1 = SessionStore.get('done-task');
      s1.status = 'done';
      SessionStore.save(s1);

      SessionStore.create('err-task', { name: 'err.mp4', path: '/tmp/err.mp4', size: 100 });
      const s2 = SessionStore.get('err-task');
      s2.status = 'error';
      SessionStore.save(s2);

      SessionStore.create('uploading-task', { name: 'up.mp4', path: '/tmp/up.mp4', size: 100 });
      const s3 = SessionStore.get('uploading-task');
      s3.status = 'uploading';
      SessionStore.save(s3);

      const interrupted = SessionStore.listInterrupted();
      expect(interrupted.length).to.equal(2);
      expect(interrupted.map(s => s.taskId).sort()).to.deep.equal(['err-task', 'uploading-task']);
    });
  });

  describe('generateTaskId', function () {
    it('should generate unique task IDs', function () {
      const ids = new Set();
      for (let i = 0; i < 100; i++) {
        ids.add(SessionStore.generateTaskId());
      }
      expect(ids.size).to.equal(100);
    });

    it('should have vault-cli prefix', function () {
      expect(SessionStore.generateTaskId()).to.match(/^vault-cli-/);
    });
  });
});
