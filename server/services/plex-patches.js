const fs = require('fs');
const path = require('path');
const os = require('os');

const REPO_ROOT = path.resolve(__dirname, '../..');
const PATCHES_ROOT = path.join(REPO_ROOT, 'integrate', 'plex', 'patches');
const PORTABLE_PLEX_ROOT = path.join(REPO_ROOT, 'Plex Media Server');
const PORTABLE_PLUGINS_DIR = path.join(PORTABLE_PLEX_ROOT, 'Plug-ins');
const AGENT_BUNDLE_NAME = 'GitHubVaultAgent.bundle';
const AGENT_PATCH_SRC = path.join(PATCHES_ROOT, AGENT_BUNDLE_NAME);
const CHANNEL_BUNDLE_SRC = path.join(PORTABLE_PLUGINS_DIR, 'GitHubVault.bundle');

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

const MOVIE_HOOK_ANCHORS = [
  '      video_helper.process_metadata(metadata)',
  '    video_helper.process_metadata(metadata)',
];

const TV_HOOK_ANCHORS = [
  '        #del metadata.seasons[s]\n        pass',
  '      #del metadata.seasons[s]\n      pass',
];

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

  const repoResources = path.join(PORTABLE_PLEX_ROOT, 'Resources');
  if (fs.existsSync(repoResources)) return repoResources;

  return null;
}

