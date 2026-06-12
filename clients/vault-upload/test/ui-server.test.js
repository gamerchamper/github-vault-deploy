const { expect } = require('chai');
const http = require('http');
const fs = require('fs');
const path = require('path');
const nock = require('nock');
const { createServer } = require('../src/ui-server');
const { CONFIG_DIR, SESSION_DIR } = require('../src/config');

function request(baseUrl, method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(`${baseUrl}${route}`, {
      method,
      headers: data ? {
        'Content-Type': 'application/json',
        'Content-Length': data.length,
      } : undefined,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = text;
        try { parsed = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, body: parsed, text });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

describe('UI server', function () {
  let server;
  let baseUrl;

  beforeEach(function (done) {
    nock.cleanAll();
    if (fs.existsSync(SESSION_DIR)) {
      for (const f of fs.readdirSync(SESSION_DIR)) fs.unlinkSync(path.join(SESSION_DIR, f));
    }
    if (fs.existsSync(CONFIG_DIR)) {
      for (const f of fs.readdirSync(CONFIG_DIR)) {
        if (f.endsWith('.json')) fs.unlinkSync(path.join(CONFIG_DIR, f));
      }
    }
    server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      done();
    });
  });

  afterEach(function (done) {
    nock.cleanAll();
    server.close(done);
  });

  it('should serve the modern dashboard', async function () {
    const res = await request(baseUrl, 'GET', '/');
    expect(res.status).to.equal(200);
    expect(res.text).to.include('Vault Upload');
    expect(res.text).to.include('Start Upload');
    expect(res.text).to.include('Browse');
    expect(res.text).to.include('operationState');
    expect(res.text).to.include('vaultDesktop.selectFile');
    expect(res.text).to.include('Content-Security-Policy');
    expect(res.text).to.not.include('unsafe-eval');
    expect(res.text).to.include('Remote Tasks');
  });

  it('should serve parseable dashboard JavaScript', async function () {
    const res = await request(baseUrl, 'GET', '/');
    const match = res.text.match(/<script>([\s\S]*)<\/script>/);
    expect(match).to.not.equal(null);
    expect(() => new Function(match[1])).to.not.throw();
  });

  it('should save config and check auth', async function () {
    nock('https://vault.test').get('/api/tasks/').query({ active: '1', resumable: '1' }).reply(200, { tasks: [] });

    const res = await request(baseUrl, 'POST', '/api/config', {
      serverUrl: 'https://vault.test/',
      cookie: 'vault.sid=test-session',
    });

    expect(res.status).to.equal(200);
    expect(res.body.serverUrl).to.equal('https://vault.test');
    expect(res.body.hasCookie).to.equal(true);
    expect(res.body.authenticated).to.equal(true);
  });

  it('should return full API key on config GET after save', async function () {
    nock('https://vault.test').get('/api/tasks/').query({ active: '1', resumable: '1' }).reply(200, { tasks: [] });

    await request(baseUrl, 'POST', '/api/config', {
      serverUrl: 'https://vault.test/',
      apiKey: 'gv_test_returned_key',
    });

    const res = await request(baseUrl, 'GET', '/api/config');
    expect(res.status).to.equal(200);
    expect(res.body.serverUrl).to.equal('https://vault.test');
    expect(res.body.apiKey).to.equal('gv_test_returned_key');
    expect(res.body.cookie).to.equal('');
  });

  it('should save API key config and check auth with bearer token', async function () {
    nock('https://vault.test', {
      reqheaders: { authorization: 'Bearer gv_ui_key' },
    }).get('/api/tasks/').query({ active: '1', resumable: '1' }).reply(200, { tasks: [] });

    const res = await request(baseUrl, 'POST', '/api/config', {
      serverUrl: 'https://vault.test/',
      apiKey: 'gv_ui_key',
    });

    expect(res.status).to.equal(200);
    expect(res.body.serverUrl).to.equal('https://vault.test');
    expect(res.body.hasApiKey).to.equal(true);
    expect(res.body.authenticated).to.equal(true);
  });

  it('should handle concurrent dashboard API requests under pressure', async function () {
    const requests = [];
    for (let i = 0; i < 100; i++) {
      requests.push(request(baseUrl, 'GET', i % 2 === 0 ? '/api/config' : '/api/sessions'));
    }

    const results = await Promise.all(requests);
    expect(results.every(r => r.status === 200)).to.equal(true);
    expect(results.filter(r => r.body.sessions).length).to.equal(50);
  });
});
