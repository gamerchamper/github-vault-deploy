const { expect } = require('chai');
const { buildHlsConvertArgs } = require('../../server/services/hls-convert');

describe('HLS FFmpeg args', function () {
  it('maps only first video and audio, skipping subtitles and data', function () {
    const args = buildHlsConvertArgs('/tmp/source.mkv', '/tmp/out', 6);
    expect(args).to.include('-map');
    expect(args).to.include('0:v:0');
    expect(args).to.include('0:a:0?');
    expect(args).to.include('-sn');
    expect(args).to.include('-dn');
    expect(args).to.not.include('-c:v');
  });
});
