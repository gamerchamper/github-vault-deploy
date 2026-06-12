const https = require('https');
const http = require('http');

const USER_AGENT = 'GitHubVault/1.0 (cover-art; contact: local)';

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchJson(res.headers.location).then(resolve).catch(reject);
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => req.destroy(new Error('Cover art lookup timed out')));
  });
}

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': USER_AGENT } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchBuffer(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Cover image download timed out')));
  });
}

function cleanVideoTitle(fileName) {
  let title = fileName.replace(/\.[^.]+$/, '');
  title = title.replace(/^\[[^\]]+\]\s*/g, '');
  title = title.replace(/\[[^\]]+\]/g, ' ');
  title = title.replace(/\s*-\s*\d{1,4}(?:v\d+)?\s*$/i, '');
  title = title.replace(/\s*S\d{1,2}E\d{1,3}.*$/i, '');
  title = title.replace(/\s*EP?\.?\s*\d+.*$/i, '');
  title = title.replace(/\s*\(\d{4}\)\s*$/g, '');
  title = title.replace(/\b(reaction{1,2}|react|reacts|review|watch|watches|live|stream|vlog|edit|amv|fancam)\b/gi, '');
  title = title.replace(/\b(1080p|720p|480p|2160p|4k|webrip|bluray|bdrip|dvdrip|x264|x265|hevc|aac|hdtv)\b/gi, '');
  title = title.replace(/[_]+/g, ' ');
  title = title.replace(/\s{2,}/g, ' ').trim();
  return title;
}

function videoSearchTerms(fileName) {
  const cleaned = cleanVideoTitle(fileName);
  const terms = [cleaned];
  const showMatch = cleaned.match(/^(.+?)\s+\d{1,3}$/);
  if (showMatch) terms.push(showMatch[1].trim());
  const beforeDash = cleaned.split(/\s+-\s+/)[0]?.trim();
  if (beforeDash && beforeDash !== cleaned) terms.push(beforeDash);
  return [...new Set(terms.filter(Boolean))];
}

function parseAudioName(fileName) {
  const base = fileName.replace(/\.[^.]+$/, '');
  const dash = base.indexOf(' - ');
  if (dash > 0) {
    return {
      artist: base.slice(0, dash).trim(),
      title: base.slice(dash + 3).trim(),
    };
  }
  return { artist: null, title: base.trim() };
}

function itunesArtworkUrl(url, size = 600) {
  if (!url) return null;
  return url.replace(/\/\d{2,4}x\d{2,4}bb\./, `/${size}x${size}bb.`);
}

async function searchItunes(term, media) {
  if (!term?.trim()) return null;
  const params = new URLSearchParams({
    term: term.trim(),
    media,
    limit: '3',
  });
  const data = await fetchJson(`https://itunes.apple.com/search?${params}`);
  const hit = data.results?.[0];
  if (!hit?.artworkUrl100) return null;
  return itunesArtworkUrl(hit.artworkUrl100, 600);
}

async function searchAniList(title) {
  if (!title?.trim()) return null;
  const query = `
    query ($search: String) {
      Page(page: 1, perPage: 3) {
        media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
          coverImage { extraLarge large }
          title { romaji english native }
        }
      }
    }
  `;
  const body = JSON.stringify({ query, variables: { search: title.trim() } });
  const data = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'graphql.anilist.co',
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': USER_AGENT,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(12000, () => req.destroy(new Error('AniList timed out')));
    req.write(body);
    req.end();
  });

  const media = data?.data?.Page?.media?.[0];
  return media?.coverImage?.extraLarge || media?.coverImage?.large || null;
}

async function searchMusicBrainz(artist, title) {
  if (!title?.trim()) return null;
  const query = artist
    ? `recording:"${title}" AND artist:"${artist}"`
    : `recording:"${title}"`;
  const params = new URLSearchParams({
    query,
    fmt: 'json',
    limit: '3',
  });
  const data = await fetchJson(`https://musicbrainz.org/ws/2/recording?${params}`);
  const recording = data.recordings?.[0];
  const releaseId = recording?.releases?.[0]?.id;
  if (!releaseId) return null;

  try {
    const art = await fetchJson(`https://coverartarchive.org/release/${releaseId}`);
    const front = art.images?.find((img) => img.front) || art.images?.[0];
    if (!front?.image) return null;
    return front.image;
  } catch {
    return null;
  }
}

async function lookupMusicCover(fileName) {
  const lookupCache = require('./lookup-cache');
  const cacheKey = `music:${fileName}`;
  const cached = lookupCache.get(cacheKey);
  if (cached) return cached;
  const { artist, title } = parseAudioName(fileName);
  const term = artist ? `${artist} ${title}` : title;

  const sources = [
    () => searchItunes(term, 'music'),
    () => searchMusicBrainz(artist, title),
  ];

  for (const source of sources) {
    try {
      const url = await source();
      if (url) {
        const buffer = await fetchBuffer(url);
        if (buffer?.length) lookupCache.put(cacheKey, buffer);
        return buffer;
      }
    } catch {
      // try next source
    }
  }
  return null;
}

async function lookupVideoCover(fileName) {
  const lookupCache = require('./lookup-cache');
  const cacheKey = `video:${fileName}`;
  const cached = lookupCache.get(cacheKey);
  if (cached) return cached;

  const terms = videoSearchTerms(fileName);
  if (!terms.length) return null;

  for (const title of terms) {
    const sources = [
      () => searchAniList(title),
      () => searchItunes(title, 'tvShow'),
      () => searchItunes(title, 'movie'),
    ];

    for (const source of sources) {
      try {
        const url = await source();
        if (url) {
          const buffer = await fetchBuffer(url);
          if (buffer?.length) lookupCache.put(cacheKey, buffer);
          return buffer;
        }
      } catch {
        // try next source
      }
    }
  }
  return null;
}

module.exports = {
  cleanVideoTitle,
  videoSearchTerms,
  parseAudioName,
  lookupMusicCover,
  lookupVideoCover,
  fetchBuffer,
};
