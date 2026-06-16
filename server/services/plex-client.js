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

const GITHUB_VAULT_AGENT_ID = 'com.githubvault.plex.agent';

function vaultLibraryAgentProfile(sectionType) {
  if (sectionType === 'show') {
    return {
      agent: GITHUB_VAULT_AGENT_ID,
      scanner: 'GitHub Vault Scanner',
      language: 'en-US',
    };
  }
  return {
    agent: GITHUB_VAULT_AGENT_ID,
    scanner: 'Plex Video Files Scanner',
    language: 'xn',
  };
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

async function plexRequest(plexUrl, token, apiPath, { method = 'GET', timeoutMs = 15000, query = {} } = {}) {
  if (!token) throw new Error('Plex token is required');
  const url = buildUrl(plexUrl, apiPath, token, query);
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

async function refreshLibrary(plexUrl, token, sectionKey, { force = false } = {}) {
  if (!sectionKey) throw new Error('Plex library section key is required');
  const query = force ? '?force=1' : '';
  await plexRequest(plexUrl, token, `/library/sections/${encodeURIComponent(sectionKey)}/refresh${query}`);
  return { refreshed: true, sectionKey: String(sectionKey), force: !!force };
}

async function analyzeLibrary(plexUrl, token, sectionKey) {
  if (!sectionKey) throw new Error('Plex library section key is required');
  await plexFormWrite(plexUrl, token, `/library/sections/${encodeURIComponent(sectionKey)}/analyze`, {}, { method: 'PUT' });
  return { analyzed: true, sectionKey: String(sectionKey) };
}

async function analyzeMetadataItem(plexUrl, token, ratingKey) {
  if (!ratingKey) throw new Error('Plex metadata rating key is required');
  await plexFormWrite(plexUrl, token, `/library/metadata/${encodeURIComponent(ratingKey)}/analyze`, {}, { method: 'PUT' });
  return { analyzed: true, ratingKey: String(ratingKey) };
}

async function refreshMetadataItem(plexUrl, token, ratingKey, { force = false } = {}) {
  if (!ratingKey) throw new Error('Plex metadata rating key is required');
  const query = force ? '?force=1' : '';
  await plexFormWrite(plexUrl, token, `/library/metadata/${encodeURIComponent(ratingKey)}/refresh${query}`, {}, { method: 'PUT' });
  return { refreshed: true, ratingKey: String(ratingKey), force: !!force };
}

function flattenMetadata(container) {
  const raw = container?.Metadata ?? container?.metadata ?? [];
  return Array.isArray(raw) ? raw : (raw ? [raw] : []);
}

function metadataMediaSummary(item) {
  const mediaList = item?.Media ?? item?.media ?? [];
  const media = Array.isArray(mediaList) ? mediaList[0] : mediaList;
  if (!media) {
    return { hasMedia: false, container: null, duration: 0, streamCount: 0 };
  }
  const parts = media.Part ?? media.part ?? [];
  const part = Array.isArray(parts) ? parts[0] : parts;
  const streams = part?.Stream ?? part?.stream ?? [];
  const streamArr = Array.isArray(streams) ? streams : (streams ? [streams] : []);
  return {
    hasMedia: true,
    container: media.container || null,
    duration: Number(media.duration || item.duration || 0),
    streamCount: streamArr.length,
    videoCodec: media.videoCodec || null,
  };
}

function metadataNeedsAnalysis(item) {
  const summary = metadataMediaSummary(item);
  if (!summary.hasMedia) return true;
  if (!summary.container) return true;
  if (!summary.duration || summary.duration <= 0) return true;
  if (summary.streamCount === 0) return true;
  return false;
}

async function listSectionMetadata(plexUrl, token, sectionKey) {
  if (!sectionKey) throw new Error('Plex library section key is required');
  const data = await plexRequest(plexUrl, token, `/library/sections/${encodeURIComponent(sectionKey)}/all`, {
    query: { includeMedia: 1 },
    timeoutMs: 60000,
  });
  const container = data?.MediaContainer || data;
  return flattenMetadata(container).map((item) => ({
    ratingKey: String(item.ratingKey || item.key || ''),
    title: item.title || null,
    type: item.type || null,
    ...metadataMediaSummary(item),
  })).filter((item) => item.ratingKey);
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

async function plexFormPost(plexUrl, token, apiPath, fields, { timeoutMs = 20000, headers = {} } = {}) {
  return plexFormWrite(plexUrl, token, apiPath, fields, { method: 'POST', timeoutMs, headers });
}

async function plexFormWrite(plexUrl, token, apiPath, fields, { method = 'POST', timeoutMs = 20000, headers = {} } = {}) {
  if (!token) throw new Error('Plex token is required');
  const url = buildUrl(plexUrl, apiPath, token, fields);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...PLEX_CLIENT_HEADERS,
        ...headers,
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

function libraryCreateProfiles(title) {
  return [
    {
      label: 'GitHub Vault (movie)',
      name: title,
      type: 'movie',
      agent: GITHUB_VAULT_AGENT_ID,
      scanner: 'Plex Video Files Scanner',
      language: 'xn',
    },
    {
      label: 'GitHub Vault (TV)',
      name: title,
      type: 'show',
      agent: GITHUB_VAULT_AGENT_ID,
      scanner: 'GitHub Vault Scanner',
      language: 'en-US',
    },
    {
      label: 'Other Videos (STRM)',
      name: title,
      type: 'movie',
      agent: 'com.plexapp.agents.none',
      scanner: 'Plex Video Files Scanner',
      language: 'xn',
    },
    {
      label: 'TV Shows (modern)',
      name: title,
      type: 'show',
      agent: 'tv.plex.agents.series',
      scanner: 'Plex TV Series',
      language: 'en-US',
    },
    {
      label: 'TV Shows (legacy)',
      name: title,
      type: 'show',
      agent: 'com.plexapp.agents.none',
      scanner: 'Plex Series Scanner',
      language: 'en-US',
    },
    {
      label: 'GitHub Vault Scanner',
      name: title,
      type: 'show',
      agent: 'com.plexapp.agents.none',
      scanner: 'GitHub Vault Scanner',
      language: 'en-US',
    },
    {
      label: 'Movies folder',
      name: title,
      type: 'movie',
      agent: 'com.plexapp.agents.none',
      scanner: 'Plex Movie Scanner',
      language: 'en-US',
    },
  ];
}

async function createLibrarySection(plexUrl, token, {
  title = 'GitHub Vault',
  location,
} = {}) {
  if (!location) throw new Error('Library location path is required');

  const attempts = libraryCreateProfiles(title);
  let lastError = null;

  for (const profile of attempts) {
    const { label, ...params } = profile;
    try {
      const headers = params.language && params.language !== 'xn'
        ? { 'X-Plex-Language': params.language }
        : {};
      const data = await plexFormPost(plexUrl, token, '/library/sections', {
        ...params,
        location,
      }, { headers });
      const container = data?.MediaContainer || {};
      const dir = container.Directory || container;
      const created = Array.isArray(dir) ? dir[0] : dir;
      let sectionKey = created?.key ? String(created.key).replace(/^\/library\/sections\//, '') : null;
      if (!sectionKey && created?.ratingKey) sectionKey = String(created.ratingKey);
      if (!sectionKey) {
        const existing = await findLibraryForPath(plexUrl, token, location)
          || await findLibraryByTitle(plexUrl, token, title);
        if (existing?.key) return { ...existing, profile: label };
        throw new Error('Plex did not return a library section key');
      }
      return {
        key: sectionKey,
        title: created?.title || title,
        type: created?.type || params.type,
        locations: [location],
        profile: label,
      };
    } catch (err) {
      lastError = new Error(`${label}: ${err.message}`);
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

async function updateLibrarySection(plexUrl, token, sectionKey, fields = {}) {
  if (!sectionKey) throw new Error('Plex library section key is required');
  const headers = fields.language && fields.language !== 'xn'
    ? { 'X-Plex-Language': fields.language }
    : {};
  const data = await plexFormWrite(
    plexUrl,
    token,
    `/library/sections/${encodeURIComponent(sectionKey)}`,
    fields,
    { method: 'PUT', headers },
  );
  return data;
}

async function resolveVaultLibrarySection(plexUrl, token, {
  libraryPath,
  sectionKey,
  title = 'GitHub Vault',
} = {}) {
  if (libraryPath) {
    const byPath = await findLibraryForPath(plexUrl, token, libraryPath);
    if (byPath?.key) return byPath;
  }
  const byTitle = await findLibraryByTitle(plexUrl, token, title);
  if (byTitle?.key) return byTitle;
  if (sectionKey) {
    const sections = await listLibraries(plexUrl, token);
    const match = sections.find((section) => String(section.key) === String(sectionKey));
    if (match?.key) return match;
  }
  return null;
}

async function applyGitHubVaultAgent(plexUrl, token, section, { refreshMetadata = true } = {}) {
  if (!section?.key) throw new Error('Library section key is required');
  const profile = vaultLibraryAgentProfile(section.type);
  // Do not send `type` on PUT — Plex rejects unknown/duplicate type updates.
  await updateLibrarySection(plexUrl, token, section.key, profile);
  const result = {
    section_key: section.key,
    agent: profile.agent,
    scanner: profile.scanner,
    type: section.type || (section.type === 'show' ? 'show' : 'movie'),
  };
  if (refreshMetadata) {
    try {
      result.refresh = await refreshLibrary(plexUrl, token, section.key, { force: true });
    } catch (err) {
      result.refresh_error = err.message;
    }
    try {
      result.analyze = await analyzeLibrary(plexUrl, token, section.key);
    } catch (err) {
      result.analyze_error = err.message;
    }
  }
  return result;
}

async function getAgentRegistrationStatus(plexUrl, token) {
  const libraries = await listLibraries(plexUrl, token);
  const vaultLibraries = libraries.filter((section) => (
    section.agent === GITHUB_VAULT_AGENT_ID
    || (section.locations || []).some((loc) => /github[\s_-]?vault/i.test(loc))
  ));
  return {
    agent_id: GITHUB_VAULT_AGENT_ID,
    libraries,
    vault_libraries: vaultLibraries,
    agent_applied: vaultLibraries.some((section) => section.agent === GITHUB_VAULT_AGENT_ID),
  };
}

module.exports = {
  DEFAULT_PLEX_URL,
  GITHUB_VAULT_AGENT_ID,
  normalizePlexUrl,
  isLocalPlexHost,
  testConnection,
  listLibraries,
  refreshLibrary,
  analyzeLibrary,
  analyzeMetadataItem,
  refreshMetadataItem,
  listSectionMetadata,
  metadataMediaSummary,
  metadataNeedsAnalysis,
  findLibraryForPath,
  findLibraryByTitle,
  createLibrarySection,
  ensureLibrarySection,
  updateLibrarySection,
  applyGitHubVaultAgent,
  getAgentRegistrationStatus,
  resolveVaultLibrarySection,
  vaultLibraryAgentProfile,
  plexFormWrite,
};
