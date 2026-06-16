const mp4 = require('./mp4');
const plexBridge = require('./plex-bridge');
const plexMediaProbe = require('./plex-media-probe');

async function readResponseBody(res, maxBytes = 131072) {
  if (!res.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    const buf = Buffer.from(chunk);
    chunks.push(buf);
    total += buf.length;
    if (total >= maxBytes) break;
  }
  return Buffer.concat(chunks).subarray(0, maxBytes);
}

async function checkHead(streamUrl, userAgent) {
  const res = await fetch(streamUrl, {
    method: 'HEAD',
    headers: { 'User-Agent': userAgent },
    signal: AbortSignal.timeout(30000),
  });
  return {
    ok: res.ok,
    status: res.status,
    content_type: res.headers.get('content-type'),
    content_length: res.headers.get('content-length'),
    accept_ranges: res.headers.get('accept-ranges'),
  };
}

async function checkRange(streamUrl, userAgent) {
  const res = await fetch(streamUrl, {
    headers: {
      'User-Agent': userAgent,
      Range: 'bytes=0-65535',
    },
    signal: AbortSignal.timeout(90000),
  });
  const body = await readResponseBody(res, 65536);
  const ascii = body.toString('ascii');
  return {
    ok: res.ok,
    status: res.status,
    content_type: res.headers.get('content-type'),
    content_range: res.headers.get('content-range'),
    bytes_read: body.length,
    has_ftyp: ascii.includes('ftyp'),
    has_moov: ascii.includes('moov'),
  };
}

async function testStreamForPlex(userId, file, req) {
  const streamUrl = plexBridge.strmUrl(req, {
    id: file.id,
    name: file.name,
    display_name: file.name,
    mime_type: file.mime_type,
    title: file.name,
  });
  const userAgent = plexMediaProbe.FFPROBE_UA;
  const checks = {
    stream_url: streamUrl,
    head: null,
    range: null,
    ffprobe: null,
  };
  const issues = [];

  try {
    checks.head = await checkHead(streamUrl, userAgent);
    if (!checks.head.ok) issues.push(`HEAD returned HTTP ${checks.head.status}`);
    if (checks.head.content_type && !String(checks.head.content_type).startsWith('video/')) {
      issues.push(`HEAD Content-Type is ${checks.head.content_type}, expected video/*`);
    }
  } catch (err) {
    checks.head = { ok: false, error: err.message };
    issues.push(`HEAD failed: ${err.message}`);
  }

  try {
    checks.range = await checkRange(streamUrl, userAgent);
    if (!checks.range.ok) issues.push(`Range GET returned HTTP ${checks.range.status}`);
    if (!checks.range.has_ftyp) issues.push('First 64KB missing MP4 ftyp atom');
    if (!checks.range.has_moov) issues.push('First 64KB missing MP4 moov atom (Plex MDE needs faststart)');
  } catch (err) {
    checks.range = { ok: false, error: err.message };
    issues.push(`Range GET failed: ${err.message}`);
  }

  try {
    checks.ffprobe = await plexMediaProbe.probeStreamUrl(streamUrl);
    if (!checks.ffprobe?.container) issues.push('ffprobe could not determine container');
    if (!checks.ffprobe?.video_codec) issues.push('ffprobe could not determine video codec');
  } catch (err) {
    checks.ffprobe = { ok: false, error: err.message };
    issues.push(`ffprobe failed: ${err.message}`);
  }

  const sidecar = await plexMediaProbe.getProbeInfo(userId, file, req, { allowRemoteProbe: false });
  const plex_ready = issues.length === 0 && !!checks.ffprobe?.container;

  return {
    file_id: file.id,
    file_name: file.name,
    size: file.size,
    plex_ready,
    issues,
    checks,
    recommended_sidecar: plexMediaProbe.sidecarProbeFields(sidecar || checks.ffprobe),
  };
}

module.exports = {
  testStreamForPlex,
};
