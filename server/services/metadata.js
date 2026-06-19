const db = require('../db/database');
const github = require('./github');
const crypto = require('./crypto');

const METADATA_REPO_NAME = 'vault-metadata';
const MANIFEST_VERSION = 1;
const indexLocks = new Map();

async function withIndexLock(userId, fn) {
  const prev = indexLocks.get(userId) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  indexLocks.set(userId, prev.then(() => gate));
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (indexLocks.get(userId) === gate) indexLocks.delete(userId);
  }
}

function getMetadataRepo(userId) {
  return db.prepare(
    'SELECT * FROM storage_repos WHERE user_id = ? AND is_metadata = 1 LIMIT 1'
  ).get(userId);
}

function manifestPath(fileId) {
  return `.vault/metadata/files/${fileId}.json`;
}

function thumbnailPath(fileId) {
  return `.vault/metadata/thumbnails/${fileId}.jpg`;
}

function indexPath() {
  return '.vault/metadata/index.json';
}

async function readJson(octokit, repo, path) {
  const [owner, name] = repo.full_name.split('/');
  const branch = repo.default_branch || 'main';
  // Try raw.githubusercontent.com first — zero API calls
  try {
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${name}/${branch}/${path}`;
    const resp = await fetch(rawUrl, { timeout: 10000 });
    if (resp.ok) {
      const text = await resp.text();
      return JSON.parse(text);
    }
    if (resp.status === 404) return null;
  } catch { /* fall through to API on network errors only */ }

  try {
    const rateLimit = require('./github-rate-limit');
    return await rateLimit.runWithSubsystem('metadata', async () => {
    const { data } = await octokit.repos.getContent({ owner, repo: name, path, ref: branch });
    if (Array.isArray(data)) return null;
    const content = JSON.parse(Buffer.from(data.content, data.encoding).toString('utf8'));
    content._sha = data.sha;
    return content;
    });
  } catch (err) {
    if (err.status === 404) return null;
    return null;
  }
}

async function readJsonAtRef(octokit, repo, path, ref) {
  const [owner, name] = repo.full_name.split('/');
  try {
    const rateLimit = require('./github-rate-limit');
    const { data } = await rateLimit.runWithSubsystem('metadata', () =>
      octokit.repos.getContent({ owner, repo: name, path, ref }),
    );
    if (Array.isArray(data)) return null;
    const content = JSON.parse(Buffer.from(data.content, data.encoding).toString('utf8'));
    content._sha = data.sha;
    return content;
  } catch (err) {
    if (err.status === 404) return null;
    return null;
  }
}

async function writeJson(octokit, repo, path, obj, existingSha) {
  const [owner, name] = repo.full_name.split('/');
  const payload = { ...obj };
  delete payload._sha;
  const content = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
  return github.uploadChunk(octokit, owner, name, path, content, repo.default_branch, existingSha);
}

async function writeBinary(octokit, repo, path, buffer, existingSha) {
  const [owner, name] = repo.full_name.split('/');
  return github.uploadChunk(octokit, owner, name, path, buffer, repo.default_branch, existingSha);
}

async function deletePath(octokit, repo, path, sha) {
  if (!sha) return;
  const [owner, name] = repo.full_name.split('/');
  try {
    await github.deleteChunk(octokit, owner, name, path, sha, repo.default_branch);
  } catch {
    // already removed
  }
}

function buildManifest(file, chunks, encryption, hasThumbnail) {
  return {
    version: MANIFEST_VERSION,
    id: file.id,
    name: file.name,
    path: file.path,
    parent_path: file.parent_path,
    size: file.size,
    mime_type: file.mime_type,
    is_folder: !!file.is_folder,
    chunk_count: file.chunk_count || 0,
    encrypted: !!encryption,
    encryption: encryption || null,
    chunks: chunks.map(c => ({
      index: c.chunk_index,
      repo: c.full_name,
      repo_path: c.repo_path,
      sha: c.sha,
      size: c.size,
      plain_size: c.plain_size ?? null,
      chunk_iv: c.chunk_iv ?? null,
      chunk_tag: c.chunk_tag ?? null,
    })),
    encryption,
    thumbnail: hasThumbnail ? thumbnailPath(file.id) : null,
    created_at: file.created_at,
    updated_at: new Date().toISOString(),
  };
}

async function saveFileManifest(userId, file, chunks, encryption, hasThumbnail) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const metaRepo = getMetadataRepo(userId);
  if (!metaRepo) return;

  const octokit = github.createClient(user.access_token);
  const path = manifestPath(file.id);
  const existing = await readJson(octokit, metaRepo, path);
  const manifest = buildManifest(file, chunks, encryption, hasThumbnail);

  const sha = await writeJson(octokit, metaRepo, path, manifest, existing?._sha);
  await updateIndex(userId, file, manifest, sha);

  const metaCache = require('./meta-cache');
  metaCache.put(userId, file.id, manifest, {
    name: file.name,
    fileUpdatedAt: file.updated_at || null,
  });
  return sha;
}

async function saveThumbnail(userId, fileId, buffer, fileName = null) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const metaRepo = getMetadataRepo(userId);
  if (!metaRepo || !buffer) return null;

  const thumbCache = require('./thumb-cache');
  thumbCache.put(userId, fileId, buffer, fileName);

  const octokit = github.createClient(user.access_token);
  const path = thumbnailPath(fileId);
  let existingSha;
  try {
    const [owner, name] = metaRepo.full_name.split('/');
    const branch = metaRepo.default_branch || 'main';
    // Try raw.githubusercontent.com HEAD first — zero API calls
    const rawUrl = `https://raw.githubusercontent.com/${owner}/${name}/${branch}/${path}`;
    const headResp = await fetch(rawUrl, { method: 'HEAD', timeout: 5000 });
    if (headResp.ok) {
      existingSha = 'exists';
    } else {
      const { data } = await octokit.repos.getContent({ owner, repo: name, path, ref: branch });
      if (!Array.isArray(data)) existingSha = data.sha;
    }
  } catch {
    // new thumbnail
  }

  const sha = await writeBinary(octokit, metaRepo, path, buffer, existingSha);
  return sha;
}

