const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { createMemoryDb, seedTestUser, seedTestFile } = require('../helpers/setup');

describe('playlists routes', function () {
  let app;
  let request;
  let db;
  let user;
  let file1;
  let file2;

  before(function () {
    db = createMemoryDb();
    user = seedTestUser(db, { github_id: 'pl-user' });
    file1 = seedTestFile(db, user.id, { id: 'pl-file-1', name: 'a.mp4' });
    file2 = seedTestFile(db, user.id, { id: 'pl-file-2', name: 'b.mp3', mime_type: 'audio/mpeg' });

    const playlistsService = proxyquire('../../server/services/playlists', {
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
});
