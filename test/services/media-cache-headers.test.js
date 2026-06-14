const { expect } = require('chai');
const mediaCache = require('../../server/services/media-cache-headers');

describe('media-cache-headers', function () {
  it('builds cache control with revalidation window', function () {
    const value = mediaCache.mediaCacheControl({ scope: 'private', maxAgeSec: 14400, swrSec: 86400 });
    expect(value).to.include('max-age=14400');
    expect(value).to.include('stale-while-revalidate=86400');
    expect(value).to.include('must-revalidate');
  });

  it('returns 304 when etag matches', function () {
    const req = { headers: { 'if-none-match': '"abc123"' } };
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      status(code) { this.statusCode = code; return this; },
      end() { this.ended = true; },
    };

    const sent = mediaCache.sendNotModifiedIfMatch(req, res, 'abc123');
    expect(sent).to.equal(true);
    expect(res.statusCode).to.equal(304);
    expect(res.ended).to.equal(true);
  });
});
