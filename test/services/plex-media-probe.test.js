const assert = require('assert');
const mp4 = require('../../server/services/mp4');
const plexMediaProbe = require('../../server/services/plex-media-probe');

describe('mp4 probe helpers', () => {
  it('normalizeContainer prefers mp4 from mov,mp4,... format names', () => {
    assert.strictEqual(mp4.normalizeContainer('mov,mp4,m4a,3gp,3g2,mj2'), 'mp4');
    assert.strictEqual(mp4.normalizeContainer('matroska,webm'), 'mkv');
  });

  it('videoResolutionLabel maps common heights', () => {
    assert.strictEqual(mp4.videoResolutionLabel(1080), '1080');
    assert.strictEqual(mp4.videoResolutionLabel(3840), '4k');
  });
});

describe('plex-media-probe', () => {
  it('sidecarProbeFields strips null values', () => {
    const fields = plexMediaProbe.sidecarProbeFields({
      container: 'mp4',
      video_codec: 'h264',
      width: 1920,
      height: 1080,
      duration_sec: 120,
      bitrate: 5000000,
    });
    assert.strictEqual(fields.container, 'mp4');
    assert.strictEqual(fields.video_codec, 'h264');
    assert.strictEqual(fields.width, 1920);
    assert.strictEqual(fields.video_resolution, '1080');
  });
});
