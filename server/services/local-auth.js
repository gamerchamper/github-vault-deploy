const db = require('../db/database');
const localNetwork = require('./local-network');

function isEnabled() {
  const raw = String(process.env.LOCAL_AUTH ?? 'true').trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'no' && raw !== 'off';
}

function isLocalHostRequest(req) {
  const hostname = localNetwork.hostFromRequest(req);
  if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
  if (!localNetwork.isPrivateIpv4(hostname)) return false;

  const serverIfaces = localNetwork.getServerIpv4Addresses();
  if (!serverIfaces.length) return true;

  return serverIfaces.some((iface) => iface.address === hostname
    || localNetwork.sameSubnet(hostname, iface.address, iface.netmask));
}

function getPrimaryUser() {
  const configuredId = parseInt(process.env.LOCAL_AUTH_USER_ID, 10);
  if (Number.isFinite(configuredId) && configuredId > 0) {
    const user = db.prepare(
      'SELECT id, github_id, username, avatar_url FROM users WHERE id = ?'
    ).get(configuredId);
    if (user) return user;
  }

  return db.prepare(
    'SELECT id, github_id, username, avatar_url FROM users ORDER BY id ASC LIMIT 1'
  ).get();
}

function getStatus(req) {
  const enabled = isEnabled();
  const localHost = isLocalHostRequest(req);
  const user = getPrimaryUser();

  return {
    enabled,
    eligible: enabled && localHost,
    needs_setup: enabled && localHost && !user,
  };
}

function shouldSkipPath(req) {
  const path = req.path || '';
  if (path === '/auth/github' || path.startsWith('/auth/github/')) return true;
  return false;
}

module.exports = {
  isEnabled,
  isLocalHostRequest,
  getPrimaryUser,
  getStatus,
  shouldSkipPath,
};
