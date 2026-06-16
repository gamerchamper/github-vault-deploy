const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '../..');
const PATCHES_ROOT = path.join(REPO_ROOT, 'integrate', 'plex', 'patches');
const BUNDLE_SOURCES = [
  path.join(REPO_ROOT, 'Plex Media Server', 'Plug-ins', 'GitHubVault.bundle'),
  path.join(PATCHES_ROOT, 'GitHubVaultAgent.bundle'),
];

const MOVIE_HOOK = `
    # [GitHub Vault hook]
    try:
      import vault_hook
      vault_hook.enrich_movie(metadata, media)
    except Exception, e:
      Log('[GitHub Vault] movie hook: %s' % e)`;

const TV_HOOK = `
    # [GitHub Vault hook]
    try:
      import vault_hook
      vault_hook.enrich_tv(metadata, media)
    except Exception, e:
      Log('[GitHub Vault] TV hook: %s' % e)`;

function defaultPlexDataDir() {
  if (process.env.PLEX_DATA_DIR) return path.resolve(process.env.PLEX_DATA_DIR);
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Plex Media Server');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Plex Media Server');
  }
  return '/var/lib/plexmediaserver/Library/Application Support/Plex Media Server';
}

function defaultPlexResourcesDir() {
  if (process.env.PLEX_RESOURCES_DIR) return path.resolve(process.env.PLEX_RESOURCES_DIR);
  const repoResources = path.join(REPO_ROOT, 'Plex Media Server', 'Resources');
  if (fs.existsSync(repoResources)) return repoResources;

  if (process.platform === 'win32') {
    const roots = [
      process.env['ProgramFiles(x86)'],
      process.env.ProgramFiles,
      'C:\\Program Files (x86)',
      'C:\\Program Files',
    ].filter(Boolean);
    for (const root of roots) {
      const candidate = path.join(root, 'Plex', 'Plex Media Server', 'Resources');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  if (process.platform === 'linux') {
    const candidates = [
      '/usr/lib/plexmediaserver/Resources',
      '/usr/share/plexmediaserver/Resources',
      '/usr/lib/plexmediaserver/lib/Resources',
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  if (process.platform === 'darwin') {
    const candidate = '/Applications/Plex Media Server.app/Contents/Resources';
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findBundledPluginsDir(resourcesDir) {
  if (!resourcesDir || !fs.existsSync(resourcesDir)) return null;
  const entries = fs.readdirSync(resourcesDir, { withFileTypes: true });
  const matches = entries
    .filter((entry) => entry.isDirectory() && /^Plug-ins-/i.test(entry.name))
    .map((entry) => path.join(resourcesDir, entry.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return matches[0] || null;
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}

function copyFileEnsuringDir(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function writeXmlPref(filePath, prefs) {
  const lines = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<Preferences>',
  ];
  for (const [id, value] of Object.entries(prefs)) {
    lines.push(`  <Pref id="${id}" value="${String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;')}" />`);
  }
  lines.push('</Preferences>', '');
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
}

function injectLocalMediaHooks(initPath) {
  if (!fs.existsSync(initPath)) {
    return { ok: false, reason: 'LocalMedia __init__.py not found' };
  }
  let content = fs.readFileSync(initPath, 'utf8');
  let changed = false;

  if (!content.includes('[GitHub Vault hook]')) {
    const movieAnchor = '      video_helper.process_metadata(metadata)';
    if (content.includes(movieAnchor)) {
      content = content.replace(movieAnchor, `${movieAnchor}${MOVIE_HOOK}`);
      changed = true;
    }
    const tvAnchor = '        #del metadata.seasons[s]\n        pass';
    if (content.includes(tvAnchor)) {
      content = content.replace(tvAnchor, `${tvAnchor}${TV_HOOK}`);
      changed = true;
    }
  }

  if (changed) fs.writeFileSync(initPath, content, 'utf8');
  return { ok: true, changed };
}

function applyBundledPatches(bundledPluginsDir) {
  const steps = [];
  if (!bundledPluginsDir) {
    return { ok: false, steps, error: 'Bundled Plug-ins folder not found (set PLEX_RESOURCES_DIR)' };
  }

  const localMediaCode = path.join(bundledPluginsDir, 'LocalMedia.bundle', 'Contents', 'Code');
  const vaultHookSrc = path.join(PATCHES_ROOT, 'LocalMedia.bundle', 'Contents', 'Code', 'vault_hook.py');
  const vaultHookDest = path.join(localMediaCode, 'vault_hook.py');
  if (fs.existsSync(vaultHookSrc)) {
    copyFileEnsuringDir(vaultHookSrc, vaultHookDest);
    steps.push({ action: 'install', target: vaultHookDest });
  }

  const initPath = path.join(localMediaCode, '__init__.py');
  const hookResult = injectLocalMediaHooks(initPath);
  if (hookResult.changed) steps.push({ action: 'patch', target: initPath, detail: 'LocalMedia hooks injected' });

  const scannerSrc = path.join(
    PATCHES_ROOT,
    'Scanners.bundle',
    'Contents',
    'Resources',
    'Series',
    'GitHub Vault Scanner.py',
  );
  const scannerDest = path.join(
    bundledPluginsDir,
    'Scanners.bundle',
    'Contents',
    'Resources',
    'Series',
    'GitHub Vault Scanner.py',
  );
  if (fs.existsSync(scannerSrc)) {
    copyFileEnsuringDir(scannerSrc, scannerDest);
    steps.push({ action: 'install', target: scannerDest });
  }

  return { ok: true, steps, bundledPluginsDir };
}

function deployUserPlugins(plexDataDir) {
  const pluginsDir = path.join(plexDataDir, 'Plug-ins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  const deployed = [];

  for (const src of BUNDLE_SOURCES) {
    if (!fs.existsSync(src)) continue;
    const name = path.basename(src);
    const dest = path.join(pluginsDir, name);
    copyDirRecursive(src, dest);
    deployed.push(dest);
  }

  const channelSrc = path.join(REPO_ROOT, 'Plex Media Server', 'Plug-ins', 'GitHubVault.bundle');
  if (fs.existsSync(channelSrc) && !deployed.some((p) => p.endsWith('GitHubVault.bundle'))) {
    const dest = path.join(pluginsDir, 'GitHubVault.bundle');
    copyDirRecursive(channelSrc, dest);
    deployed.push(dest);
  }

  return deployed;
}

function writePluginPreferences(plexDataDir, { vaultUrl, apiKey }) {
  const prefDir = path.join(plexDataDir, 'Plug-in Support', 'Preferences');
  const prefs = { vault_url: vaultUrl, api_key: apiKey };
  const files = [
    path.join(prefDir, 'com.githubvault.plex.channel.xml'),
    path.join(prefDir, 'com.githubvault.plex.agent.xml'),
  ];
  for (const file of files) writeXmlPref(file, prefs);
  return files;
}

function ensureVaultLibraryDir(plexDataDir) {
  const libraryPath = path.join(plexDataDir, 'GitHub Vault');
  fs.mkdirSync(libraryPath, { recursive: true });
  return libraryPath;
}

function writeIntegrationManifest(plexDataDir, payload) {
  const manifestPath = path.join(plexDataDir, 'GitHub Vault', '.vault-plex-integration.json');
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return manifestPath;
}

function resolvePaths() {
  const plexDataDir = defaultPlexDataDir();
  const resourcesDir = defaultPlexResourcesDir();
  const bundledPluginsDir = findBundledPluginsDir(resourcesDir);
  return {
    plexDataDir,
    resourcesDir,
    bundledPluginsDir,
    pluginsDir: path.join(plexDataDir, 'Plug-ins'),
    libraryPath: path.join(plexDataDir, 'GitHub Vault'),
  };
}

module.exports = {
  REPO_ROOT,
  PATCHES_ROOT,
  defaultPlexDataDir,
  defaultPlexResourcesDir,
  findBundledPluginsDir,
  resolvePaths,
  applyBundledPatches,
  deployUserPlugins,
  writePluginPreferences,
  ensureVaultLibraryDir,
  writeIntegrationManifest,
  injectLocalMediaHooks,
  copyDirRecursive,
};
