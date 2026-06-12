const { expect } = require('chai');
const sinon = require('sinon');

describe('share-presence service', function () {
  let presence;
  let clock;

  before(function () {
    presence = require('../../server/services/share-presence');
  });

  beforeEach(function () {
    clock = sinon.useFakeTimers(new Date('2026-06-10T12:00:00Z').getTime());
  });

  afterEach(function () {
    clock.restore();
  });

  describe('guestProfile', function () {
    it('should generate deterministic name, color, initials from viewerId', function () {
      const p1 = presence.guestProfile('abc123');
      expect(p1.name).to.be.a('string');
      expect(p1.name).to.include(' ');
      expect(p1.color).to.match(/^#[0-9a-f]{6}$/);
      expect(p1.initials).to.match(/^[A-Z]{2}$/);

      const p2 = presence.guestProfile('abc123');
      expect(p2).to.deep.equal(p1);
    });

    it('should produce different names for different viewerIds', function () {
      const p1 = presence.guestProfile('aaaa');
      const p2 = presence.guestProfile('bbbb');
      expect(p1.name).to.not.equal(p2.name);
    });
  });

  describe('join / heartbeat / leave / listViewers', function () {
    const TOKEN = 'share-token-1';
    const VIEWER1 = 'viewer-uuid-1';
    const VIEWER2 = 'viewer-uuid-2';

    it('should allow a viewer to join a room', function () {
      const result = presence.join(TOKEN, VIEWER1);
      expect(result.id).to.equal(VIEWER1);
      expect(result.name).to.be.a('string');
      expect(result.joinedAt).to.be.a('number');
    });

    it('should list joined viewers', function () {
      const viewers = presence.listViewers(TOKEN);
      expect(viewers).to.be.an('array');
      expect(viewers.length).to.equal(1);
      expect(viewers[0].id).to.equal(VIEWER1);
    });

    it('should assign the same name on rejoin', function () {
      const first = presence.join(TOKEN, VIEWER1);
      clock.tick(1000);
      const second = presence.join(TOKEN, VIEWER1);

      expect(second.name).to.equal(first.name);
      expect(second.joinedAt).to.equal(first.joinedAt);
    });

    it('should allow a second viewer and maintain order', function () {
      const second = presence.join(TOKEN, VIEWER2);
      expect(second.id).to.equal(VIEWER2);

      const viewers = presence.listViewers(TOKEN);
      expect(viewers.length).to.equal(2);
      expect(viewers[0].id).to.equal(VIEWER1);
      expect(viewers[1].id).to.equal(VIEWER2);
    });

    it('heartbeat should update lastSeen and return viewer', function () {
      clock.tick(5000);
      const result = presence.heartbeat(TOKEN, VIEWER1);
      expect(result).to.not.be.null;
      expect(result.id).to.equal(VIEWER1);
    });

    it('heartbeat should return null for unknown token/viewer', function () {
      const result = presence.heartbeat(TOKEN, 'unknown-viewer');
      expect(result).to.be.null;

      const result2 = presence.heartbeat('unknown-token', VIEWER1);
      expect(result2).to.be.null;
    });

    it('should remove a viewer on leave', function () {
      presence.leave(TOKEN, VIEWER2);
      const viewers = presence.listViewers(TOKEN);
      expect(viewers.length).to.equal(1);
      expect(viewers[0].id).to.equal(VIEWER1);
    });

    it('should clean up empty rooms', function () {
      const TOKEN2 = 'share-token-cleanup';
      presence.join(TOKEN2, 'v1');
      presence.join(TOKEN2, 'v2');
      presence.leave(TOKEN2, 'v1');
      presence.leave(TOKEN2, 'v2');

      const viewers = presence.listViewers(TOKEN2);
      expect(viewers.length).to.equal(0);
    });

    it('should prune stale viewers after TTL', function () {
      const TOKEN3 = 'share-token-ttl';
      presence.join(TOKEN3, 'v1');

      clock.tick(presence.TTL_MS + 1000);

      const viewers = presence.listViewers(TOKEN3);
      expect(viewers.length).to.equal(0);
    });
  });

  describe('setRoomMeta / getRoomMeta', function () {
    it('should store and retrieve room metadata', function () {
      presence.setRoomMeta('token-meta', { userId: 1, fileId: 'f1', fileName: 'test.mp4' });
      const meta = presence.getRoomMeta('token-meta');
      expect(meta.userId).to.equal(1);
      expect(meta.fileId).to.equal('f1');
      expect(meta.fileName).to.equal('test.mp4');
    });

    it('should return null for unknown room', function () {
      expect(presence.getRoomMeta('nonexistent')).to.be.null;
    });

    it('should be deleted when room is vacated', function () {
      presence.setRoomMeta('token-vacate', { userId: 1, fileId: 'f1' });
      presence.join('token-vacate', 'v1');
      presence.leave('token-vacate', 'v1');

      expect(presence.getRoomMeta('token-vacate')).to.be.null;
    });
  });

  describe('listViewersDetailed', function () {
    it('should include detailed info', function () {
      const TOKEN = 'token-detailed';
      presence.join(TOKEN, 'v1', { ip: '1.2.3.4', userAgent: 'TestAgent' });
      clock.tick(1000);

      const detailed = presence.listViewersDetailed(TOKEN);
      expect(details => {
        expect(detailed.length).to.equal(1);
        expect(detailed[0].ip).to.equal('1.2.3.4');
        expect(detailed[0].userAgent).to.equal('TestAgent');
        expect(detailed[0].activeMs).to.be.at.least(1000);
      });
    });
  });
});