async function updateIndex(userId, file, manifest, manifestSha) {
  return withIndexLock(userId, async () => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    const metaRepo = getMetadataRepo(userId);
    if (!metaRepo) return;

    const octokit = github.createClient(user.access_token);
    const path = indexPath();
    const index = (await readJson(octokit, metaRepo, path)) || { version: MANIFEST_VERSION, files: {} };

    if (file.is_folder) {
      index.files[file.id] = {
        id: file.id,
        name: file.name,
        path: file.path,
        parent_path: file.parent_path,
        is_folder: true,
        updated_at: new Date().toISOString(),
      };
    } else {
      index.files[file.id] = {
        id: file.id,
        name: file.name,
        path: file.path,
        parent_path: file.parent_path,
        size: file.size,
        mime_type: file.mime_type,
        has_thumbnail: !!manifest.thumbnail,
        manifest_path: manifestPath(file.id),
        manifest_sha: manifestSha,
        updated_at: manifest.updated_at,
      };
    }

    index.updated_at = new Date().toISOString();
    await writeJson(octokit, metaRepo, path, index, index._sha);
  });
}

async function deleteFileMetadata(userId, fileId) {
  const thumbCache = require('./thumb-cache');
  const metaCache = require('./meta-cache');
  thumbCache.remove(userId, fileId);
  metaCache.remove(userId, fileId);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const metaRepo = getMetadataRepo(userId);
  if (!metaRepo) return;

  const octokit = github.createClient(user.access_token);
  const [owner, name] = metaRepo.full_name.split('/');

  for (const path of [manifestPath(fileId), thumbnailPath(fileId)]) {
    try {
      const { data } = await octokit.repos.getContent({ owner, repo: name, path, ref: metaRepo.default_branch });
      if (!Array.isArray(data)) {
        await github.deleteChunk(octokit, owner, name, path, data.sha, metaRepo.default_branch);
      }
    } catch {
      // not found
    }
  }

  await withIndexLock(userId, async () => {
    const index = await readJson(octokit, metaRepo, indexPath());
    if (index?.files?.[fileId]) {
      delete index.files[fileId];
      index.updated_at = new Date().toISOString();
      await writeJson(octokit, metaRepo, indexPath(), index, index._sha);
    }
  });
}

async function getFileManifest(userId, fileId) {
  const file = db.prepare(
    'SELECT name, updated_at FROM files WHERE id = ? AND user_id = ?'
  ).get(fileId, userId);

  const metaCache = require('./meta-cache');
  const cached = metaCache.get(userId, fileId, file?.updated_at || null);
  if (cached) return cached;

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const metaRepo = getMetadataRepo(userId);
  if (!metaRepo) return null;

  const octokit = github.createClient(user.access_token);
  const manifest = await readJson(octokit, metaRepo, manifestPath(fileId));
  if (manifest) {
    metaCache.put(userId, fileId, manifest, {
      name: file?.name || null,
      fileUpdatedAt: file?.updated_at || null,
    });
  }
  return manifest;
}