function findAllBundledPluginsDirs(resourcesDir = defaultPlexResourcesDir()) {
  const dirs = [];
  if (!resourcesDir || !fs.existsSync(resourcesDir)) return dirs;
  for (const entry of fs.readdirSync(resourcesDir, { withFileTypes: true })) {
    if (entry.isDirectory() && /^Plug-ins-/i.test(entry.name)) {
      dirs.push(path.join(resourcesDir, entry.name));
    }
  }
  return dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
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
    for (const movieAnchor of MOVIE_HOOK_ANCHORS) {
      if (content.includes(movieAnchor)) {
        content = content.replace(movieAnchor, `${movieAnchor}${MOVIE_HOOK}`);
        changed = true;
        break;
      }
    }
    for (const tvAnchor of TV_HOOK_ANCHORS) {
      if (content.includes(tvAnchor)) {
        content = content.replace(tvAnchor, `${tvAnchor}${TV_HOOK}`);
        changed = true;
        break;
      }
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

function removeDirRecursive(dir) {
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/** Custom agents must live in user Plug-ins — bundled copies shadow AppData with stale code. */
function removeBundledAgentDuplicates(resourcesDirs = findAllBundledPluginsDirs()) {
  const removed = [];
  for (const bundledDir of resourcesDirs) {
    const bundledAgent = path.join(bundledDir, AGENT_BUNDLE_NAME);
    if (removeDirRecursive(bundledAgent)) removed.push(bundledAgent);
  }
  return removed;
}

function syncPortableRepoPlugins() {
  const synced = [];
  if (!fs.existsSync(AGENT_PATCH_SRC)) {
    return { ok: false, synced, error: `${AGENT_PATCH_SRC} not found` };
  }
  if (!fs.existsSync(PORTABLE_PLUGINS_DIR)) {
    fs.mkdirSync(PORTABLE_PLUGINS_DIR, { recursive: true });
  }
  const agentDest = path.join(PORTABLE_PLUGINS_DIR, AGENT_BUNDLE_NAME);
  copyDirRecursive(AGENT_PATCH_SRC, agentDest);
  synced.push(agentDest);
  const vaultHookSrc = path.join(PATCHES_ROOT, 'LocalMedia.bundle', 'Contents', 'Code', 'vault_hook.py');
  if (fs.existsSync(vaultHookSrc)) {
    copyFileEnsuringDir(vaultHookSrc, path.join(agentDest, 'Contents', 'Code', 'vault_hook.py'));
  }
  if (fs.existsSync(CHANNEL_BUNDLE_SRC)) {
    synced.push(CHANNEL_BUNDLE_SRC);
  }
  return { ok: true, synced };
}

function validateAgentBundle(bundleDir) {
  const required = [
    path.join(bundleDir, 'Contents', 'Info.plist'),
    path.join(bundleDir, 'Contents', 'Code', '__init__.py'),
    path.join(bundleDir, 'Contents', 'Code', 'vault_hook.py'),
    path.join(bundleDir, 'Contents', 'DefaultPrefs.json'),
  ];
  const missing = required.filter((file) => !fs.existsSync(file));
  let primaryProvider = null;
  const initPath = path.join(bundleDir, 'Contents', 'Code', '__init__.py');
  if (fs.existsSync(initPath)) {
    const init = fs.readFileSync(initPath, 'utf8');
    primaryProvider = /primary_provider\s*=\s*True/.test(init);
  }
  const python = validateAgentPython(bundleDir);
  const structure = compareAgentBundleStructure(bundleDir);
  return {
    ok: missing.length === 0 && primaryProvider === true && python.ok && structure.ok,
    missing,
    primary_provider: primaryProvider,
    python,
    structure,
    path: bundleDir,
  };
}

/** Plex RestrictedPython rejects module-level names starting with "_". */
function validateAgentPython(bundleDir) {
  const codeDir = path.join(bundleDir, 'Contents', 'Code');
  const issues = [];
  if (!fs.existsSync(codeDir)) {
    return { ok: false, issues: ['Missing Contents/Code directory'] };
  }
  for (const file of fs.readdirSync(codeDir).filter((name) => name.endsWith('.py'))) {
    const filePath = path.join(codeDir, file);
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    lines.forEach((line, index) => {
      const lineNo = index + 1;
      if (/^\s*def\s+_/.test(line)) {
        issues.push(`${file}:${lineNo} uses def _* (RestrictedPython SyntaxError)`);
      }
      if (/^\s*class\s+_/.test(line)) {
        issues.push(`${file}:${lineNo} uses class _* (RestrictedPython SyntaxError)`);
      }
    });
  }
  return { ok: issues.length === 0, issues };
}

function compareAgentBundleStructure(bundleDir) {
  const infoPath = path.join(bundleDir, 'Contents', 'Info.plist');
  const issues = [];
  if (!fs.existsSync(infoPath)) {
    return { ok: false, issues: ['Missing Contents/Info.plist'] };
  }
  const info = fs.readFileSync(infoPath, 'utf8');
  const requiredKeys = ['CFBundleIdentifier', 'PlexFrameworkVersion', 'PlexPluginClass'];
  for (const key of requiredKeys) {
    if (!info.includes(`<key>${key}</key>`)) {
      issues.push(`Info.plist missing ${key}`);
    }
  }
  if (!/PlexPluginClass[\s\S]*<string>Agent<\/string>/.test(info)) {
    issues.push('Info.plist PlexPluginClass must be Agent');
  }
  if (!/PlexFrameworkVersion[\s\S]*<string>2<\/string>/.test(info)) {
    issues.push('Info.plist PlexFrameworkVersion must be 2');
  }
  const initPath = path.join(bundleDir, 'Contents', 'Code', '__init__.py');
  if (fs.existsSync(initPath)) {
    const init = fs.readFileSync(initPath, 'utf8');
    if (!/class\s+\w+\(Agent\.Movies\)/.test(init)) {
      issues.push('__init__.py missing Agent.Movies class');
    }
    if (!/class\s+\w+\(Agent\.TV_Shows\)/.test(init)) {
      issues.push('__init__.py missing Agent.TV_Shows class');
    }
    if (!/primary_provider\s*=\s*True/.test(init)) {
      issues.push('__init__.py agents must set primary_provider = True');
    }
  }
  return { ok: issues.length === 0, issues };
}

function readAgentPluginLog(plexDataDir = defaultPlexDataDir()) {
  const logPath = path.join(plexDataDir, 'Logs', 'PMS Plugin Logs', 'com.githubvault.plex.agent.log');
  if (!fs.existsSync(logPath)) {
    return { ok: false, log_path: logPath, issues: ['Plugin log not found — restart Plex after install'] };
  }
  const content = fs.readFileSync(logPath, 'utf8');
  const tail = content.slice(-8000);
  const issues = [];
  if (/invalid variable name because it starts with "_"/.test(tail)) {
    issues.push('RestrictedPython rejected underscore function names — redeploy fixed agent');
  }
  if (/SyntaxError:/.test(tail) && !issues.length) {
    issues.push('Plugin SyntaxError in latest log — check com.githubvault.plex.agent.log');
  }
  if (!/\[GitHub Vault\] metadata agent loaded/.test(tail)) {
    issues.push('Agent never logged successful load — check for startup timeout');
  }
  if (!/Started plug-in/.test(tail)) {
    issues.push('Plugin did not reach Started plug-in state');
  }
  const registered = /Updating agent information:/.test(tail);
  return {
    ok: issues.length === 0,
    log_path: logPath,
    loaded: /\[GitHub Vault\] metadata agent loaded/.test(tail),
    started: /Started plug-in/.test(tail),
    registered,
    issues,
    tail_excerpt: tail.split('\n').slice(-8).join('\n'),
  };
}

function readSystemAgentRegistry(plexDataDir = defaultPlexDataDir()) {
  const logPath = path.join(plexDataDir, 'Logs', 'PMS Plugin Logs', 'com.plexapp.system.log');
  if (!fs.existsSync(logPath)) {
    return { ok: false, registered: false, issues: ['System plugin log not found'] };
  }
  const content = fs.readFileSync(logPath, 'utf8');
  const registered = content.includes("'com.githubvault.plex.agent':");
  return {
    ok: registered,
    registered,
    log_path: logPath,
    issues: registered ? [] : ['com.githubvault.plex.agent not in Plex agent registry yet — restart Plex'],
  };
}

function auditAgentRuntime(plexDataDir = defaultPlexDataDir()) {
  const plugin = readAgentPluginLog(plexDataDir);
  const registry = readSystemAgentRegistry(plexDataDir);
  const issues = [...plugin.issues, ...registry.issues];
  return {
    ok: plugin.ok && registry.ok,
    plugin,
    registry,
    issues,
  };
}

function auditPlexLayout() {
  const paths = resolvePaths();
  const bundledDirs = findAllBundledPluginsDirs(paths.resourcesDir);
  const bundledAgents = bundledDirs.map((dir) => path.join(dir, AGENT_BUNDLE_NAME)).filter((p) => fs.existsSync(p));
  const appDataAgent = path.join(paths.pluginsDir, AGENT_BUNDLE_NAME);
  const portableAgent = path.join(PORTABLE_PLUGINS_DIR, AGENT_BUNDLE_NAME);
  return {
    paths,
    bundled_agent_copies: bundledAgents,
    bundled_agent_should_be_empty: bundledAgents.length === 0,
    appdata_agent: validateAgentBundle(appDataAgent),
    portable_agent: fs.existsSync(portableAgent) ? validateAgentBundle(portableAgent) : null,
    patch_agent: validateAgentBundle(AGENT_PATCH_SRC),
    runtime: auditAgentRuntime(paths.plexDataDir),
    portable_exe: fs.existsSync(path.join(PORTABLE_PLEX_ROOT, 'Plex Media Server.exe')),
  };
}

function deployUserPlugins(plexDataDir) {
  const pluginsDir = path.join(plexDataDir, 'Plug-ins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  const deployed = [];

  const vaultHookSrc = path.join(PATCHES_ROOT, 'LocalMedia.bundle', 'Contents', 'Code', 'vault_hook.py');

  if (fs.existsSync(AGENT_PATCH_SRC)) {
    const dest = path.join(pluginsDir, AGENT_BUNDLE_NAME);
    copyDirRecursive(AGENT_PATCH_SRC, dest);
    if (fs.existsSync(vaultHookSrc)) {
      copyFileEnsuringDir(vaultHookSrc, path.join(dest, 'Contents', 'Code', 'vault_hook.py'));
    }
    deployed.push(dest);
  }

  if (fs.existsSync(CHANNEL_BUNDLE_SRC)) {
    const dest = path.join(pluginsDir, 'GitHubVault.bundle');
    copyDirRecursive(CHANNEL_BUNDLE_SRC, dest);
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
    portablePluginsDir: PORTABLE_PLUGINS_DIR,
    portablePlexRoot: PORTABLE_PLEX_ROOT,
    libraryPath: path.join(plexDataDir, 'GitHub Vault'),
  };
}

function canWritePlexDataDir(plexDataDir = defaultPlexDataDir()) {
  try {
    fs.mkdirSync(plexDataDir, { recursive: true });
    const test = path.join(plexDataDir, `.vault-agent-test-${process.pid}`);
    fs.writeFileSync(test, 'ok', 'utf8');
    fs.unlinkSync(test);
    return true;
  } catch {
    return false;
  }
}

function canInstallAgentLocally() {
  if (process.env.PLEX_INTEGRATE_LOCAL === '0') return false;
  if (process.env.PLEX_INTEGRATE_LOCAL === '1') return true;
  return canWritePlexDataDir();
}

function installAgentFiles(plexDataDir, { patchBundled = true, vaultUrl = null, apiKey = null } = {}) {
  const paths = resolvePaths();
  const effectiveDataDir = plexDataDir || paths.plexDataDir;
  const steps = [];

  fs.mkdirSync(path.join(effectiveDataDir, 'GitHub Vault'), { recursive: true });

  const repoSync = syncPortableRepoPlugins();
  steps.push({ step: 'repo_plugins', ok: repoSync.ok, detail: repoSync.synced, error: repoSync.error || null });

  const removedBundled = removeBundledAgentDuplicates(findAllBundledPluginsDirs(paths.resourcesDir));
  steps.push({ step: 'remove_bundled_agent', ok: true, detail: removedBundled });

  const deployed = deployUserPlugins(effectiveDataDir);
  steps.push({ step: 'plugins_appdata', ok: true, detail: deployed });

  if (vaultUrl && apiKey) {
    const prefFiles = writePluginPreferences(effectiveDataDir, { vaultUrl, apiKey });
    steps.push({ step: 'preferences', ok: true, detail: prefFiles });
  }

  let patchResult = { ok: false, steps: [], error: 'Bundled Plug-ins folder not found' };
  if (patchBundled) {
    patchResult = applyBundledPatches(paths.bundledPluginsDir);
    steps.push({
      step: 'bundled_patches',
      ok: patchResult.ok,
      detail: patchResult.steps || [],
      error: patchResult.error || null,
      bundledPluginsDir: paths.bundledPluginsDir,
    });
  }

  const appDataAgent = path.join(effectiveDataDir, 'Plug-ins', AGENT_BUNDLE_NAME);
  const portableAgent = path.join(PORTABLE_PLUGINS_DIR, AGENT_BUNDLE_NAME);
  const validation = {
    appdata: validateAgentBundle(appDataAgent),
    portable: fs.existsSync(portableAgent) ? validateAgentBundle(portableAgent) : null,
    bundled_leftovers: findAllBundledPluginsDirs(paths.resourcesDir)
      .map((dir) => path.join(dir, AGENT_BUNDLE_NAME))
      .filter((p) => fs.existsSync(p)),
  };

  return {
    ok: validation.appdata.ok && validation.bundled_leftovers.length === 0,
    steps,
    plugins_dir: path.join(effectiveDataDir, 'Plug-ins'),
    portable_plugins_dir: PORTABLE_PLUGINS_DIR,
    agent_installed: validation.appdata.ok,
    validation,
    patchResult,
    restart_plex: true,
  };
}

module.exports = {
  REPO_ROOT,
  PATCHES_ROOT,
  PORTABLE_PLEX_ROOT,
  PORTABLE_PLUGINS_DIR,
  AGENT_BUNDLE_NAME,
  defaultPlexDataDir,
  defaultPlexResourcesDir,
  findBundledPluginsDir,
  findAllBundledPluginsDirs,
  resolvePaths,
  applyBundledPatches,
  deployUserPlugins,
  writePluginPreferences,
  ensureVaultLibraryDir,
  writeIntegrationManifest,
  injectLocalMediaHooks,
  copyDirRecursive,
  removeBundledAgentDuplicates,
  syncPortableRepoPlugins,
  validateAgentBundle,
  validateAgentPython,
  compareAgentBundleStructure,
  readAgentPluginLog,
  readSystemAgentRegistry,
  auditAgentRuntime,
  auditPlexLayout,
  canWritePlexDataDir,
  canInstallAgentLocally,
  installAgentFiles,
};
