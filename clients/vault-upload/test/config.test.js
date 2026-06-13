const { expect } = require('chai');
const {
  addToServerHistory,
  findServerEntry,
  removeFromServerHistory,
  activeServerId,
  serverEntryId,
} = require('../src/config');

describe('config server history', function () {
  it('should add and dedupe server entries', function () {
    const config = {
      serverUrl: 'https://vault.test',
      apiKey: 'gv_test_key',
      serverHistory: [],
    };
    const history = addToServerHistory(config);
    expect(history).to.have.length(1);
    expect(history[0].serverUrl).to.equal('https://vault.test');
    expect(history[0].apiKey).to.equal('gv_test_key');

    const again = addToServerHistory({ ...config, serverHistory: history });
    expect(again).to.have.length(1);
    expect(again[0].lastUsed).to.be.at.least(history[0].lastUsed);
  });

  it('should not add entries without credentials', function () {
    const history = addToServerHistory({
      serverUrl: 'https://vault.test',
      serverHistory: [],
    });
    expect(history).to.have.length(0);
  });

  it('should find, remove, and compute active id', function () {
    const config = {
      serverUrl: 'http://localhost:3000',
      apiKey: 'gv_one',
      serverHistory: addToServerHistory({
        serverUrl: 'http://localhost:3000',
        apiKey: 'gv_one',
      }),
    };
    const id = serverEntryId(config.serverUrl, config.apiKey, '');
    expect(activeServerId(config)).to.equal(id);
    expect(findServerEntry(config, id).apiKey).to.equal('gv_one');
    const next = removeFromServerHistory(config, id);
    expect(next).to.have.length(0);
  });
});
