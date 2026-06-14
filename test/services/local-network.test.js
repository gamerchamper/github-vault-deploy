const { expect } = require('chai');
const localNetwork = require('../../server/services/local-network');

describe('local-network', function () {
  describe('isPrivateIpv4', function () {
    it('detects RFC1918 and loopback', function () {
      expect(localNetwork.isPrivateIpv4('192.168.1.5')).to.equal(true);
      expect(localNetwork.isPrivateIpv4('10.0.0.2')).to.equal(true);
      expect(localNetwork.isPrivateIpv4('172.16.0.1')).to.equal(true);
      expect(localNetwork.isPrivateIpv4('127.0.0.1')).to.equal(true);
    });

    it('rejects public and invalid addresses', function () {
      expect(localNetwork.isPrivateIpv4('8.8.8.8')).to.equal(false);
      expect(localNetwork.isPrivateIpv4('172.15.0.1')).to.equal(false);
      expect(localNetwork.isPrivateIpv4('not-an-ip')).to.equal(false);
    });
  });

  describe('sameSubnet', function () {
    it('matches addresses in the same /24', function () {
      expect(localNetwork.sameSubnet('192.168.1.10', '192.168.1.50', '255.255.255.0')).to.equal(true);
      expect(localNetwork.sameSubnet('192.168.1.10', '192.168.2.50', '255.255.255.0')).to.equal(false);
    });
  });

  describe('getLocalUploadStatus', function () {
    it('marks localhost browsing as active local upload', function () {
      const req = {
        protocol: 'http',
        get(name) {
          if (name === 'host') return 'localhost:3000';
          return undefined;
        },
        ip: '127.0.0.1',
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
      };
      const status = localNetwork.getLocalUploadStatus(req);
      expect(status.active).to.equal(true);
      expect(status.hostname).to.equal('localhost');
    });

    it('uses saved user IPv4 on domain host', function () {
      const db = require('../../server/db/database');
      const user = db.prepare('SELECT id FROM users LIMIT 1').get();
      if (!user) return this.skip();

      localNetwork.setUserLocalUploadIpv4(user.id, '192.168.1.50');
      const req = {
        protocol: 'http',
        get(name) {
          if (name === 'host') return 'vault.example.com';
          return undefined;
        },
        ip: '203.0.113.10',
        headers: {},
        socket: { remoteAddress: '203.0.113.10' },
      };
      const status = localNetwork.getLocalUploadStatus(req, user.id);
      expect(status.configured).to.equal(true);
      expect(status.configuredIpv4).to.equal('192.168.1.50');
      expect(status.active).to.equal(false);
      expect(status.localUrl).to.equal('http://192.168.1.50:3000');
      localNetwork.setUserLocalUploadIpv4(user.id, null);
    });

    it('suggests local URL when client is on LAN but host is remote', function () {
      const req = {
        protocol: 'http',
        get(name) {
          if (name === 'host') return 'vault.example.com';
          return undefined;
        },
        ip: '192.168.1.50',
        headers: { 'x-forwarded-for': '192.168.1.50' },
        socket: { remoteAddress: '192.168.1.50' },
      };
      const orig = localNetwork.getServerIpv4Addresses;
      localNetwork.getServerIpv4Addresses = () => ([
        { address: '192.168.1.5', netmask: '255.255.255.0' },
      ]);
      try {
        const status = localNetwork.getLocalUploadStatus(req);
        expect(status.onLan).to.equal(true);
        expect(status.active).to.equal(false);
        expect(status.localUrl).to.match(/^http:\/\/192\.168\.1\.5:\d+$/);
      } finally {
        localNetwork.getServerIpv4Addresses = orig;
      }
    });
  });
});
