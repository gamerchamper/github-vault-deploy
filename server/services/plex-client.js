const DEFAULT_PLEX_URL = 'http://127.0.0.1:32400';
const path = require('path');

const PLEX_CLIENT_HEADERS = {
  Accept: 'application/json',
  'X-Plex-Product': 'GitHub Vault',
  'X-Plex-Version': '1.0.0',
  'X-Plex-Client-Identifier': 'github-vault-integrate',
};

function normalizePlexUrl(url) {
  const trimmed = String(url || DEFAULT_PLEX_URL).trim();
  if (!trimmed) return DEFAULT_PLEX_URL;
  return trimmed.replace(/\/+$/, '');
}

function isLocalPlexHost(plexUrl) {
  try {
    const host = new URL(normalizePlexUrl(plexUrl)).hostname.toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

function buildUrl(plexUrl, apiPath, token, query = {}) {
  const base = normalizePlexUrl(plexUrl);
  const api = apiPath.startsWith('/') ? apiPath : `/${apiPath}`;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value == null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.set(key, String(value));
    }
  }
  if (token) params.set('X-Plex-Token', token);
  const qs = params.toString();
  return qs ? `${base}${api}?${qs}` : `${base}${api}`;
}

async function plexRequest(plexUrl, token, apiPath, { method = 'GET', timeoutMs = 15000 } = {}) {
  if (!token) throw new Error('Plex token is required');
  const url = buildUrl(plexUrl, apiPath, token);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...PLEX_CLIENT_HEADERS,
        'X-Plex-Token': token,
      },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Plex HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    if (!text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Plex returned non-JSON (is the server URL correct?)');
    }
  } finally {
    clearTimeout(timer);
  }
}

async function testConnection(plexUrl, token) {
  const data = await plexRequest(plexUrl, token, '/identity');
  const machine = data?.MediaContainer || data;
  return {
    ok: true,
    name: machine?.friendlyName || machine?.machineIdentifier || 'Plex Media Server',
    version: machine?.version || null,
  };
}

function parseSections(data) {
  const container = data?.MediaContainer || {};
  const dirs = container.Directory || container.Metadata || [];
  const list = Array.isArray(dirs) ? dirs : [dirs];
  return list.filter(Boolean).map((section) => ({
    key: String(section.key || section.ratingKey || ''),
    title: section.title || 'Untitled',
    type: section.type || null,
    agent: section.agent || null,
    scanner: section.scanner || null,
    locations: (section.Location || []).map((loc) => loc.path).filter(Boolean),
  }));
}

async function listLibraries(plexUrl, token) {
  const data = await plexRequest(plexUrl, token, '/library/sections');
  return parseSections(data);
}

async function refreshLibrary(plexUrl, token, sectionKey) {
  if (!sectionKey) throw new Error('Plex library section key is required');
  await plexRequest(plexUrl, token, `/library/sections/${encodeURIComponent(sectionKey)}/refresh`);
  return { refreshed: true, sectionKey: String(sectionKey) };
}

function normalizePathForCompare(p) {
  try {
    return path.resolve(String(p || '')).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  } catch {
    return String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  }
}

function pathNormalize(p) {
  return p;
}

async function findLibraryByTitle(plexUrl, token, title) {
  const target = String(title || '').trim().toLowerCase();
  if (!target) return null;
  const sections = await listLibraries(plexUrl, token);
  return sections.find((section) => String(section.title || '').trim().toLowerCase() === target) || null;
}

async function findLibraryForPath(plexUrl, token, folderPath) {
  const target = normalizePathForCompare(folderPath);
  const sections = await listLibraries(plexUrl, token);
  for (const section of sections) {
    for (const loc of section.locations) {
      if (normalizePathForCompare(loc) === target) return section;
      if (normalizePathForCompare(loc).endsWith(target) || target.endsWith(normalizePathForCompare(loc))) {
        return section;
      }
    }
  }
  return null;
}

async function plexFormPost(plexUrl, token, apiPath, fields, { timeoutMs = 20000 } = {}) {
  if (!token) throw new Error('Plex token is required');
  const url = buildUrl(plexUrl, apiPath, token, fields);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        ...PLEX_CLIENT_HEADERS,
        'X-Plex-Token': token,
      },
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Plex HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    if (!text.trim()) return {};
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  } finally {
    clearTimeout(timer);
  }
}

async function createLibrarySection(plexUrl, token, {
  title = 'GitHub Vault',
  type = 'show',
  agent = 'com.plexapp.agents.none',
  scanner = 'Plex Series Scanner',
  language = 'en',
  location,
} = {}) {
  if (!location) throw new Error('Library location path is required');

  const attempts = [
    { name: title, type, agent, scanner, language, location },
    { name: title, type: 'show', agent, scanner: 'Plex Series Scanner', language, location },
    { name: title, type: 'movie', agent, scanner: 'Plex Video Files Scanner', language, location },
  ];

  let lastError = null;
  for (const params of attempts) {
    try {
      const data = await plexFormPost(plexUrl, token, '/library/sections', params);
      const container = data?.MediaContainer || {};
      const dir = container.Directory || container;
      const created = Array.isArray(dir) ? dir[0] : dir;
      let sectionKey = created?.key ? String(created.key).replace(/^\/library\/sections\//, '') : null;
      if (!sectionKey && created?.ratingKey) sectionKey = String(created.ratingKey);
      if (!sectionKey) {
        const existing = await findLibraryForPath(plexUrl, token, location)
          || await findLibraryByTitle(plexUrl, token, title);
        if (existing?.key) return existing;
        throw new Error('Plex did not return a library section key');
      }
      return {
        key: sectionKey,
        title: created?.title || title,
        type: created?.type || type,
        locations: [location],
      };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Could not create Plex library');
}

async function ensureLibrarySection(plexUrl, token, folderPath, options = {}) {
  const title = options.title || 'GitHub Vault';
  const existingByPath = await findLibraryForPath(plexUrl, token, folderPath);
  if (existingByPath?.key) return { created: false, section: existingByPath };

  const existingByTitle = await findLibraryByTitle(plexUrl, token, title);
  if (existingByTitle?.key) return { created: false, section: existingByTitle };

  const section = await createLibrarySection(plexUrl, token, {
    location: folderPath,
    title,
    ...options,
  });
  return { created: true, section };
}

module.exports = {
  DEFAULT_PLEX_URL,
  normalizePlexUrl,
  isLocalPlexHost,
  testConnection,
  listLibraries,
  refreshLibrary,
  findLibraryForPath,
  findLibraryByTitle,
  createLibrarySection,
  ensureLibrarySection,
};
