const path = require('path');

let server = null;
let config = null;

function getAgentConfig() {
  return config;
}

async function startAgent(opts = {}) {
  if (server) {
    return { url: config.agent_url, config, server };
  }

  require('dotenv').config({ path: path.join(__dirname, '../../.env') });

  const { loadConfig, saveConfig, DEFAULT_PORT } = require('./config');
  const { createApp } = require('./server');
  const scheduler = require('./services/scheduler');
  const store = require('./services/store');

  config = loadConfig();
  const host = opts.host || '127.0.0.1';
  const port = Number(opts.port || process.env.FUTURE_VAULT_PORT || config.agent_port || DEFAULT_PORT);

  const app = createApp(getAgentConfig);
  await new Promise((resolve, reject) => {
    server = app.listen(port, host, () => resolve());
    server.on('error', reject);
  });

  config.agent_port = port;
  config.agent_url = `http://${host}:${port}`;
  saveConfig(config);
  store.appendEvent(config, 'info', `Future Vault agent listening on ${config.agent_url}`);
  scheduler.startScheduler(config);

  return { url: config.agent_url, config, server };
}

async function stopAgent() {
  const scheduler = require('./services/scheduler');
  scheduler.stopScheduler();
  if (!server) return;
  await new Promise((resolve) => {
    server.close(() => {
      server = null;
      config = null;
      resolve();
    });
  });
}

function applyConfigPatch(patch) {
  const { updateConfig } = require('./config');
  const scheduler = require('./services/scheduler');
  const next = updateConfig(patch);
  if (config) Object.assign(config, next);
  else config = next;
  if (server) scheduler.restartScheduler(config);
  return config;
}

module.exports = {
  getAgentConfig,
  startAgent,
  stopAgent,
  applyConfigPatch,
};
