const { expect } = require('chai');
const videoFormats = require('../../server/services/video-formats');

describe('video-formats', function () {
  it('detects common video extensions', function () {
    expect(videoFormats.isVideo('video/mp4', 'clip.mp4')).to.equal(true);
    expect(videoFormats.isVideo(null, 'movie.mkv')).to.equal(true);
    expect(videoFormats.isVideo(null, 'clip.mov')).to.equal(true);
    expect(videoFormats.isVideo('video/x-matroska', 'file.bin')).to.equal(true);
  });

  it('rejects non-video files', function () {
    expect(videoFormats.isVideo('image/jpeg', 'photo.jpg')).to.equal(false);
    expect(videoFormats.isVideo(null, 'archive.zip')).to.equal(false);
  });

  it('shouldConvertHls requires both flag and video type', function () {
    expect(videoFormats.shouldConvertHls(true, 'video/mp4', 'a.mp4')).to.equal(true);
    expect(videoFormats.shouldConvertHls(true, null, 'a.mkv')).to.equal(true);
    expect(videoFormats.shouldConvertHls(false, 'video/mp4', 'a.mp4')).to.equal(false);
    expect(videoFormats.shouldConvertHls(true, 'image/png', 'a.png')).to.equal(false);
  });
});
