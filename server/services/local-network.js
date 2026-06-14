const os = require('os');
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

function clientOnServerLan(clientIp, serverIfaces) {
  if (!serverIfaces.length) return isLoopbackClientIp(clientIp) || isPrivateIpv4(clientIp);
  if (isLoopbackClientIp(clientIp)) return true;
  if (!isPrivateIpv4(clientIp)) return false;
  return serverIfaces.some((iface) => sameSubnet(clientIp, iface.address, iface.netmask));
}

function browsingViaLocalPath(hostname, serverIfaces) {
  if (hostname === 'localhost' || hostname === '127.0.0.1') return true;
  if (isPrivateIpv4(hostname)) {
    if (!serverIfaces.length) return true;
    return serverIfaces.some((iface) => iface.address === hostname
      || sameSubnet(hostname, iface.address, iface.netmask));
  }
  if (serverIfaces.some((i) => i.address === hostname)) return true;
  return false;
}

function pickLocalUrl(req, clientIp, serverIfaces) {
  if (!serverIfaces.length) return null;
  const port = portFromRequest(req);
  const protocol = req.protocol === 'https' ? 'https' : 'http';
  const match = serverIfaces.find((i) => clientOnServerLan(clientIp, [i]))
    || serverIfaces.find((i) => sameSubnet(clientIp, i.address, i.netmask))
    || serverIfaces[0];
  return `${protocol}://${match.address}:${port}`;
}

function getLocalUploadStatus(req) {
  const clientIp = geoip.getClientIp(req);
  const serverIfaces = getServerIpv4Addresses();
  const serverIpv4 = serverIfaces.map((i) => i.address);
  const hostname = hostFromRequest(req);
  const onLan = clientOnServerLan(clientIp, serverIfaces);
  const active = browsingViaLocalPath(hostname, serverIfaces);
  const localUrl = (!active && onLan && serverIfaces.length)
    ? pickLocalUrl(req, clientIp, serverIfaces)
    : null;

  return {
    active,
    onLan,
    serverIpv4,
    localUrl: active ? null : localUrl,
    hostname,
    clientIp: isPrivateIpv4(clientIp) || isLoopbackClientIp(clientIp) ? clientIp : null,
  };
}

module.exports = {
  isPrivateIpv4,
  sameSubnet,
  getServerIpv4Addresses,
  getLocalUploadStatus,
};
