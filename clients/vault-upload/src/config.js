const path = require('path');
const fs = require('fs');
const os = require('os');

const CONFIG_DIR = path.join(os.homedir(), '.vault-upload');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const SESSION_DIR = path.join(CONFIG_DIR, 'sessions');

function ensureDirs() {
  for (const d of [CONFIG_DIR, SESSION_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function load() {
  ensureDirs();
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch {}
  return {};
}

function save(config) {
  ensureDirs();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

module.exports = { CONFIG_DIR, SESSION_DIR, load, save, ensureDirs };
