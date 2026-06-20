const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

describe('Site access gate UI', function () {
  const root = path.join(__dirname, '../..');

  it('should ship dedicated site-access styles for share pages', function () {
    const css = fs.readFileSync(path.join(root, 'public/css/site-access.css'), 'utf8');
    expect(css).to.include('.site-access-modal');
    expect(css).to.include('.site-access-modal-content');
    expect(css).to.include('.site-access-modal-backdrop');
  });

  it('should build a modal shell for share gates', function () {
    const js = fs.readFileSync(path.join(root, 'public/js/site-access.js'), 'utf8');
    expect(js).to.include('shareModalMarkup');
    expect(js).to.include('site-access-modal');
    expect(js).to.include('site-access-modal-header');
    expect(js).to.include('Protected content');
  });

  it('should load site-access.css on share.html', function () {
    const html = fs.readFileSync(path.join(root, 'public/share.html'), 'utf8');
    expect(html).to.include('/css/site-access.css');
  });
});
