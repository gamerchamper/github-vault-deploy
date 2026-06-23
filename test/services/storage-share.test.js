const { expect } = require('chai');
const proxyquire = require('proxyquire');
const { createMemoryDb, seedTestUser, seedTestFile } = require('../helpers/setup');

describe('storage folder sharing', function () {
  let db;
  let storage;
  let user;

  beforeEach(function () {
    db = createMemoryDb();
    user = seedTestUser(db, { github_id: 'share-folder-user', username: 'sharefolder' });
    storage = proxyquire('../../server/services/storage', {
      '../db/database': db,
    });
  });

  it('creates a share token for folders without encryption metadata', async function () {
    const folder = seedTestFile(db, user.id, {
      id: 'folder-share-1',
      name: 'Shared Docs',
      path: '/Shared Docs',
      size: 0,
      mime_type: null,
      is_folder: 1,
      parent_path: '/',
    });

    const result = await storage.createShareToken(user.id, folder.id, {
      protocol: 'https',
      get: () => 'vault.example.com',
    });

    expect(result.token).to.be.a('string').with.length.greaterThan(10);
    expect(result.is_folder).to.equal(true);
    expect(result.url).to.include(`/share/${result.token}`);

    const row = db.prepare('SELECT share_token, share_key_meta FROM files WHERE id = ?').get(folder.id);
    expect(row.share_token).to.equal(result.token);
    expect(row.share_key_meta).to.be.null;
  });

  it('lists shared folder contents by token', function () {
    const folder = seedTestFile(db, user.id, {
      id: 'folder-share-2',
      name: 'Media',
      path: '/Media',
      size: 0,
      is_folder: 1,
      parent_path: '/',
      share_token: 'folder-token-abc',
    });
    seedTestFile(db, user.id, {
      id: 'folder-share-file-1',
      name: 'clip.mp4',
      path: '/Media/clip.mp4',
      parent_path: '/Media',
      size: 1024,
    });

    const listing = storage.listSharedFolder('folder-token-abc');
    expect(listing).to.not.equal(null);
    expect(listing.name).to.equal('Media');
    expect(listing.files).to.have.length(1);
    expect(listing.files[0].name).to.equal('clip.mp4');
  });
});
