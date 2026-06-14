const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

function loadClientModule(relPath) {
  const fullPath = path.resolve(__dirname, '..', relPath);
  const code = fs.readFileSync(fullPath, 'utf8');
  const varMatch = code.match(/\b(const|let|var)\s+(\w+)\s*=\s*\{/);
  if (!varMatch) throw new Error('Could not find object literal assignment in ' + relPath);
  const varName = varMatch[2];
  const fn = new Function('require', `"use strict";\n${code};\nreturn ${varName};`);
  return fn(require);
}

function mockMedia(tagName = 'VIDEO') {
  const attrs = new Map();
  const classes = new Set();
  return {
    tagName,
    playsInline: false,
    disableRemotePlayback: true,
    disablePictureInPicture: true,
    classList: {
      add: (c) => classes.add(c),
      has: (c) => classes.has(c),
    },
    setAttribute(k, v) { attrs.set(k, String(v)); },
    getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
    closest() { return null; },
    _classes: classes,
    _attrs: attrs,
  };
}

describe('media-player client', function () {
  let MediaPlayer;

  before(function () {
    MediaPlayer = loadClientModule('../public/js/media-player.js');
  });

  describe('configureVideoElement', function () {
    it('should set inline playback and AirPlay attributes', function () {
      const video = mockMedia('VIDEO');
      MediaPlayer.configureVideoElement(video, { enhancerWrap: false });

      expect(video.playsInline).to.be.true;
      expect(video.disableRemotePlayback).to.be.false;
      expect(video.disablePictureInPicture).to.be.false;
      expect(video.getAttribute('playsinline')).to.equal('');
      expect(video.getAttribute('webkit-playsinline')).to.equal('');
      expect(video.getAttribute('x-webkit-airplay')).to.equal('allow');
      expect(video.getAttribute('preload')).to.equal('auto');
      expect(video.getAttribute('controls')).to.equal('');
      expect(video.getAttribute('controlslist')).to.equal('nodownload');
      expect(video._classes.has('vault-video-enhanced')).to.be.true;
    });
  });

  describe('configureAudioElement', function () {
    it('should enable AirPlay and remote playback for audio', function () {
      const audio = mockMedia('AUDIO');
      MediaPlayer.configureAudioElement(audio, { enhancerWrap: false });

      expect(audio.disableRemotePlayback).to.be.false;
      expect(audio.getAttribute('x-webkit-airplay')).to.equal('allow');
      expect(audio._classes.has('vault-audio-remote')).to.be.true;
    });
  });

  describe('plyrOptions', function () {
    it('should include airplay and playsinline for video', function () {
      const opts = MediaPlayer.plyrOptions(false);
      expect(opts.controls).to.include('airplay');
      expect(opts.playsinline).to.be.true;
      expect(opts.disableContextMenu).to.be.false;
    });

    it('should include airplay for audio', function () {
      const opts = MediaPlayer.plyrOptions(true);
      expect(opts.controls).to.include('airplay');
      expect(opts.controls).to.not.include('pip');
    });
  });

  describe('buildVideoPlayerHtml', function () {
    it('should include enhancement classes and attributes', function () {
      const html = MediaPlayer.buildVideoPlayerHtml();
      expect(html).to.include('vault-video-enhanced-wrap');
      expect(html).to.include('vault-video-enhanced');
      expect(html).to.include('x-webkit-airplay="allow"');
      expect(html).to.include('controls');
      expect(html).to.include('controlslist="nodownload"');
    });
  });

  describe('buildAudioPlayerHtml', function () {
    it('should include AirPlay attributes', function () {
      const html = MediaPlayer.buildAudioPlayerHtml();
      expect(html).to.include('vault-audio-remote');
      expect(html).to.include('x-webkit-airplay="allow"');
    });
  });

  describe('supportsRemotePlayback', function () {
    it('should detect Remote Playback API support', function () {
      expect(MediaPlayer.supportsRemotePlayback(null)).to.be.false;
      expect(MediaPlayer.supportsRemotePlayback({})).to.be.false;
      expect(MediaPlayer.supportsRemotePlayback({
        remote: { watchAvailability: () => Promise.resolve(1) },
      })).to.be.true;
    });
  });
});
