const geoCache = new Map();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) return String(forwarded).split(',')[0].trim();
  const realIp = req.headers['x-real-ip'];
  if (realIp) return String(realIp).trim();
  let ip = req.ip || req.socket?.remoteAddress || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;
  if (ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('172.')) return true;
  if (ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) return true;
  return false;
}

function localGeo(ip) {
  return {
    ip,
    city: 'Local',
    region: '',
    country: 'Local network',
    countryCode: 'LAN',
    lat: null,
    lon: null,
    isp: 'Private network',
    timezone: null,
  };
}

async function lookupGeo(ip) {
  if (!ip) return null;
  if (isPrivateIp(ip)) return localGeo(ip);

  const cached = geoCache.get(ip);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const url = `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,message,country,countryCode,regionName,city,lat,lon,isp,timezone,query`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`geo lookup failed (${res.status})`);
    const data = await res.json();
    if (data.status !== 'success') throw new Error(data.message || 'geo lookup failed');

    const geo = {
      ip: data.query || ip,
      city: data.city || '',
      region: data.regionName || '',
      country: data.country || '',
      countryCode: data.countryCode || '',
      lat: data.lat ?? null,
      lon: data.lon ?? null,
      isp: data.isp || '',
      timezone: data.timezone || null,
    };

    geoCache.set(ip, { at: Date.now(), data: geo });
    return geo;
  } catch {
    const fallback = {
      ip,
      city: '',
      region: '',
      country: 'Unknown',
      countryCode: '',
      lat: null,
      lon: null,
      isp: '',
      timezone: null,
    };
    geoCache.set(ip, { at: Date.now(), data: fallback });
    return fallback;
  }
}

module.exports = {
  getClientIp,
  lookupGeo,
  isPrivateIp,
  pruneCache() {
    const now = Date.now();
    let pruned = 0;
    for (const [ip, entry] of geoCache) {
      if (now - entry.at > CACHE_TTL_MS) {
        geoCache.delete(ip);
        pruned += 1;
      }
    }
    return pruned;
  },
  getCacheSize() {
    return geoCache.size;
  },
};
