const { expect } = require('chai');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('future-vault agent config', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-config-'));
    process.env.FUTURE_VAULT_DATA = tempDir;
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/agent')];
  });

  afterEach(() => {
    delete process.env.FUTURE_VAULT_DATA;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('applyConfigPatch updates in-memory config and persists to disk', async () => {
    const { startAgent, getAgentConfig, applyConfigPatch, stopAgent } = require('../src/agent');
    await startAgent({ port: 0, host: '127.0.0.1' });

    applyConfigPatch({ vault_url: 'https://vault.example.com', sync_interval_minutes: 30 });

    const live = getAgentConfig();
    expect(live.vault_url).to.equal('https://vault.example.com');
    expect(live.sync_interval_minutes).to.equal(30);

    delete require.cache[require.resolve('../src/config')];
    const { loadConfig } = require('../src/config');
    const disk = loadConfig();
    expect(disk.vault_url).to.equal('https://vault.example.com');
    expect(disk.sync_interval_minutes).to.equal(30);

    await stopAgent();
  });
});
