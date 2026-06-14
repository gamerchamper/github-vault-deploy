const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { createMemoryDb, seedTestUser } = require('../helpers/setup');

describe('local-auth', function () {
  describe('isLocalHostRequest', function () {
    it('accepts localhost and matching server LAN addresses', function () {
      const localAuth = proxyquire('../../server/services/local-auth', {
        './local-network': {
          hostFromRequest: (req) => req._hostname,
          isPrivateIpv4: (ip) => ip.startsWith('192.168.') || ip === '127.0.0.1',
          getServerIpv4Addresses: () => [{ address: '192.168.1.163', netmask: '255.255.255.0' }],
          sameSubnet: (a, b) => a.split('.').slice(0, 3).join('.') === b.split('.').slice(0, 3).join('.'),
        },
        '../db/database': createMemoryDb(),
      });

      expect(localAuth.isLocalHostRequest({ _hostname: 'localhost' })).to.equal(true);
      expect(localAuth.isLocalHostRequest({ _hostname: '127.0.0.1' })).to.equal(true);
      expect(localAuth.isLocalHostRequest({ _hostname: '192.168.1.163' })).to.equal(true);
      expect(localAuth.isLocalHostRequest({ _hostname: 'vault.example.com' })).to.equal(false);
    });
  });

  describe('localAuthMiddleware', function () {
    it('logs in the primary user on local host requests', function (done) {
      const db = createMemoryDb();
      const user = seedTestUser(db, { github_id: 'local-user', username: 'localuser' });
      const localAuth = proxyquire('../../server/services/local-auth', {
        '../db/database': db,
        './local-network': {
          hostFromRequest: () => '192.168.1.163',
          isPrivateIpv4: () => true,
          getServerIpv4Addresses: () => [{ address: '192.168.1.163', netmask: '255.255.255.0' }],
          sameSubnet: () => true,
        },
      });
      const { localAuthMiddleware } = proxyquire('../../server/middleware/local-auth', {
        '../services/local-auth': localAuth,
        '../services/audit': { log: () => {} },
      });

      const req = {
        path: '/auth/me',
        isAuthenticated: () => false,
        session: {},
        ip: '192.168.1.10',
        logIn: (loggedInUser, cb) => {
          req.user = loggedInUser;
          cb(null);
        },
      };

      localAuthMiddleware(req, {}, () => {
        expect(req.user.id).to.equal(user.id);
        expect(req.authType).to.equal('local');
        done();
      });
    });

    it('does not auto-login on public hostnames', function (done) {
      const db = createMemoryDb();
      seedTestUser(db, { github_id: 'local-user-2', username: 'localuser2' });
      const localAuth = proxyquire('../../server/services/local-auth', {
        '../db/database': db,
        './local-network': {
          hostFromRequest: () => 'vault.example.com',
          isPrivateIpv4: () => false,
          getServerIpv4Addresses: () => [{ address: '192.168.1.163', netmask: '255.255.255.0' }],
          sameSubnet: () => false,
        },
      });
      const { localAuthMiddleware } = proxyquire('../../server/middleware/local-auth', {
        '../services/local-auth': localAuth,
      });

      const req = {
        path: '/auth/me',
        isAuthenticated: () => false,
        logIn: () => done(new Error('should not log in')),
      };

      localAuthMiddleware(req, {}, done);
    });
  });
});