async function getThumbnail(userId, fileId) {
  const thumbCache = require('./thumb-cache');
  const cached = thumbCache.get(userId, fileId);
  if (cached) return cached;

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const metaRepo = getMetadataRepo(userId);
  if (!metaRepo) return null;

  const file = db.prepare('SELECT name FROM files WHERE id = ? AND user_id = ?').get(fileId, userId);

  const octokit = github.createClient(user.access_token);
  const [owner, name] = metaRepo.full_name.split('/');
  try {
    const buffer = await github.downloadChunk(
      octokit, owner, name, thumbnailPath(fileId), metaRepo.default_branch
    );
    if (buffer?.length) thumbCache.put(userId, fileId, buffer, file?.name || null);
    return buffer;
  } catch {
    return null;
  }
}

async function saveMasterKeyEnvelope(userId, masterKey) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const metaRepo = getMetadataRepo(userId);
  if (!metaRepo) return;

  const secret = process.env.SESSION_SECRET || 'dev-secret-change-me';
  const derived = require('crypto').createHash('sha256')
    .update(`${user.github_id}:${secret}`)
    .digest();

  const { iv, authTag, encrypted } = (() => {
    const iv = require('crypto').randomBytes(12);
    const cipher = require('crypto').createCipheriv('aes-256-gcm', derived, iv);
    const encrypted = Buffer.concat([cipher.update(masterKey), cipher.final()]);
    return { iv, authTag: cipher.getAuthTag(), encrypted };
  })();

  const envelope = {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64'),
    auth_tag: authTag.toString('base64'),
    key: encrypted.toString('base64'),
    note: 'Master key envelope — per-file keys are wrapped with this key in file manifests',
  };

  const octokit = github.createClient(user.access_token);
  const path = '.vault/metadata/vault.key';
  const existing = await readJson(octokit, metaRepo, path);
  await writeJson(octokit, metaRepo, path, envelope, existing?._sha);
}

async function updatePathMetadata(userId, file) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const metaRepo = getMetadataRepo(userId);
  if (!metaRepo) return;

  const octokit = github.createClient(user.access_token);
  const manifestFilePath = manifestPath(file.id);
  const existing = await readJson(octokit, metaRepo, manifestFilePath);

  if (file.is_folder) {
    const manifest = existing || {
      version: MANIFEST_VERSION,
      id: file.id,
      name: file.name,
      path: file.path,
      parent_path: file.parent_path,
      is_folder: true,
      updated_at: new Date().toISOString(),
    };
    manifest.path = file.path;
    manifest.parent_path = file.parent_path;
    manifest.updated_at = new Date().toISOString();
    const sha = existing
      ? await writeJson(octokit, metaRepo, manifestFilePath, manifest, existing._sha)
      : null;
    await updateIndex(userId, file, manifest, sha);
    return;
  }

  const manifest = existing || buildManifest(file, [], null, !!file.has_thumbnail);
  manifest.path = file.path;
  manifest.parent_path = file.parent_path;
  manifest.updated_at = new Date().toISOString();
  const sha = await writeJson(octokit, metaRepo, manifestFilePath, manifest, existing?._sha);
  await updateIndex(userId, file, manifest, sha);
}

async function warmSingleThumbnail(userId, file) {
  const thumbCache = require('./thumb-cache');
  if (thumbCache.has(userId, file.id)) return;

  if (file.has_thumbnail) {
    await getThumbnail(userId, file.id);
    return;
  }

  const thumbnails = require('./thumbnails');
  if (!thumbnails.isAudio(file.mime_type, file.name)
    && !thumbnails.isVideo(file.mime_type, file.name)) {
    return;
  }

  const thumb = await thumbnails.generateFromLookup(file.mime_type, file.name);
  if (thumb?.length) thumbCache.put(userId, file.id, thumb, file.name);
}

function warmThumbnailsBackground(userId, files) {
  const thumbCache = require('./thumb-cache');
  const thumbnails = require('./thumbnails');
  const workloadGovernor = require('./workload-governor');
  const pending = (files || [])
    .filter((f) => !f.is_folder && !thumbCache.has(userId, f.id) && (
      f.has_thumbnail
      || thumbnails.isAudio(f.mime_type, f.name)
      || thumbnails.isVideo(f.mime_type, f.name)
    ))
    .slice(0, 6);
  if (!pending.length) return;

  setImmediate(() => {
    workloadGovernor.runBackground(userId, async () => {
      for (const file of pending) {
        try {
          await warmSingleThumbnail(userId, file);
        } catch {
          // ignore warm failures
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }).catch(() => {});
  });
}

module.exports = {
  METADATA_REPO_NAME,
  getMetadataRepo,
  manifestPath,
  readJsonAtRef,
  saveFileManifest,
  saveThumbnail,
  deleteFileMetadata,
  getFileManifest,
  getThumbnail,
  warmThumbnailsBackground,
  saveMasterKeyEnvelope,
  buildManifest,
  updatePathMetadata,
};
