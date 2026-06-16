const assert = require('assert');
const sinon = require('sinon');
const plexClient = require('../../server/services/plex-client');

describe('plex-client library updates', () => {
  let fetchStub;

  afterEach(() => {
    if (fetchStub) fetchStub.restore();
  });

  it('updateLibrarySection uses PUT (Plex returns 404 on POST)', async () => {
    fetchStub = sinon.stub(global, 'fetch').resolves({
      ok: true,
      text: async () => JSON.stringify({ MediaContainer: {} }),
    });

    await plexClient.updateLibrarySection('http://127.0.0.1:32400', 'token', '2', {
      agent: 'com.githubvault.plex.agent',
      scanner: 'Plex Video Files Scanner',
      language: 'xn',
    });

    assert.strictEqual(fetchStub.calledOnce, true);
    const [url, options] = fetchStub.firstCall.args;
    assert.strictEqual(options.method, 'PUT');
    assert.match(String(url), /\/library\/sections\/2\?/);
  });

  it('analyzeLibrary uses PUT on section analyze endpoint', async () => {
    fetchStub = sinon.stub(global, 'fetch').resolves({
      ok: true,
      text: async () => '',
    });

    await plexClient.analyzeLibrary('http://127.0.0.1:32400', 'token', '2');

    assert.strictEqual(fetchStub.calledOnce, true);
    const [url, options] = fetchStub.firstCall.args;
    assert.strictEqual(options.method, 'PUT');
    assert.match(String(url), /\/library\/sections\/2\/analyze/);
  });

  it('refreshLibrary supports force=1 query', async () => {
    fetchStub = sinon.stub(global, 'fetch').resolves({
      ok: true,
      text: async () => JSON.stringify({ MediaContainer: {} }),
    });

    await plexClient.refreshLibrary('http://127.0.0.1:32400', 'token', '2', { force: true });

    assert.strictEqual(fetchStub.calledOnce, true);
    const [url] = fetchStub.firstCall.args;
    assert.match(String(url), /\/library\/sections\/2\/refresh\?force=1/);
  });

  it('metadataNeedsAnalysis detects empty Plex media records', () => {
    assert.strictEqual(plexClient.metadataNeedsAnalysis({ Media: [] }), true);
    assert.strictEqual(plexClient.metadataNeedsAnalysis({
      Media: [{ container: 'mp4', duration: 120000, Part: [{ Stream: [{ id: 1 }] }] }],
    }), false);
    assert.strictEqual(plexClient.metadataNeedsAnalysis({
      Media: [{ container: null, duration: 0, Part: [{ Stream: [] }] }],
    }), true);
  });
});
