const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { createMemoryDb, seedTestUser, seedTestFile, seedTestRepo } = require('../helpers/setup');

describe('playlists routes', function () {
  let app;
  let request;
  let db;
  let user;
  let file1;
  let file2;
  let playlistsService;

  before(function () {
    db = createMemoryDb();
    user = seedTestUser(db, { github_id: 'pl-user' });
    file1 = seedTestFile(db, user.id, { id: 'pl-file-1', name: 'a.mp4' });
    file2 = seedTestFile(db, user.id, { id: 'pl-file-2', name: 'b.mp3', mime_type: 'audio/mpeg' });

    playlistsService = proxyquire('../../server/services/playlists', {
      '../db/database': db,
    });

    const playlistRoutes = proxyquire('../../server/routes/playlists', {
      '../services/playlists': playlistsService,
    });

    const express = require('express');
    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.user = { id: user.id, username: user.username };
      next();
    });
    app.use('/api/playlists', playlistRoutes);
    request = require('supertest');
  });

  it('creates a playlist', async function () {
    const res = await request(app)
      .post('/api/playlists')
      .send({ title: 'My Show', description: 'Season 1' });
    expect(res.status).to.equal(201);
    expect(res.body.title).to.equal('My Show');
    expect(res.body.item_count).to.equal(0);
  });

  it('reorders after pruning orphaned playlist items', async function () {
    const orphanFile = seedTestFile(db, user.id, { id: 'pl-file-orphan', name: 'gone.mp4' });
    const created = await request(app).post('/api/playlists').send({ title: 'Orphans' });
    const id = created.body.id;
    await request(app).post(`/api/playlists/${id}/items`).send({ file_ids: [file1.id, orphanFile.id] });

    db.prepare('UPDATE files SET is_deleted = 1 WHERE id = ?').run(orphanFile.id);

    const reordered = await request(app)
      .patch(`/api/playlists/${id}/reorder`)
      .send({ file_ids: [file1.id] });
    expect(reordered.status).to.equal(200);
    expect(reordered.body.items).to.have.length(1);
    expect(reordered.body.items[0].id).to.equal(file1.id);
  });

  it('adds items and preserves order', async function () {
    const created = await request(app).post('/api/playlists').send({ title: 'Queue' });
    const id = created.body.id;
    const add = await request(app)
      .post(`/api/playlists/${id}/items`)
      .send({ file_ids: [file1.id, file2.id] });
    expect(add.status).to.equal(200);
    expect(add.body.added).to.equal(2);
    expect(add.body.items).to.have.length(2);
    expect(add.body.items[0].id).to.equal(file1.id);

    const reordered = await request(app)
      .patch(`/api/playlists/${id}/reorder`)
      .send({ file_ids: [file2.id, file1.id] });
    expect(reordered.body.items[0].id).to.equal(file2.id);
  });

  it('shares playlist publicly', async function () {
    const created = await request(app).post('/api/playlists').send({ title: 'Public list' });
    const share = await request(app).post(`/api/playlists/${created.body.id}/share`);
    expect(share.status).to.equal(200);
    expect(share.body.token).to.be.a('string');
    expect(share.body.url).to.include('/share/p/');
  });

  it('creates collection with playlist', async function () {
    const pl = await request(app).post('/api/playlists').send({ title: 'Episodes' });
    const col = await request(app).post('/api/playlists/collections').send({ title: 'Series' });
    expect(col.status).to.equal(201);
    const linked = await request(app)
      .post(`/api/playlists/collections/${col.body.id}/playlists`)
      .send({ playlist_id: pl.body.id });
    expect(linked.status).to.equal(200);
    expect(linked.body.playlists).to.have.length(1);
  });

  it('updates item display names without changing file names', async function () {
    const created = await request(app).post('/api/playlists').send({ title: 'Aliases' });
    const id = created.body.id;
    await request(app).post(`/api/playlists/${id}/items`).send({ file_ids: [file1.id] });

    const patch = await request(app)
      .patch(`/api/playlists/${id}/items/${file1.id}`)
      .send({ display_name: 'Episode 1 — Pilot' });
    expect(patch.status).to.equal(200);
    expect(patch.body.display_name).to.equal('Episode 1 — Pilot');

    const get = await request(app).get(`/api/playlists/${id}`);
    expect(get.body.items[0].display_name).to.equal('Episode 1 — Pilot');
    expect(get.body.items[0].name).to.equal('a.mp4');
  });

  it('bulk updates display names', async function () {
    const created = await request(app).post('/api/playlists').send({ title: 'Bulk aliases' });
    const id = created.body.id;
    await request(app).post(`/api/playlists/${id}/items`).send({ file_ids: [file1.id, file2.id] });

    const patch = await request(app)
      .patch(`/api/playlists/${id}/items`)
      .send({
        items: [
          { file_id: file1.id, display_name: 'Track A' },
          { file_id: file2.id, display_name: '' },
        ],
      });
    expect(patch.status).to.equal(200);
    expect(patch.body.items[0].display_name).to.equal('Track A');
    expect(patch.body.items[1].display_name).to.equal(null);
  });

  it('deletes a playlist', async function () {
    const created = await request(app).post('/api/playlists').send({ title: 'To delete' });
    const id = created.body.id;
    const del = await request(app).delete(`/api/playlists/${id}`);
    expect(del.status).to.equal(200);
    expect(del.body.ok).to.be.true;

    const get = await request(app).get(`/api/playlists/${id}`);
    expect(get.status).to.equal(404);
  });

  it('tracks watch progress', async function () {
    const created = await request(app).post('/api/playlists').send({ title: 'Progress' });
    const id = created.body.id;
    await request(app).post(`/api/playlists/${id}/items`).send({ file_ids: [file1.id] });
    const prog = await request(app)
      .post(`/api/playlists/${id}/progress`)
      .send({ file_id: file1.id, position_seconds: 42, progress_pct: 50, completed: 0 });
    expect(prog.status).to.equal(200);
    const get = await request(app).get(`/api/playlists/${id}/progress`);
    expect(get.body.progress[0].progress_pct).to.equal(50);
  });

  it('links a folder and syncs files into the playlist', async function () {
    const folder = seedTestFile(db, user.id, {
      id: 'pl-folder-1',
      name: 'Season 1',
      path: '/Season 1',
      size: 0,
      mime_type: null,
      is_folder: 1,
      parent_path: '/',
    });
    const ep1 = seedTestFile(db, user.id, {
      id: 'pl-ep-1',
      name: 'ep01.mp4',
      path: '/Season 1/ep01.mp4',
      parent_path: '/Season 1',
    });
    const ep2 = seedTestFile(db, user.id, {
      id: 'pl-ep-2',
      name: 'ep02.mp4',
      path: '/Season 1/ep02.mp4',
      parent_path: '/Season 1',
    });

    const created = await request(app).post('/api/playlists').send({ title: 'Show' });
    const id = created.body.id;

    const linked = await request(app)
      .post(`/api/playlists/${id}/folders`)
      .send({ folder_id: folder.id });
    expect(linked.status).to.equal(200);
    expect(linked.body.folder_links).to.have.length(1);
    expect(linked.body.items).to.have.length(2);
    expect(linked.body.items.map((i) => i.id)).to.deep.equal([ep1.id, ep2.id]);
    expect(linked.body.items.every((i) => i.sync_managed)).to.be.true;
  });

  it('auto-syncs when a new file is added to a linked folder', async function () {
    const folder = seedTestFile(db, user.id, {
      id: 'pl-folder-2',
      name: 'Album',
      path: '/Album',
      size: 0,
      mime_type: null,
      is_folder: 1,
      parent_path: '/',
    });
    seedTestFile(db, user.id, {
      id: 'pl-track-1',
      name: '01.mp3',
      path: '/Album/01.mp3',
      parent_path: '/Album',
      mime_type: 'audio/mpeg',
    });

    const created = await request(app).post('/api/playlists').send({ title: 'Album playlist' });
    const id = created.body.id;
    await request(app).post(`/api/playlists/${id}/folders`).send({ folder_id: folder.id });

    const track2 = seedTestFile(db, user.id, {
      id: 'pl-track-2',
      name: '02.mp3',
      path: '/Album/02.mp3',
      parent_path: '/Album',
      mime_type: 'audio/mpeg',
    });

    playlistsService.syncPlaylistsForFile(user.id, track2.id);

    const get = await request(app).get(`/api/playlists/${id}`);
    expect(get.body.items).to.have.length(2);
    expect(get.body.items.map((i) => i.id)).to.include(track2.id);
  });

  it('preserves custom episode order when a new file syncs into a linked folder', async function () {
    const folder = seedTestFile(db, user.id, {
      id: 'pl-folder-order',
      name: 'Ordered',
      path: '/Ordered',
      size: 0,
      mime_type: null,
      is_folder: 1,
      parent_path: '/',
    });
    const epA = seedTestFile(db, user.id, {
      id: 'pl-order-a',
      name: 'alpha.mp4',
      path: '/Ordered/alpha.mp4',
      parent_path: '/Ordered',
    });
    const epB = seedTestFile(db, user.id, {
      id: 'pl-order-b',
      name: 'beta.mp4',
      path: '/Ordered/beta.mp4',
      parent_path: '/Ordered',
    });

    const created = await request(app).post('/api/playlists').send({ title: 'Ordered show' });
    const id = created.body.id;
    await request(app).post(`/api/playlists/${id}/folders`).send({ folder_id: folder.id });

    await request(app)
      .patch(`/api/playlists/${id}/reorder`)
      .send({ file_ids: [epB.id, epA.id] });

    const epC = seedTestFile(db, user.id, {
      id: 'pl-order-c',
      name: 'gamma.mp4',
      path: '/Ordered/gamma.mp4',
      parent_path: '/Ordered',
    });

    playlistsService.syncPlaylistsForFile(user.id, epC.id);

    const get = await request(app).get(`/api/playlists/${id}`);
    expect(get.body.items.map((i) => i.id)).to.deep.equal([epB.id, epA.id, epC.id]);
  });

  it('removes synced items when a file is trashed in a linked folder', async function () {
    const folder = seedTestFile(db, user.id, {
      id: 'pl-folder-3',
      name: 'Clips',
      path: '/Clips',
      size: 0,
      mime_type: null,
      is_folder: 1,
      parent_path: '/',
    });
    const clip = seedTestFile(db, user.id, {
      id: 'pl-clip-1',
      name: 'clip.mp4',
      path: '/Clips/clip.mp4',
      parent_path: '/Clips',
    });

    const created = await request(app).post('/api/playlists').send({ title: 'Clips playlist' });
    const id = created.body.id;
    await request(app).post(`/api/playlists/${id}/folders`).send({ folder_id: folder.id });

    db.prepare('UPDATE files SET is_deleted = 1 WHERE id = ?').run(clip.id);

    const synced = await request(app).post(`/api/playlists/${id}/sync`);
    expect(synced.status).to.equal(200);
    expect(synced.body.removed).to.be.at.least(1);
    expect(synced.body.playlist.items).to.have.length(0);
  });

  it('unlinks a folder and removes synced items', async function () {
    const folder = seedTestFile(db, user.id, {
      id: 'pl-folder-4',
      name: 'Docs',
      path: '/Docs',
      size: 0,
      mime_type: null,
      is_folder: 1,
      parent_path: '/',
    });
    seedTestFile(db, user.id, {
      id: 'pl-doc-1',
      name: 'readme.pdf',
      path: '/Docs/readme.pdf',
      parent_path: '/Docs',
      mime_type: 'application/pdf',
    });

    const created = await request(app).post('/api/playlists').send({ title: 'Docs playlist' });
    const id = created.body.id;
    await request(app).post(`/api/playlists/${id}/folders`).send({ folder_id: folder.id });

    const unlinked = await request(app).delete(`/api/playlists/${id}/folders/${folder.id}`);
    expect(unlinked.status).to.equal(200);
    expect(unlinked.body.folder_links).to.have.length(0);
    expect(unlinked.body.items).to.have.length(0);
  });

  it('smart reorders playlist items by season/episode in titles', async function () {
    const ep3 = seedTestFile(db, user.id, { id: 'pl-smart-ep-3', name: 'Show S01E03.mp4' });
    const ep1 = seedTestFile(db, user.id, { id: 'pl-smart-ep-1', name: 'Show S01E01.mp4' });
    const ep2 = seedTestFile(db, user.id, { id: 'pl-smart-ep-2', name: 'Show S01E02.mp4' });

    const created = await request(app).post('/api/playlists').send({ title: 'Smart sort test' });
    const id = created.body.id;
    await request(app)
      .post(`/api/playlists/${id}/items`)
      .send({ file_ids: [ep3.id, ep1.id, ep2.id] });

    const res = await request(app).post(`/api/playlists/${id}/reorder-smart`);
    expect(res.status).to.equal(200);
    expect(res.body.items.map((i) => i.id)).to.deep.equal([ep1.id, ep2.id, ep3.id]);
  });

  it('includes hls duration on playlist items', async function () {
    const repo = seedTestRepo(db, user.id);
    const hlsFile = seedTestFile(db, user.id, {
      id: 'pl-hls-1',
      name: 'stream.mp4',
      has_hls: 1,
    });
    db.prepare(`
      INSERT INTO hls_segments (file_id, segment_index, duration, repo_id, repo_path, sha, size)
      VALUES (?, 0, 6.5, ?, 'path/0.ts', 'sha0', 100),
             (?, 1, 4.0, ?, 'path/1.ts', 'sha1', 100)
    `).run(hlsFile.id, repo.id, hlsFile.id, repo.id);

    const created = await request(app).post('/api/playlists').send({ title: 'HLS playlist' });
    const id = created.body.id;
    await request(app).post(`/api/playlists/${id}/items`).send({ file_ids: [hlsFile.id] });

    const pl = await request(app).get(`/api/playlists/${id}`);
    expect(pl.body.items[0].hls_duration_sec).to.be.closeTo(10.5, 0.01);
    expect(pl.body.items[0].hls_segment_count).to.equal(2);
  });
});
