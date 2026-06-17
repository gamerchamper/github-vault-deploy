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
      size_bytes: 987654321,
      thumbnail_url: 'https://vault.example/thumb/clip.jpg',
    }), 'utf8');

    const dbPath = path.join(tmp, 'library.db');
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE metadata_items (
        id INTEGER PRIMARY KEY,
        duration INTEGER,
        user_thumb_url TEXT,
        user_art_url TEXT,
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
        size INTEGER,
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
    const part = verify.prepare('SELECT file, size FROM media_parts WHERE id = 20').get();
    assert.strictEqual(part.file, 'http://127.0.0.1/stream');
    assert.strictEqual(part.size, 987654321);
    verify.close();

    const writeDb = new Database(dbPath);
    const thumb = sidecarDbRepair.injectThumbnailIntoMetadata(writeDb, 1, {
      thumbnail_url: 'https://vault.example/thumb/clip.jpg',
    });
    assert.strictEqual(thumb.patched, true);
    const meta = writeDb.prepare('SELECT user_thumb_url, user_art_url FROM metadata_items WHERE id = 1').get();
    assert.strictEqual(meta.user_thumb_url, 'https://vault.example/thumb/clip.jpg');
    assert.strictEqual(meta.user_art_url, 'https://vault.example/thumb/clip.jpg');
    writeDb.close();
  });

  it('maps audio sidecars to mp3-only Plex media fields', () => {
    const fields = sidecarDbRepair.sidecarToMediaFields({
      mime_type: 'audio/mpeg',
      container: 'mp3',
      duration_sec: 169.4,
      audio_codec: 'mp3',
      audio_channels: 2,
      bitrate: 329194,
    });
    assert.strictEqual(fields.audioOnly, true);
    assert.strictEqual(fields.container, 'mp3');
    assert.strictEqual(fields.video_codec, null);
    assert.strictEqual(fields.audio_codec, 'mp3');
  });

  it('injects audio-only streams without a video stream', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-audio-db-'));
    const libraryRoot = path.join(tmp, 'GitHub Vault');
    const playlistDir = path.join(libraryRoot, 'Playlists', 'Music');
    fs.mkdirSync(playlistDir, { recursive: true });

    const strmPath = path.join(playlistDir, '01 - track.mp3.strm');
    const sidecarPath = path.join(playlistDir, '01 - track.mp3.vault-item.json');
    fs.writeFileSync(strmPath, 'http://127.0.0.1/track.mp3\n', 'utf8');
    fs.writeFileSync(sidecarPath, JSON.stringify({
      mime_type: 'audio/mpeg',
      container: 'mp3',
      duration_sec: 180,
      audio_codec: 'mp3',
      audio_channels: 2,
    }), 'utf8');

    const dbPath = path.join(tmp, 'library.db');
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE metadata_items (id INTEGER PRIMARY KEY, duration INTEGER, user_thumb_url TEXT, user_art_url TEXT, updated_at INTEGER);
      CREATE TABLE media_items (
        id INTEGER PRIMARY KEY, library_section_id INTEGER, metadata_item_id INTEGER,
        container TEXT, duration INTEGER, video_codec TEXT, audio_codec TEXT, audio_channels INTEGER,
        width INTEGER, height INTEGER, bitrate INTEGER, display_aspect_ratio REAL,
        media_analysis_version INTEGER DEFAULT 0, deleted_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE media_parts (
        id INTEGER PRIMARY KEY, media_item_id INTEGER, file TEXT, size INTEGER, duration INTEGER,
        deleted_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE media_streams (
        id INTEGER PRIMARY KEY AUTOINCREMENT, stream_type_id INTEGER, media_item_id INTEGER,
        codec TEXT, "index" INTEGER, media_part_id INTEGER, channels INTEGER,
        created_at INTEGER, updated_at INTEGER, "default" INTEGER DEFAULT 0
      );
    `);
    db.prepare('INSERT INTO metadata_items (id) VALUES (2)').run();
    db.prepare('INSERT INTO media_items (id, library_section_id, metadata_item_id, container, duration) VALUES (11, 2, 2, \'\', NULL)').run();
    db.prepare('INSERT INTO media_parts (id, media_item_id, file) VALUES (21, 11, ?)').run(strmPath);
    db.close();

    const result = sidecarDbRepair.repairVaultLibraryFromSidecars(libraryRoot, { dbPath, sectionKey: 2 });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.repaired, 1);

    const verify = new Database(dbPath, { readonly: true });
    const streams = verify.prepare('SELECT stream_type_id, codec, "index" FROM media_streams ORDER BY "index"').all();
    assert.strictEqual(streams.length, 1);
    assert.deepStrictEqual(streams[0], { stream_type_id: 2, codec: 'mp3', index: 0 });
    verify.close();
  });

  it('discovers vault library paths from PLEX_VAULT_LIBRARY_PATH', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-discover-'));
    const libraryRoot = path.join(tmp, 'GitHub Vault', 'Playlists');
    fs.mkdirSync(libraryRoot, { recursive: true });
    fs.writeFileSync(path.join(libraryRoot, 'clip.mp4.strm'), 'https://vault.example/x\n', 'utf8');

    const prev = process.env.PLEX_VAULT_LIBRARY_PATH;
    process.env.PLEX_VAULT_LIBRARY_PATH = path.join(tmp, 'GitHub Vault');
    try {
      const paths = sidecarDbRepair.discoverVaultLibraryPaths();
      assert.ok(paths.some((entry) => path.resolve(entry) === path.resolve(process.env.PLEX_VAULT_LIBRARY_PATH)));
    } finally {
      if (prev == null) delete process.env.PLEX_VAULT_LIBRARY_PATH;
      else process.env.PLEX_VAULT_LIBRARY_PATH = prev;
    }
  });

  it('reads stream URL from STRM sidecar files', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-strm-'));
    const strmPath = path.join(tmp, 'clip.mp4.strm');
    fs.writeFileSync(strmPath, 'https://vault.example/stream/abc/file.mp4\n', 'utf8');
    assert.strictEqual(
      sidecarDbRepair.readStrmUrl(strmPath),
      'https://vault.example/stream/abc/file.mp4',
    );
    assert.strictEqual(sidecarDbRepair.partNeedsRemoteUrl(strmPath), true);
    assert.strictEqual(sidecarDbRepair.partNeedsRemoteUrl('https://vault.example/x.mp4'), false);
  });

  it('audits vault playback readiness from sidecar + DB state', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plex-audit-'));
    const libraryRoot = path.join(tmp, 'GitHub Vault');
    const playlistDir = path.join(libraryRoot, 'Playlists', 'Test');
    fs.mkdirSync(playlistDir, { recursive: true });

    const strmPath = path.join(playlistDir, 'clip.mp4.strm');
    fs.writeFileSync(strmPath, 'http://127.0.0.1/stream\n', 'utf8');
    fs.writeFileSync(path.join(playlistDir, 'clip.mp4.vault-item.json'), JSON.stringify({
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
      CREATE TABLE metadata_items (id INTEGER PRIMARY KEY, duration INTEGER, user_thumb_url TEXT, user_art_url TEXT, updated_at INTEGER);
      CREATE TABLE media_items (
        id INTEGER PRIMARY KEY, library_section_id INTEGER, metadata_item_id INTEGER,
        container TEXT, duration INTEGER, video_codec TEXT, audio_codec TEXT, audio_channels INTEGER,
        width INTEGER, height INTEGER, bitrate INTEGER, display_aspect_ratio REAL,
        media_analysis_version INTEGER DEFAULT 0, deleted_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE media_parts (
        id INTEGER PRIMARY KEY, media_item_id INTEGER, file TEXT, size INTEGER, duration INTEGER,
        deleted_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE media_streams (
        id INTEGER PRIMARY KEY AUTOINCREMENT, stream_type_id INTEGER, media_item_id INTEGER,
        codec TEXT, "index" INTEGER, media_part_id INTEGER, channels INTEGER,
        created_at INTEGER, updated_at INTEGER, "default" INTEGER DEFAULT 0
      );
    `);
    db.prepare('INSERT INTO metadata_items (id) VALUES (1)').run();
    db.prepare('INSERT INTO media_items (id, library_section_id, metadata_item_id, container, duration) VALUES (10, 2, 1, \'\', NULL)').run();
    db.prepare('INSERT INTO media_parts (id, media_item_id, file) VALUES (20, 10, ?)').run(strmPath);
    db.close();

    const before = sidecarDbRepair.auditVaultLibraryPlayback(libraryRoot, { dbPath, sectionKey: 2 });
    assert.strictEqual(before.ok, true);
    assert.strictEqual(before.total_strm, 1);
    assert.strictEqual(before.ready, 0);
    assert.strictEqual(before.needs_repair, 1);

    sidecarDbRepair.repairVaultLibraryFromSidecars(libraryRoot, { dbPath, sectionKey: 2 });

    const after = sidecarDbRepair.auditVaultLibraryPlayback(libraryRoot, { dbPath, sectionKey: 2 });
    assert.strictEqual(after.ready, 1);
    assert.strictEqual(after.needs_repair, 0);
  });
});
