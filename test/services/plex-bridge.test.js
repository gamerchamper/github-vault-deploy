const assert = require('assert');
const plexBridge = require('../../server/services/plex-bridge');

describe('plex-bridge', () => {
  const req = { get: () => null, secure: false };

  it('mapItem builds stream and thumbnail urls', () => {
    const item = plexBridge.mapItem({
      id: 'file-1',
      name: 'episode.mkv',
      display_name: 'Pilot.mkv',
      mime_type: 'video/mp4',
      has_thumbnail: 1,
      has_hls: 1,
      chunk_count: 4,
      size: 1000,
    }, req);

    assert.strictEqual(item.title, 'Pilot.mkv');
    assert.match(item.stream_url, /\/api\/files\/stream\/file-1\/Pilot\.mkv$/);
    assert.match(item.thumbnail_url, /\/api\/files\/thumbnail\/file-1$/);
    assert.match(item.hls_url, /\/api\/files\/hls\/file-1\/playlist\.m3u8$/);
    assert.strictEqual(item.strm_url, item.stream_url);
  });

  it('mapItem adds mp4 extension to stream url when missing', () => {
    const item = plexBridge.mapItem({
      id: 'file-2',
      name: 'clip',
      mime_type: 'video/mp4',
      chunk_count: 1,
      has_hls: 0,
    }, req);

    assert.match(item.stream_url, /\/api\/files\/stream\/file-2\/clip\.mp4$/);
    assert.strictEqual(item.hls_url, null);
    assert.strictEqual(item.strm_url, item.stream_url);
  });

  it('mapContinueEntry uses file_id', () => {
    const item = plexBridge.mapContinueEntry({
      file_id: 'abc',
      file_name: 'Show S01E01.mp4',
      mime_type: 'video/mp4',
      has_thumbnail: 1,
      playlist_id: 'pl-1',
      playlist_title: 'My Show',
    }, req);

    assert.strictEqual(item.id, 'abc');
    assert.strictEqual(item.playlist_title, 'My Show');
    assert.match(item.stream_url, /\/api\/files\/stream\/abc\/.+\.mp4$/);
  });
});
