const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

describe('Site access panel markup', function () {
  const root = path.join(__dirname, '../..');

  it('should expose site access in quick access sidebar', function () {
    const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
    expect(html).to.include('data-view="site-access"');
    expect(html).to.include('id="site-access-tab"');
    expect(html).to.include('id="btn-save-site-access-key"');
    expect(html).to.include('id="btn-disable-site-access-key"');
  });

  it('should wire browser API helpers for site access settings', function () {
    const js = fs.readFileSync(path.join(root, 'public/js/api.js'), 'utf8');
    expect(js).to.include("siteAccess: () => API.get('/api/settings/site-access')");
    expect(js).to.include("setSiteAccess: (body) => API.put('/api/settings/site-access', body)");
  });
});
