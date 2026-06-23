const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { createMemoryDb, seedTestUser, seedTestFile, seedTestRepo } = require('../helpers/setup');

describe('uploaded HLS serve helpers', function () {
  it('rewriteUploadedPlaylist replaces raw GitHub segment URLs with proxy paths', function () {
    const hlsConvert = proxyquire('../../server/services/hls-convert', {
      '../db/database': createMemoryDb(),
    });

    const content = [
      '#EXTM3U',
      '#EXTINF:6.000,',
      'https://raw.githubusercontent.com/linked/private-hls-repo/main/.vault/hls/hls-serve-file/00000.dat',
      '#EXT-X-ENDLIST',
    ].join('\n');

    const rewritten = hlsConvert.rewriteUploadedPlaylist(
      content,
      (index) => `/api/public/share/token/hls/stored-segment/${String(index).padStart(5, '0')}.ts?file=f1`,
    );

    expect(rewritten).to.include('/api/public/share/token/hls/stored-segment/00000.ts?file=f1');
    expect(rewritten).to.not.include('raw.githubusercontent.com');
    expect(rewritten).to.include('#EXT-X-ENDLIST');
  });
});

describe('GET /api/public/share/:token/hls (uploaded proxy)', function () {
  let app;
  let request;
  let db;
  let file;
  const TOKEN = 'uploaded-hls-share';

  before(function () {
    db = createMemoryDb();
    const user = seedTestUser(db, { github_id: 'uploaded-hls-user', username: 'uploadedhls' });
    const repo = seedTestRepo(db, user.id, {
      full_name: 'linked/private-share-hls',
      default_branch: 'main',
      is_public: 0,
    });
    file = seedTestFile(db, user.id, {
      id: 'uploaded-hls-file',
      name: 'episode.mkv',
      mime_type: 'video/x-matroska',
      has_hls: 1,
      hls_playlist_repo_id: repo.id,
      hls_playlist_path: '.vault/hls/uploaded-hls-file/playlist.m3u8',
      share_token: TOKEN,
      chunk_count: 5,
      encryption_meta: JSON.stringify({ iv: 'mock', auth_tag: 'mock', encrypted_key: 'mock' }),
    });

    const mockCrypto = {
      getMasterKey: () => Buffer.from('x'.repeat(32)),
      deserializeEncryption: () => Buffer.from('x'.repeat(32)),
      wrapKeyForShare: () => ({ wrapped: 'mock' }),
    };

    const mockHlsConvert = {
      buildUploadedPlaylistForProxy: async (_userId, _file, segmentUrlForIndex) => [
        '#EXTM3U',
        '#EXTINF:6.000,',
        segmentUrlForIndex(0),
        '#EXT-X-ENDLIST',
      ].join('\n'),
      fetchUploadedSegment: async () => Buffer.from('segment-bytes'),
    };

    const storageService = proxyquire('../../server/services/storage', {
      '../db/database': db,
      '../services/crypto': mockCrypto,
    });

    const publicRoutes = proxyquire('../../server/routes/public', {
      '../db/database': db,
      '../services/storage': storageService,
      '../services/hls-convert': mockHlsConvert,
    });

    const express = require('express');
    app = express();
    app.use('/api/public', publicRoutes);
    request = require('supertest');
  });

  it('returns rewritten playlist with stored-segment proxy URLs', async function () {
    const res = await request(app)
      .get(`/api/public/share/${TOKEN}/hls`)
      .query({ file: file.id });

    expect(res.status).to.equal(200);
    expect(res.headers['content-type']).to.include('mpegurl');
    expect(res.text).to.include('#EXTM3U');
    expect(res.text).to.include(`/api/public/share/${TOKEN}/hls/stored-segment/00000.ts`);
    expect(res.text).to.not.include('raw.githubusercontent.com');
  });

  it('serves stored HLS segment bytes', async function () {
    const res = await request(app)
      .get(`/api/public/share/${TOKEN}/hls/stored-segment/00000.ts`)
      .query({ file: file.id });

    expect(res.status).to.equal(200);
    expect(res.headers['content-type']).to.include('video/mp2t');
    const body = Buffer.isBuffer(res.body) ? res.body.toString() : res.text;
    expect(body).to.equal('segment-bytes');
  });
});
