const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const REPO_ROOT = resolveRepoRoot();
const DEFAULT_PORT = Number(process.env.FUTURE_VAULT_PORT) || 7420;
const DEFAULT_AGENT_URL = `http://127.0.0.1:${DEFAULT_PORT}`;

function isRepoRoot(candidate) {
  if (!candidate) return false;
  return fs.existsSync(path.join(candidate, 'server', 'services', 'plex-sidecar-db-repair.js'));
}

function resolveRepoRoot() {
  if (process.env.GITHUB_VAULT_ROOT) {
    const envRoot = path.resolve(process.env.GITHUB_VAULT_ROOT);
    if (isRepoRoot(envRoot)) return envRoot;
  }
  if (process.resourcesPath) {
    const bundled = path.join(process.resourcesPath, 'github-vault');
    if (isRepoRoot(bundled)) return bundled;
  }
  const devRoot = path.resolve(__dirname, '../..');
  if (isRepoRoot(devRoot)) return devRoot;
  return devRoot;
}

function defaultDataDir() {
  if (process.env.FUTURE_VAULT_DATA) return path.resolve(process.env.FUTURE_VAULT_DATA);
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Future Vault');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Future Vault');
  }
  return path.join(os.homedir(), '.future-vault');
}

function defaultLibraryPath() {
  const portable = path.join(REPO_ROOT, 'Plex Media Server', 'GitHub Vault');
  if (fs.existsSync(portable)) return portable;
  const appData = process.env.LOCALAPPDATA || process.env.HOME;
  if (appData) {
    const candidate = path.join(appData, 'Plex Media Server', 'GitHub Vault');
    if (fs.existsSync(candidate)) return candidate;
  }
  return portable;
}

function generateApiKey() {
  return `fv_${crypto.randomBytes(24).toString('hex')}`;
}

function loadConfig() {
  const dataDir = defaultDataDir();
  const configPath = path.join(dataDir, 'config.json');
  fs.mkdirSync(dataDir, { recursive: true });

  let config = null;
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      config = null;
    }
  }

  if (!config) {
    config = {
      version: 1,
      created_at: new Date().toISOString(),
      agent_port: DEFAULT_PORT,
      agent_url: DEFAULT_AGENT_URL,
      api_key: generateApiKey(),
      vault_url: process.env.VAULT_URL || '',
      vault_api_key: process.env.VAULT_API_KEY || '',
      plex_library_path: defaultLibraryPath(),
      plex_server_url: process.env.PLEX_SERVER_URL || 'http://127.0.0.1:32400',
      plex_token: process.env.PLEX_TOKEN || '',
      plex_section_key: null,
      sync_interval_minutes: 15,
      auto_sync: true,
      auto_repair: true,
      auto_plugin: true,
      repair_after_plex_restart_sec: 45,
    };
  }

  config.data_dir = dataDir;
  config.config_path = configPath;
  config.cache_dir = path.join(dataDir, 'cache');
  config.log_path = path.join(dataDir, 'agent.log');
  config.repo_root = REPO_ROOT;

  if (!config.agent_url) config.agent_url = DEFAULT_AGENT_URL;
  if (!config.api_key) config.api_key = generateApiKey();
  if (!config.plex_library_path) config.plex_library_path = defaultLibraryPath();

  fs.mkdirSync(config.cache_dir, { recursive: true });

  if (!fs.existsSync(configPath)) {
    saveConfig(config);
  }

  return config;
}

function saveConfig(config) {
  const copy = { ...config };
  delete copy.data_dir;
  delete copy.config_path;
  delete copy.cache_dir;
  delete copy.log_path;
  delete copy.repo_root;
  fs.writeFileSync(config.config_path, `${JSON.stringify(copy, null, 2)}\n`, 'utf8');
  return copy;
}

function updateConfig(patch) {
  const config = loadConfig();
  Object.assign(config, patch);
  saveConfig(config);
  return config;
}

module.exports = {
  REPO_ROOT,
  DEFAULT_PORT,
  DEFAULT_AGENT_URL,
  isRepoRoot,
  resolveRepoRoot,
  defaultDataDir,
  defaultLibraryPath,
  loadConfig,
  saveConfig,
  updateConfig,
  generateApiKey,
};
