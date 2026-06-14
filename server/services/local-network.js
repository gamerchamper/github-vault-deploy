const os = require('os');
const db = require('../db/database');
const geoip = require('./geoip');

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, oct) => ((acc << 8) + parseInt(oct, 10)) >>> 0, 0);
}

function isPrivateIpv4(ip) {
  if (!ip || typeof ip !== 'string' || ip.includes(':')) return false;
  const parts = ip.split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return false;
  if (parts[0] === 10) return true;
  if (parts[0] === 192 && parts[1] === 168) return true;
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
  if (parts[0] === 127) return true;
  return false;
}

function normalizeIpv4(raw) {
  const ip = String(raw || '').trim();
  if (!ip) return null;
  if (!isPrivateIpv4(ip)) {
    throw new Error('Enter a private IPv4 address (e.g. 192.168.1.100)');
  }
  return ip;
}

function isLoopbackClientIp(ip) {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost';
}

function sameSubnet(ipA, ipB, netmask) {
  if (!ipA || !ipB || !netmask) return false;
  if (!isPrivateIpv4(ipA) || !isPrivateIpv4(ipB)) return false;
  const mask = ipv4ToInt(netmask);
  return (ipv4ToInt(ipA) & mask) === (ipv4ToInt(ipB) & mask);
}

function envServerIpv4() {
  const raw = process.env.LOCAL_UPLOAD_IPV4 || process.env.SERVER_LAN_IPV4 || '';
  return raw.split(/[\s,;]+/).map((s) => s.trim()).filter(isPrivateIpv4);
}

function getServerIpv4Addresses() {
  const addrs = [];
  for (const envIp of envServerIpv4()) {
    addrs.push({ address: envIp, netmask: '255.255.255.0', source: 'env' });
  }
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      const family = iface.family === 'IPv4' || iface.family === 4;
      if (!family || iface.internal) continue;
      if (!isPrivateIpv4(iface.address)) continue;
      addrs.push({
        address: iface.address,
        netmask: iface.netmask || '255.255.255.0',
        source: 'interface',
      });
    }
  }
  const seen = new Set();
  return addrs.filter((a) => {
    if (seen.has(a.address)) return false;
    seen.add(a.address);
    return true;
  });
}

function getUserLocalUploadIpv4(userId) {
  const row = db.prepare('SELECT local_upload_ipv4 FROM users WHERE id = ?').get(userId);
  const saved = row?.local_upload_ipv4?.trim();
  return saved && isPrivateIpv4(saved) ? saved : null;
}

function setUserLocalUploadIpv4(userId, rawIpv4) {
  const ip = rawIpv4 ? normalizeIpv4(rawIpv4) : null;
  db.prepare('UPDATE users SET local_upload_ipv4 = ? WHERE id = ?').run(ip, userId);
  return ip;
}

function hostFromRequest(req) {
  const host = req.get('host') || '';
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end > 0 ? host.slice(1, end).toLowerCase() : host.toLowerCase();
  }
  return host.split(':')[0].toLowerCase();
}

function portFromRequest(req) {
  const host = req.get('host') || '';
  if (host.startsWith('[')) {
    const portPart = host.split(']:')[1];
    if (portPart) return portPart;
  } else {
    const idx = host.lastIndexOf(':');
    if (idx > -1) return host.slice(idx + 1);
  }
  return String(process.env.PORT || 3000);
}

function buildLocalUrl(req, ipv4) {
  if (!ipv4) return null;
  const port = portFromRequest(req);
  const protocol = req.protocol === 'https' ? 'https' : 'http';
  return `${protocol}://${ipv4}:${port}`;
}

function clientOnServerLan(clientIp, serverIfaces, configuredIpv4) {
  if (configuredIpv4 && (isLoopbackClientIp(clientIp) || isPrivateIpv4(clientIp))) {
    if (isLoopbackClientIp(clientIp)) return true;
    if (sameSubnet(clientIp, configuredIpv4, '255.255.255.0')) return true;
  }
  if (!serverIfaces.length) return isLoopbackClientIp(clientIp) || isPrivateIpv4(clientIp);
  if (isLoopbackClientIp(clientIp)) return true;
  if (!isPrivateIpv4(clientIp)) return false;
  return serverIfaces.some((iface) => sameSubnet(clientIp, iface.address, iface.netmask));
}

function browsingViaLocalPath(hostname, serverIfaces, configuredIpv4) {
  if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
  if (configuredIpv4 && hostname === configuredIpv4) return true;
  if (isPrivateIpv4(hostname)) {
    if (configuredIpv4 && hostname === configuredIpv4) return true;
    if (!serverIfaces.length) return true;
    return serverIfaces.some((iface) => iface.address === hostname
      || sameSubnet(hostname, iface.address, iface.netmask));
  }
  if (serverIfaces.some((i) => i.address === hostname)) return true;
  return false;
}

function getLocalUploadStatus(req, userId = null) {
  const clientIp = geoip.getClientIp(req);
  const serverIfaces = getServerIpv4Addresses();
  const detectedIpv4 = serverIfaces.map((i) => i.address);
  const configuredIpv4 = userId ? getUserLocalUploadIpv4(userId) : null;
  const serverIpv4 = [...new Set([
    ...(configuredIpv4 ? [configuredIpv4] : []),
    ...detectedIpv4,
  ])];
  const hostname = hostFromRequest(req);
  const onLan = clientOnServerLan(clientIp, serverIfaces, configuredIpv4);
  const active = browsingViaLocalPath(hostname, serverIfaces, configuredIpv4);
  const localUrl = configuredIpv4
    ? buildLocalUrl(req, configuredIpv4)
    : ((!active && onLan && serverIfaces.length)
      ? buildLocalUrl(req, (serverIfaces.find((i) => clientOnServerLan(clientIp, [i], null))
        || serverIfaces[0])?.address)
      : null);

  return {
    active,
    onLan,
    configured: !!configuredIpv4,
    configuredIpv4,
    serverIpv4,
    detectedIpv4,
    localUrl: active ? null : localUrl,
    hostname,
    clientIp: isPrivateIpv4(clientIp) || isLoopbackClientIp(clientIp) ? clientIp : null,
  };
}

module.exports = {
  isPrivateIpv4,
  normalizeIpv4,
  sameSubnet,
  hostFromRequest,
  getServerIpv4Addresses,
  getUserLocalUploadIpv4,
  setUserLocalUploadIpv4,
  getLocalUploadStatus,
};
