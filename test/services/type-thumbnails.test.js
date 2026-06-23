const { expect } = require('chai');
const typeThumbnails = require('../../server/services/type-thumbnails');
const thumbnails = require('../../server/services/thumbnails');

describe('type-thumbnails', () => {
  it('should detect jar files by extension and mime type', () => {
    expect(typeThumbnails.isJar('application/java-archive', 'app.jar')).to.equal(true);
    expect(typeThumbnails.isJar(null, 'plugin.jar')).to.equal(true);
    expect(typeThumbnails.isJar('application/zip', 'archive.zip')).to.equal(false);
  });

  it('should include jar files in on-demand thumbnail support', () => {
    expect(thumbnails.supportsOnDemandThumbnail(null, 'server.jar')).to.equal(true);
    expect(thumbnails.supportsOnDemandThumbnail('application/java-archive', 'server.jar')).to.equal(true);
  });

  it('should generate a jpeg thumbnail for jar files when sharp is available', async () => {
    const thumb = await thumbnails.generateFromLookup('application/java-archive', 'demo.jar');
    if (!require('sharp')) {
      expect(thumb).to.equal(null);
      return;
    }
    expect(thumb).to.be.instanceOf(Buffer);
    expect(thumb.length).to.be.greaterThan(100);
    expect(thumb[0]).to.equal(0xff);
    expect(thumb[1]).to.equal(0xd8);
  });
});
