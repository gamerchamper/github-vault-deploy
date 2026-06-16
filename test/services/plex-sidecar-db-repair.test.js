const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sidecarDbRepair = require('../../server/services/plex-sidecar-db-repair');

describe('plex-sidecar-db-repair', () => {
  it('maps vault sidecar JSON to Plex media fields', () => {
    const fields = sidecarDbRepair.sidecarToMediaFields({
      container: 'mp4',
      duration_sec: 1457.126,
      video_codec: 'h264',
      audio_codec: 'aac',
      audio_channels: 2,
      width: 1920,
      height: 1080,
      bitrate: 5397937,
    });
    assert.strictEqual(fields.container, 'mp4');
    assert.strictEqual(fields.duration, 1457126);
    assert.strictEqual(fields.video_codec, 'h264');
    assert.strictEqual(fields.bitrate, 5398);
    assert.strictEqual(fields.display_aspect_ratio, 1.778);
  });

  it('injects media rows and streams into a Plex library DB', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-db-'));
    const libraryRoot = path.join(tmp, 'GitHub Vault');
    const playlistDir = path.join(libraryRoot, 'Playlists', 'Test');
    fs.mkdirSync(playlistDir, { recursive: true });

    const strmPath = path.join(playlistDir, 'clip.mp4.strm');
    const sidecarPath = path.join(playlistDir, 'clip.mp4.vault-item.json');
    fs.writeFileSync(strmPath, 'http://127.0.0.1/stream\n', 'utf8');
    fs.writeFileSync(sidecarPath, JSON.stringify({
      container: 'mp4',
      duration_sec: 120,
      video_codec: 'h264',
      audio_codec: 'aac',
      audio_channels: 2,
      width: 1280,
      height: 720,
    }), 'utf8');

    const dbPath = path.join(tmp, 'library.db');
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE metadata_items (
        id INTEGER PRIMARY KEY,
        duration INTEGER,
        updated_at INTEGER
      );
      CREATE TABLE media_items (
        id INTEGER PRIMARY KEY,
        library_section_id INTEGER,
        metadata_item_id INTEGER,
        container TEXT,
        duration INTEGER,
        video_codec TEXT,
        audio_codec TEXT,
        audio_channels INTEGER,
        width INTEGER,
        height INTEGER,
        bitrate INTEGER,
        display_aspect_ratio REAL,
        media_analysis_version INTEGER DEFAULT 0,
        deleted_at INTEGER,
        updated_at INTEGER
      );
      CREATE TABLE media_parts (
        id INTEGER PRIMARY KEY,
        media_item_id INTEGER,
        file TEXT,
        duration INTEGER,
        deleted_at INTEGER,
        updated_at INTEGER
      );
      CREATE TABLE media_streams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stream_type_id INTEGER,
        media_item_id INTEGER,
        codec TEXT,
        "index" INTEGER,
        media_part_id INTEGER,
        channels INTEGER,
        created_at INTEGER,
        updated_at INTEGER,
        "default" INTEGER DEFAULT 0
      );
    `);
    db.prepare('INSERT INTO metadata_items (id, duration) VALUES (1, NULL)').run();
    db.prepare(`
      INSERT INTO media_items (id, library_section_id, metadata_item_id, container, duration)
      VALUES (10, 2, 1, '', NULL)
    `).run();
    db.prepare(`
      INSERT INTO media_parts (id, media_item_id, file, duration)
      VALUES (20, 10, ?, NULL)
    `).run(strmPath);
    db.close();

    const result = sidecarDbRepair.repairVaultLibraryFromSidecars(libraryRoot, {
      dbPath,
      sectionKey: 2,
    });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.repaired, 1);

    const verify = new Database(dbPath, { readonly: true });
    const media = verify.prepare('SELECT container, duration, video_codec FROM media_items WHERE id = 10').get();
    assert.strictEqual(media.container, 'mp4');
    assert.strictEqual(media.duration, 120000);
    assert.strictEqual(media.video_codec, 'h264');
    const streams = verify.prepare('SELECT stream_type_id, codec FROM media_streams ORDER BY "index"').all();
    assert.strictEqual(streams.length, 2);
    assert.deepStrictEqual(streams.map((s) => s.stream_type_id), [1, 2]);
    verify.close();
  });
});
