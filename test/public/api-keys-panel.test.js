const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

describe('API keys panel markup', function () {
  const root = path.join(__dirname, '../..');

  it('should expose API keys in quick access with client setup commands', function () {
    const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
    expect(html).to.include('data-view="api-keys"');
    expect(html).to.include('id="api-keys-tab"');
    expect(html).to.include('id="btn-create-api-key"');
    expect(html).to.include('npm run client:desktop');
    expect(html).to.include('api-key-client-command');
  });

  it('should wire browser API helpers for API key management', function () {
    const js = fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8');
    expect(js).to.include("apiKeys: () => API.get('/auth/api-keys')");
    expect(js).to.include("createApiKey: (name) => API.post('/auth/api-keys', { name })");
    expect(js).to.include("revokeApiKey: (id) => API.delete(`/auth/api-keys/${id}`)");
  });
});
