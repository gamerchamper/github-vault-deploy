const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const db = require('../db/database');
const github = require('./github');
const crypto = require('./crypto');
const metadata = require('./metadata');
const thumbnails = require('./thumbnails');
const accounts = require('./accounts');
const appUrl = require('./app-url');
const capacity = require('./capacity');
const { REPO_CAPACITY_BYTES } = capacity;

function touchFile(fileId) {
  if (!fileId) return;
  db.prepare("UPDATE files SET updated_at = datetime('now') WHERE id = ?").run(fileId);
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout: ${label}`)), ms)),
  ]);
}

const CHUNK_SIZE = parseInt(process.env.CHUNK_SIZE || '921600', 10);
const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;
const GITHUB_MAX_BLOB_BYTES = 100 * MB;
const MAX_CHUNK_BYTES = parseInt(process.env.MAX_CHUNK_MB || '95', 10) * MB;

/** Tracks content-replace uploads so history uses source=sync after finalize. */
const contentReplaceSources = new Map();
const MIN_CHUNK_BYTES = 64 * 1024;
const GCM_OVERHEAD_BYTES = 16;

function normalizeChunkSize(chunkSize) {
  const size = parseInt(chunkSize, 10) || CHUNK_SIZE;
  if (size < MIN_CHUNK_BYTES) {
    throw new Error(`Chunk size too small (min ${Math.round(MIN_CHUNK_BYTES / 1024)} KB)`);
  }
  if (size + GCM_OVERHEAD_BYTES > GITHUB_MAX_BLOB_BYTES) {
    throw new Error(
      `Chunk size exceeds GitHub's 100 MB per-file API limit (max ${MAX_CHUNK_BYTES / MB} MB plain)`
    );
  }
  if (size > MAX_CHUNK_BYTES) {
    throw new Error(`Chunk size too large (max ${MAX_CHUNK_BYTES / MB} MB)`);
  }
  return size;
}

function getUser(userId) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
}

function getActiveRepos(userId) {
  return db.prepare(`
    SELECT r.* FROM storage_repos r
    LEFT JOIN linked_accounts la ON r.linked_account_id = la.id
    WHERE r.user_id = ? AND r.is_active = 1 AND r.is_metadata = 0
      AND (r.repo_role IS NULL OR r.repo_role = 'primary')
      AND (r.linked_account_id IS NULL OR (la.is_active = 1 AND la.role = 'storage'))
      AND (COALESCE(r.total_bytes, 0) + COALESCE(r.reserved_bytes, 0) < ?)
    ORDER BY r.chunk_count ASC
  `).all(userId, REPO_CAPACITY_BYTES);
}

function pickRepo(repos, index) {
  if (repos.length === 0) return null;
  return repos[index % repos.length];
}

function storageRepoExists(repoId) {
  return !!db.prepare('SELECT id FROM storage_repos WHERE id = ?').get(repoId);
}

function assertUploadSessionFile(userId, fileId) {
  const row = db.prepare(
    "SELECT id, upload_status FROM files WHERE id = ? AND user_id = ? AND upload_status IN ('uploading', 'failed')"
  ).get(fileId, userId);
  if (!row) throw new Error('Upload session not found');
  return row;
}

function insertChunkRow({
  fileId, chunkIdx, repoId, repoPath, sha, encSize, iv, authTag, plainSize,
}) {
  try {
    db.prepare(`
      INSERT INTO chunks (file_id, chunk_index, repo_id, repo_path, sha, size, chunk_iv, chunk_tag, plain_size)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fileId, chunkIdx, repoId, repoPath, sha, encSize,
      iv.toString('base64'), authTag.toString('base64'), plainSize
    );
  } catch (err) {
    if (/FOREIGN KEY constraint failed/i.test(String(err.message))) {
      if (!db.prepare('SELECT id FROM files WHERE id = ?').get(fileId)) {
        throw new Error(
          'Upload session was removed during processing — use Resume in Background tasks or start a new upload.'
        );
      }
      if (!storageRepoExists(repoId)) {
        throw new Error(
          'Storage repository changed during upload — click Resume to continue on an available repo.'
        );
      }
      throw new Error(
        'Could not save chunk — the upload session or storage repo changed mid-upload. Click Resume to continue.'
      );
    }
    throw err;
  }
}

async function recoverChunkRepo(userId, fileId, chunkIdx, encrypted, repoPath) {
  const repos = getActiveRepos(userId);
  if (!repos.length) {
    throw new Error('Storage repository was removed. Add a repo in Settings, then click Resume.');
  }
  const { repo, octokit, owner, repoName } = await resolveRepoForChunkUpload(userId, repos, chunkIdx);
  const sha = await github.uploadChunk(
    octokit, owner, repoName, repoPath, encrypted, repo.default_branch
  );
  return { repo, sha };
}

function pickActiveRepo(userId, repos, chunkIdx) {
  let pool = repos;
  for (let attempt = 0; attempt < 2; attempt++) {
    const repo = pickRepo(pool, chunkIdx);
    if (repo && storageRepoExists(repo.id)) return repo;
    pool = getActiveRepos(userId);
    if (!pool.length) break;
  }
  throw new Error('Storage repository unavailable. Check Settings → Storage, then click Resume.');
}

function isGitHubNotFound(err) {
  const status = err?.status ?? err?.response?.status;
  const msg = String(err?.response?.data?.message || err?.message || '');
  return status === 404 || /not found/i.test(msg);
}

function isGitHubAccessDenied(err) {
  const status = err?.status ?? err?.response?.status;
  return status === 403 || status === 401;
}

async function resolveRepoForChunkUpload(userId, repos, chunkIdx) {
  if (!repos?.length) throw new Error('No storage repositories configured');

  const logger = require('../lib/logger');
  const tried = [];
  const start = chunkIdx % repos.length;

  for (let offset = 0; offset < repos.length; offset++) {
    const repo = repos[(start + offset) % repos.length];
    const [owner, repoName] = repo.full_name.split('/');
    const octokit = accounts.createClientForUpload(userId, repo);

    try {
      const info = await github.getRepoInfo(octokit, owner, repoName);
      const branch = info.default_branch || 'main';
      if (branch !== repo.default_branch) {
        db.prepare('UPDATE storage_repos SET default_branch = ? WHERE id = ?').run(branch, repo.id);
        repo.default_branch = branch;
      }
      return { repo, octokit, owner, repoName };
    } catch (err) {
      tried.push(repo.full_name);
      if (isGitHubNotFound(err) || isGitHubAccessDenied(err)) {
        db.prepare('UPDATE storage_repos SET is_active = 0 WHERE id = ?').run(repo.id);
        logger.warn('storage_repo_unavailable', {
          userId,
          repo: repo.full_name,
          linkedAccountId: repo.linked_account_id || null,
          error: err.response?.data?.message || err.message,
        });
        continue;
      }
      throw err;
    }
  }

  throw new Error(
    `No accessible storage repositories for upload (tried: ${tried.join(', ')}). `
    + 'Re-link storage accounts or create new repos in Settings.'
  );
}

function formatUploadGitHubError(err, repo) {
  const ghMsg = err?.response?.data?.message || err?.message || 'GitHub upload failed';
  const linked = repo.linked_account_id ? ' [linked storage account — re-link if token expired]' : '';
  return (
    `GitHub rejected chunk upload to ${repo.full_name} (branch ${repo.default_branch})${linked}: ${ghMsg}`
  );
}

function splitBuffer(buffer, chunkSize) {
  const chunks = [];
  for (let i = 0; i < buffer.length; i += chunkSize) {
    chunks.push(buffer.subarray(i, i + chunkSize));
  }
  return chunks;
}

function reportProgress(onProgress, patch) {
  if (onProgress) onProgress(patch);
}

function normalizeParentPath(parentPath) {
  return !parentPath || parentPath === '' ? '/' : parentPath;
}

function ensureFolderHierarchy(userId, parentPath) {
  const normalized = normalizeParentPath(parentPath);
  if (normalized === '/' || !normalized) return;
  const segments = normalized.replace(/^\//, '').split('/').filter(Boolean);
  let current = '/';
  for (const seg of segments) {
    const folderPath = current === '/' ? `/${seg}` : `${current}/${seg}`;
    const existing = db.prepare(
      'SELECT id FROM files WHERE user_id = ? AND parent_path = ? AND name = ? AND is_deleted = 0'
    ).get(userId, current, seg);
    if (!existing) {
      const id = uuidv4();
      db.prepare(`
        INSERT INTO files (id, user_id, name, path, size, is_folder, parent_path)
        VALUES (?, ?, ?, ?, 0, 1, ?)
      `).run(id, userId, seg, folderPath, current);
    }
    current = folderPath;
  }
}

function uploadPercent(chunksDone, totalChunks, phase) {
  if (phase === 'metadata') return 96;
  if (phase === 'thumbnail') return 2;
  if (!totalChunks) return 0;
  return 10 + Math.round((chunksDone / totalChunks) * 85);
}

function getUploadedChunkIndices(fileId) {
  return db.prepare(
    'SELECT chunk_index FROM chunks WHERE file_id = ? ORDER BY chunk_index'
  ).all(fileId).map((row) => row.chunk_index);
}

function getUploadedChunkCount(fileId) {
  return db.prepare('SELECT COUNT(*) as count FROM chunks WHERE file_id = ?').get(fileId).count;
}

function findNextChunkIndex(fileId, totalChunks) {
  const uploaded = new Set(getUploadedChunkIndices(fileId));
  for (let i = 0; i < totalChunks; i++) {
    if (!uploaded.has(i)) return i;
  }
  return totalChunks;
}

function shouldReserveHls(convertHls, mimeType, fileName) {
  if (!convertHls) return false;
  return (mimeType || '').startsWith('video/') || /\.mp4$/i.test(fileName || '');
}

function assertUploadCapacity(repos, fileSize, chunkSize, convertHls, mimeType, fileName) {
  const reserveHls = shouldReserveHls(convertHls, mimeType, fileName);
  const projection = capacity.checkUploadFits(repos, fileSize, chunkSize, reserveHls);
  if (!projection.fits) {
    throw new Error(capacity.uploadFitsError(projection));
  }
  return projection;
}

function planUpload(fileSize, chunkSize, userId, options = {}) {
  const { convertHls = false, mimeType = null, fileName = null } = options;
  const normalizedChunkSize = normalizeChunkSize(chunkSize);
  const repos = getActiveRepos(userId);
  const repoCount = Math.max(repos.length, 1);
  const reserveHls = shouldReserveHls(convertHls, mimeType, fileName);

  let allFull = false;
  if (repos.length === 0) {
    const anyRepo = db.prepare(
      'SELECT COUNT(*) as count FROM storage_repos WHERE user_id = ? AND is_active = 1 AND is_metadata = 0'
    ).get(userId);
    allFull = anyRepo.count > 0;
  }
  const storageProjection = capacity.projectUploadStorage(
    repos, fileSize, normalizedChunkSize, reserveHls
  );
  if (repos.length > 0 && !storageProjection.fits) allFull = true;
  const encryptedEstimate = storageProjection.uploadBytes;
  const totalChunks = Math.ceil(encryptedEstimate / normalizedChunkSize) || 1;
  const perRepo = {};
  const distribution = [];

  for (let i = 0; i < totalChunks; i++) {
    const repo = repos[i % repoCount];
    const repoName = repo?.full_name || `vault-storage-${(i % repoCount) + 1}`;
    perRepo[repoName] = (perRepo[repoName] || 0) + 1;
    distribution.push({ chunk: i, repo: repoName });
  }

  const secondsPerChunk = 2.5;
  const estimatedSeconds = Math.ceil(totalChunks * secondsPerChunk);

  return {
    fileSize,
    chunkSize: normalizedChunkSize,
    chunkSizeMb: +(normalizedChunkSize / MB).toFixed(2),
    maxChunkBytes: MAX_CHUNK_BYTES,
    maxChunkMb: MAX_CHUNK_BYTES / MB,
    githubMaxMb: GITHUB_MAX_BLOB_BYTES / MB,
    totalChunks,
    repoCount,
    perRepo,
    distribution: distribution.slice(0, 20),
    distributionTruncated: distribution.length > 20,
    estimatedSeconds,
    estimatedTime: formatDuration(estimatedSeconds),
    needsConfig: repos.length === 0 && !allFull,
    allFull,
    convertHls: reserveHls,
    uploadBytesEstimate: storageProjection.uploadBytes,
    hlsBytesEstimate: storageProjection.hlsBytes,
    totalStorageBytes: storageProjection.totalBytes,
    insufficientSpace: repos.length > 0 && !storageProjection.fits,
    storageAvailableBytes: storageProjection.poolAvailableBytes,
    storageShortfallBytes: storageProjection.insufficientBytes,
  };
}

function formatDuration(seconds) {
  if (seconds < 60) return `~${seconds}s`;
  if (seconds < 3600) return `~${Math.ceil(seconds / 60)} min`;
  return `~${(seconds / 3600).toFixed(1)} hr`;
}

async function uploadFile(userId, filePath, parentPath, buffer, mimeType, options = {}) {
  const {
    chunkSize: rawChunkSize = CHUNK_SIZE,
    onProgress = null,
  } = options;
  const chunkSize = normalizeChunkSize(rawChunkSize);

  const user = getUser(userId);
  if (!user) throw new Error('User not found');
  if (!user.master_key) throw new Error('Encryption not initialized. Please refresh and try again.');

  const repos = getActiveRepos(userId);
  if (repos.length === 0) {
    const anyActive = db.prepare(
      'SELECT COUNT(*) as count FROM storage_repos WHERE user_id = ? AND is_active = 1 AND is_metadata = 0 AND COALESCE(total_bytes, 0) >= ?'
    ).get(userId, REPO_CAPACITY_BYTES);
    throw new Error(anyActive.count > 0
      ? 'All storage repositories are full (reached 1 GB limit). Add more repos or remove files.'
      : 'No storage repositories configured.');
  }

  const fileId = uuidv4();
  const fileName = path.basename(filePath);
  const normalizedParent = parentPath === '' ? '/' : parentPath;
  const masterKey = crypto.getMasterKey(user);
  const fileKey = crypto.generateKey();
  const encryptionMeta = crypto.wrapFileKey(fileKey, masterKey);

  reportProgress(onProgress, { phase: 'thumbnail', percent: 2, chunksDone: 0, chunksTotal: 0 });
  const thumbBuffer = await thumbnails.generate(buffer, mimeType, fileName);

  const plainParts = splitBuffer(buffer, chunkSize);
  const totalChunks = plainParts.length;

  reportProgress(onProgress, { phase: 'encrypt', percent: 5, chunksDone: 0, chunksTotal: totalChunks });

  const encryptedParts = plainParts.map((part) => {
    const { encrypted, iv, authTag } = crypto.encryptChunk(part, fileKey);
    return { data: encrypted, iv, authTag, plainSize: part.length };
  });

  const insertFile = db.prepare(`
    INSERT INTO files (id, user_id, name, path, size, mime_type, parent_path, chunk_count, has_thumbnail, encryption_meta, encryption_mode)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'chunk')
  `);

  const insertChunk = db.prepare(`
    INSERT INTO chunks (file_id, chunk_index, repo_id, repo_path, sha, size, chunk_iv, chunk_tag, plain_size)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const updateRepo = db.prepare(`
    UPDATE storage_repos SET chunk_count = chunk_count + 1, total_bytes = total_bytes + ? WHERE id = ?
  `);

  const fileRecord = {
    id: fileId,
    name: fileName,
    path: `${normalizedParent === '/' ? '' : normalizedParent}/${fileName}`,
    parent_path: normalizedParent,
    size: buffer.length,
    mime_type: mimeType || 'application/octet-stream',
    chunk_count: totalChunks,
    is_folder: 0,
    created_at: new Date().toISOString(),
  };

  insertFile.run(
    fileId, userId, fileName, fileRecord.path,
    buffer.length, fileRecord.mime_type,
    normalizedParent, totalChunks,
    thumbBuffer ? 1 : 0,
    JSON.stringify(encryptionMeta)
  );

  const chunkRecords = [];

  for (let i = 0; i < encryptedParts.length; i++) {
    const part = encryptedParts[i];
    const repo = pickRepo(repos, i);
    const [owner, repoName] = repo.full_name.split('/');
    const repoPath = `.vault/chunks/${fileId}/${String(i).padStart(5, '0')}.bin`;

    const octokit = accounts.createClientForUpload(userId, repo);
    const sha = await github.uploadChunk(
      octokit, owner, repoName, repoPath,
      part.data, repo.default_branch
    );

    const chunkResult = insertChunk.run(
      fileId, i, repo.id, repoPath, sha, part.data.length,
      part.iv.toString('base64'), part.authTag.toString('base64'), part.plainSize
    );
    updateRepo.run(part.data.length, repo.id);

    chunkRecords.push({
      chunk_index: i,
      full_name: repo.full_name,
      repo_path: repoPath,
      sha,
      size: part.data.length,
      plain_size: part.plainSize,
      chunk_iv: part.iv.toString('base64'),
      chunk_tag: part.authTag.toString('base64'),
    });

    const pct = 10 + Math.round(((i + 1) / totalChunks) * 85);
    reportProgress(onProgress, {
      phase: 'upload',
      chunksDone: i + 1,
      chunksTotal: totalChunks,
      percent: pct,
      currentRepo: repo.full_name,
    });
  }

  reportProgress(onProgress, { phase: 'metadata', percent: 96, chunksDone: totalChunks, chunksTotal: totalChunks });

  if (thumbBuffer) {
    await metadata.saveThumbnail(userId, fileId, thumbBuffer, fileName);
  }

  const manifestSha = await metadata.saveFileManifest(userId, fileRecord, chunkRecords, encryptionMeta, !!thumbBuffer);
  await purgeDuplicateFiles(userId, fileId, fileRecord.path, normalizedParent);
  await maybeRecordFileHistory(userId, fileId, { source: 'upload', manifestSha });

  reportProgress(onProgress, { phase: 'done', percent: 100, chunksDone: totalChunks, chunksTotal: totalChunks });

  return { id: fileId, name: fileName, size: buffer.length, chunks: totalChunks, encrypted: true };
}

function findBestUploadSession(userId, fileName, parentPath, size) {
  const normalizedParent = normalizeParentPath(parentPath);
  return db.prepare(`
    SELECT f.*,
      (SELECT COUNT(*) FROM chunks WHERE file_id = f.id) AS chunks_done
    FROM files f
    WHERE f.user_id = ? AND f.parent_path = ? AND f.name = ?
      AND f.upload_status IN ('uploading', 'failed') AND f.size = ?
      AND COALESCE(f.is_deleted, 0) = 0
    ORDER BY chunks_done DESC, f.updated_at DESC
    LIMIT 1
  `).get(userId, normalizedParent, fileName, size);
}

function uploadSessionInUse(userId, fileId) {
  let seamlessUpload;
  try {
    seamlessUpload = require('./seamless-upload');
    if (seamlessUpload.isProcessing(userId, fileId)) return true;
  } catch {
    // seamless-upload may be unavailable in tests
  }

  const row = db.prepare(`
    SELECT status, updated_at FROM tasks
    WHERE user_id = ? AND type = 'upload'
      AND status IN ('processing', 'pending', 'paused')
      AND payload LIKE ?
    ORDER BY updated_at DESC LIMIT 1
  `).get(userId, `%"fileId":"${fileId}"%`);
  if (!row) return false;
  if (row.status === 'paused') return true;
  const updatedMs = new Date(row.updated_at).getTime();
  return Number.isFinite(updatedMs) && Date.now() - updatedMs < 30 * 60 * 1000;
}

async function abandonStaleUploadSessions(userId, fileName, parentPath, size) {
  const normalizedParent = normalizeParentPath(parentPath);
  const stale = db.prepare(`
    SELECT id FROM files
    WHERE user_id = ? AND parent_path = ? AND name = ? AND size = ?
      AND upload_status IN ('uploading', 'failed')
  `).all(userId, normalizedParent, fileName, size);

  for (const { id } of stale) {
    if (uploadSessionInUse(userId, id)) {
      throw new Error(
        `An upload of "${fileName}" is already in progress on the server. `
        + 'Wait for it to finish or cancel it in Background tasks before starting another.'
      );
    }
    await purgeUploadSessionLocal(userId, id);
  }
}

async function purgeUploadSessionLocal(userId, fileId) {
  const file = db.prepare('SELECT id FROM files WHERE id = ? AND user_id = ?').get(fileId, userId);
  if (!file) return;

  if (uploadSessionInUse(userId, fileId)) return;
  capacity.releaseHlsReserve(userId, fileId);
  require('./git-upload').cleanupWorkspace(userId, fileId);
  db.prepare(`
    DELETE FROM chunk_sync_failures
    WHERE chunk_id IN (SELECT id FROM chunks WHERE file_id = ?)
  `).run(fileId);
  db.prepare('DELETE FROM chunk_backups WHERE chunk_id IN (SELECT id FROM chunks WHERE file_id = ?)').run(fileId);
  db.prepare('DELETE FROM chunks WHERE file_id = ?').run(fileId);
  db.prepare('DELETE FROM hls_segments WHERE file_id = ?').run(fileId);
  db.prepare('DELETE FROM playlist_items WHERE file_id = ?').run(fileId);
  invalidateUploadTasksForFile(userId, fileId);
  db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
}

async function cleanupSiblingStaleUploadSessions(userId, file) {
  const normalizedParent = normalizeParentPath(file.parent_path);
  const stale = db.prepare(`
    SELECT id FROM files
    WHERE user_id = ? AND parent_path = ? AND name = ? AND size = ?
      AND upload_status IN ('uploading', 'failed') AND id != ?
  `).all(userId, normalizedParent, file.name, file.size, file.id);

  for (const { id } of stale) {
    await purgeUploadSessionLocal(userId, id);
  }
}

function invalidateUploadTasksForFile(userId, fileId) {
  const tasks = require('./tasks');
  const rows = db.prepare(`
    SELECT id, payload FROM tasks
    WHERE user_id = ? AND type = 'upload'
      AND status IN ('processing', 'pending', 'paused', 'error')
  `).all(userId);

  for (const row of rows) {
    let payload = {};
    try {
      payload = row.payload ? JSON.parse(row.payload) : {};
    } catch {
      payload = {};
    }
    if (payload.fileId !== fileId) continue;
    tasks.update(row.id, userId, {
      status: 'error',
      phase: 'cancelled',
      error: 'Superseded',
      resumable: false,
    });
  }
}

function resolveResumeChunkSize(userId, fileId, rawChunkSize, totalChunks, size) {
  let chunkSize = normalizeChunkSize(rawChunkSize);
  const firstChunk = db.prepare(
    'SELECT plain_size FROM chunks WHERE file_id = ? ORDER BY chunk_index LIMIT 1'
  ).get(fileId);
  if (firstChunk?.plain_size) {
    return firstChunk.plain_size;
  }

  const taskRow = db.prepare(`
    SELECT payload FROM tasks
    WHERE user_id = ? AND type = 'upload' AND payload LIKE ?
    ORDER BY updated_at DESC LIMIT 1
  `).get(userId, `%"fileId":"${fileId}"%`);
  const fromTask = taskRow?.payload ? JSON.parse(taskRow.payload).chunkSize : null;
  if (fromTask) {
    return normalizeChunkSize(fromTask);
  }
  if ((Math.ceil(size / chunkSize) || 1) !== totalChunks) {
    return Math.ceil(size / totalChunks);
  }
  return chunkSize;
}

async function cleanupEmptyUploadDuplicates(userId, fileName, parentPath, size, keepFileId) {
  const normalizedParent = normalizeParentPath(parentPath);
  const dupes = db.prepare(`
    SELECT id FROM files
    WHERE user_id = ? AND parent_path = ? AND name = ? AND size = ?
      AND upload_status = 'uploading' AND id != ?
  `).all(userId, normalizedParent, fileName, size, keepFileId);

  for (const { id } of dupes) {
    if (getUploadedChunkCount(id) === 0) {
      await deleteFile(userId, id);
    }
  }
}

async function clearFileChunksForReplace(userId, fileId) {
  const chunks = db.prepare('SELECT * FROM chunks WHERE file_id = ?').all(fileId);
  const updateRepo = db.prepare(
    'UPDATE storage_repos SET chunk_count = ?, total_bytes = ? WHERE id = ?',
  );
  for (const chunk of chunks) {
    const repo = db.prepare('SELECT chunk_count, total_bytes FROM storage_repos WHERE id = ?').get(chunk.repo_id);
    if (repo) {
      updateRepo.run(
        Math.max(0, (repo.chunk_count || 0) - 1),
        Math.max(0, (repo.total_bytes || 0) - chunk.size),
        chunk.repo_id,
      );
    }
  }
  db.prepare(`
    DELETE FROM chunk_sync_failures
    WHERE chunk_id IN (SELECT id FROM chunks WHERE file_id = ?)
  `).run(fileId);
  db.prepare('DELETE FROM chunk_backups WHERE chunk_id IN (SELECT id FROM chunks WHERE file_id = ?)').run(fileId);
  db.prepare('DELETE FROM chunks WHERE file_id = ?').run(fileId);
  db.prepare('DELETE FROM hls_segments WHERE file_id = ?').run(fileId);
  require('./cache').remove(userId, fileId);
}

async function initUploadSession(userId, params) {
  const {
    fileName,
    parentPath,
    size,
    mimeType,
    chunkSize: rawChunkSize = CHUNK_SIZE,
    fileId: resumeFileId,
    replaceFileId = null,
    contentSource = 'upload',
    convertHls = false,
  } = params;

  let chunkSize = normalizeChunkSize(rawChunkSize);
  const user = getUser(userId);
  if (!user) throw new Error('User not found');
  if (!user.master_key) throw new Error('Encryption not initialized. Please refresh and try again.');

  const repos = getActiveRepos(userId);
  if (!repos.length) {
    const anyActive = db.prepare(
      'SELECT COUNT(*) as count FROM storage_repos WHERE user_id = ? AND is_active = 1 AND is_metadata = 0 AND COALESCE(total_bytes, 0) >= ?'
    ).get(userId, REPO_CAPACITY_BYTES);
    throw new Error(anyActive.count > 0
      ? 'All storage repositories are full (reached 1 GB limit). Add more repos or remove files.'
      : 'No storage repositories configured.');
  }

  assertUploadCapacity(repos, size, chunkSize, convertHls, mimeType, fileName);

  const normalizedParent = normalizeParentPath(parentPath);
  ensureFolderHierarchy(userId, normalizedParent);
  let totalChunks = Math.ceil(size / chunkSize) || 1;
  const filePath = normalizedParent === '/' ? `/${fileName}` : `${normalizedParent}/${fileName}`;
  let fileId = resumeFileId;
  let existing = null;

  if (replaceFileId) {
    const ready = db.prepare(`
      SELECT * FROM files WHERE id = ? AND user_id = ? AND is_folder = 0 AND is_deleted = 0
        AND (upload_status IS NULL OR upload_status = 'ready')
    `).get(replaceFileId, userId);
    if (!ready) throw new Error('File not found for content update');
    if (ready.name !== fileName) {
      throw new Error('File name does not match the existing file');
    }

    const fileHistory = require('./file-history');
    await fileHistory.recordVersionBeforeReplace(userId, replaceFileId, {
      source: contentSource === 'sync' ? 'sync' : 'upload',
    });

    await clearFileChunksForReplace(userId, replaceFileId);
    totalChunks = Math.ceil(size / chunkSize) || 1;
    fileId = replaceFileId;
    contentReplaceSources.set(fileId, contentSource === 'sync' ? 'sync' : 'upload');

    db.prepare(`
      UPDATE files SET size = ?, mime_type = ?, chunk_count = ?, upload_status = 'uploading',
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      size,
      mimeType || ready.mime_type || 'application/octet-stream',
      totalChunks,
      fileId,
    );
  } else if (fileId) {
    existing = db.prepare(
      `SELECT * FROM files WHERE id = ? AND user_id = ? AND upload_status IN ('uploading', 'failed')`
    ).get(fileId, userId);
    if (!existing) {
      existing = findBestUploadSession(userId, fileName, parentPath, size);
      if (existing) fileId = existing.id;
    }
    if (!existing) {
      throw new Error('Upload session not found or already completed — start a new upload');
    }
    if (existing.size !== size || existing.name !== fileName) {
      throw new Error('File does not match the interrupted upload');
    }
    totalChunks = existing.chunk_count;
    chunkSize = resolveResumeChunkSize(userId, fileId, rawChunkSize, totalChunks, size);
    db.prepare('UPDATE files SET upload_status = ? WHERE id = ?').run('uploading', fileId);
    await cleanupEmptyUploadDuplicates(userId, fileName, parentPath, size, fileId);
  } else {
    const conflict = db.prepare(`
      SELECT id FROM files
      WHERE user_id = ? AND parent_path = ? AND name = ?
        AND (upload_status IS NULL OR upload_status = 'ready')
      AND is_deleted = 0
    `).get(userId, normalizedParent, fileName);
    if (conflict) throw new Error('A file with this name already exists');

    await abandonStaleUploadSessions(userId, fileName, parentPath, size);

    fileId = uuidv4();
    const masterKey = crypto.getMasterKey(user);
    const fileKey = crypto.generateKey();
    const encryptionMeta = crypto.wrapFileKey(fileKey, masterKey);

    db.prepare(`
      INSERT INTO files (
        id, user_id, name, path, size, mime_type, parent_path, chunk_count,
        has_thumbnail, encryption_meta, encryption_mode, upload_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'chunk', 'uploading')
    `).run(
      fileId, userId, fileName, filePath, size,
      mimeType || 'application/octet-stream',
      normalizedParent, totalChunks,
      JSON.stringify(encryptionMeta)
    );
  }

  if (shouldReserveHls(convertHls, mimeType, fileName)) {
    capacity.ensureHlsReserved(userId, fileId, size, repos);
  }

  const chunksDone = getUploadedChunkCount(fileId);
  const nextChunk = findNextChunkIndex(fileId, totalChunks);

  return {
    fileId,
    totalChunks,
    chunkSize,
    chunksDone,
    nextChunk,
    resumable: chunksDone > 0,
    percent: uploadPercent(chunksDone, totalChunks),
  };
}

async function uploadPlainChunk(userId, fileId, chunkIndex, buffer, uploadMode = 'api', taskContext = null) {
  const user = getUser(userId);
  if (!user) throw new Error('User not found');

  const file = db.prepare(
    "SELECT * FROM files WHERE id = ? AND user_id = ? AND upload_status IN ('uploading', 'failed')"
  ).get(fileId, userId);
  if (!file) {
    const logger = require('../lib/logger');
    logger.warn('upload_session_not_found', { userId, fileId, chunkIndex, phase: 'uploadPlainChunk' });
    throw new Error('Upload session not found');
  }

  const chunkIdx = parseInt(chunkIndex, 10);
  if (!Number.isFinite(chunkIdx) || chunkIdx < 0 || chunkIdx >= file.chunk_count) {
    throw new Error('Invalid chunk index');
  }
  if (buffer.length > MAX_CHUNK_BYTES + GCM_OVERHEAD_BYTES) {
    throw new Error(
      `Chunk blob is ${(buffer.length / MB).toFixed(1)} MB (max ${MAX_CHUNK_BYTES / MB} MB). Reduce chunk size in upload settings.`
    );
  }

  const existing = db.prepare(
    'SELECT id FROM chunks WHERE file_id = ? AND chunk_index = ?'
  ).get(fileId, chunkIdx);
  if (existing) {
    const chunksDone = getUploadedChunkCount(fileId);
    return {
      skipped: true,
      chunksDone,
      totalChunks: file.chunk_count,
      percent: uploadPercent(chunksDone, file.chunk_count),
      nextChunk: findNextChunkIndex(fileId, file.chunk_count),
    };
  }

  let repos = getActiveRepos(userId);
  if (!repos.length) throw new Error('No storage repositories configured');

  const fileKey = await getFileKeyFromMeta(userId, file);
  const { encrypted, iv, authTag } = crypto.encryptChunk(buffer, fileKey);
  const repoPath = `.vault/chunks/${fileId}/${String(chunkIdx).padStart(5, '0')}.bin`;

  let sha = 'pending';
  let repo;
  let octokit;
  let owner;
  let repoName;

  if (uploadMode === 'git') {
    repo = pickActiveRepo(userId, repos, chunkIdx);
    const gitUpload = require('./git-upload');
    const available = await gitUpload.isGitAvailable();
    if (!available) throw new Error('Git is not installed on the server');
    const onLog = taskContext?.taskId
      ? (msg, meta) => {
          const tasks = require('./tasks');
          tasks.appendLog(taskContext.taskId, taskContext.userId, msg, meta);
        }
      : null;
    await gitUpload.writeChunk(userId, fileId, repo, chunkIdx, repoPath, encrypted, onLog);
  } else {
    ({ repo, octokit, owner, repoName } = await resolveRepoForChunkUpload(userId, repos, chunkIdx));
    const rateLimit = require('./github-rate-limit');
    const token = accounts.getTokenForRepo(userId, repo);
    const tokenKey = rateLimit.keyForToken(token);
    let clearRateCb = () => {};
    if (taskContext?.taskId) {
      const tasks = require('./tasks');
      clearRateCb = rateLimit.setWaitCallback(tokenKey, (info) => {
        const secs = Math.ceil(info.waitMs / 1000);
        const mins = Math.ceil(secs / 60);
        const waitLabel = mins >= 2 ? `${mins} min` : `${secs}s`;
        tasks.update(taskContext.taskId, taskContext.userId, {
          phase: 'rate-limit',
          currentRepo: `GitHub rate limit — resuming in ${waitLabel}`,
          lastLog: `Waiting for GitHub rate limit (${waitLabel})`,
        });
      });
    }
    const startTime = Date.now();
    try {
      try {
        sha = await github.uploadChunk(
          octokit, owner, repoName, repoPath,
          encrypted, repo.default_branch
        );
      } catch (uploadErr) {
        if (isGitHubNotFound(uploadErr)) {
          try {
            const info = await github.getRepoInfo(octokit, owner, repoName);
            const branch = info.default_branch || 'main';
            if (branch !== repo.default_branch) {
              db.prepare('UPDATE storage_repos SET default_branch = ? WHERE id = ?').run(branch, repo.id);
              repo.default_branch = branch;
            }
            sha = await github.uploadChunk(
              octokit, owner, repoName, repoPath,
              encrypted, branch
            );
          } catch (retryErr) {
            throw new Error(formatUploadGitHubError(retryErr, repo));
          }
        } else {
          throw uploadErr;
        }
      }
    } finally {
      clearRateCb();
      const elapsed = Date.now() - startTime;
      if (elapsed > 30000) {
        const logger = require('../lib/logger');
        logger.warn('slow_github_upload', {
          userId, fileId, chunkIndex, repo: repo.full_name,
          elapsedMs: elapsed, size: encrypted.length,
        });
      }
    }
  }

  assertUploadSessionFile(userId, fileId);
  if (!storageRepoExists(repo.id)) {
    if (uploadMode === 'git') {
      throw new Error('Storage repository was removed during upload. Click Resume to continue.');
    }
    ({ repo, sha } = await recoverChunkRepo(userId, fileId, chunkIdx, encrypted, repoPath));
  }

  const persistChunk = () => {
    insertChunkRow({
      fileId,
      chunkIdx,
      repoId: repo.id,
      repoPath,
      sha,
      encSize: encrypted.length,
      iv,
      authTag,
      plainSize: buffer.length,
    });
    if (uploadMode !== 'git') {
      db.prepare(
        'UPDATE storage_repos SET chunk_count = chunk_count + 1, total_bytes = total_bytes + ? WHERE id = ?'
      ).run(encrypted.length, repo.id);
    }
  };

  try {
    persistChunk();
  } catch (err) {
    if (uploadMode !== 'git' && /storage repository changed/i.test(err.message)) {
      ({ repo, sha } = await recoverChunkRepo(userId, fileId, chunkIdx, encrypted, repoPath));
      persistChunk();
    } else {
      throw err;
    }
  }

  const sessionFile = db.prepare('SELECT upload_status FROM files WHERE id = ?').get(fileId);
  if (sessionFile?.upload_status === 'failed') {
    db.prepare('UPDATE files SET upload_status = ? WHERE id = ?').run('uploading', fileId);
    const logger = require('../lib/logger');
    logger.info('upload_chunk_resumed_after_failure', { userId, fileId, chunkIndex });
  }

  const chunksDone = getUploadedChunkCount(fileId);
  return {
    skipped: false,
    chunksDone,
    totalChunks: file.chunk_count,
    percent: uploadPercent(chunksDone, file.chunk_count),
    currentRepo: repo.full_name,
    nextChunk: findNextChunkIndex(fileId, file.chunk_count),
  };
}

async function finalizeUpload(userId, fileId, previewBuffer, onProgress, uploadMode = 'api', taskContext = null) {
  const user = getUser(userId);
  if (!user) throw new Error('User not found');

  const file = db.prepare(
    "SELECT * FROM files WHERE id = ? AND user_id = ? AND upload_status IN ('uploading', 'failed')"
  ).get(fileId, userId);
  if (!file) {
    const logger = require('../lib/logger');
    logger.warn('upload_session_not_found', { userId, fileId, phase: 'finalizeUpload' });
    throw new Error('Upload session not found');
  }

  const chunksDone = getUploadedChunkCount(fileId);
  if (chunksDone < file.chunk_count) {
    throw new Error(`Upload incomplete: ${chunksDone}/${file.chunk_count} chunks uploaded`);
  }

  if (uploadMode === 'git') {
    const gitUpload = require('./git-upload');
    reportProgress(onProgress, {
      phase: 'git-push',
      percent: 88,
      chunksDone,
      chunksTotal: file.chunk_count,
    });
    const onLog = taskContext?.taskId
      ? (msg, meta) => {
          const tasks = require('./tasks');
          tasks.appendLog(taskContext.taskId, taskContext.userId, msg, meta);
        }
      : null;
    await gitUpload.pushWorkspace(userId, fileId, onProgress, onLog);
    await gitUpload.resolveChunkShas(userId, fileId);
    gitUpload.cleanupWorkspace(userId, fileId);

  }

  const backupSync = require('./backup-sync');
  backupSync.startAllBackupSyncs(userId);

  reportProgress(onProgress, { phase: 'thumbnail', percent: 2, chunksDone, chunksTotal: file.chunk_count });

  let thumbBuffer = null;
  if (previewBuffer?.length) {
    thumbBuffer = await thumbnails.generate(previewBuffer, file.mime_type, file.name);
  }
  if (!thumbBuffer && (thumbnails.isAudio(file.mime_type, file.name) || thumbnails.isVideo(file.mime_type, file.name))) {
    thumbBuffer = await thumbnails.generateFromLookup(file.mime_type, file.name);
  }
  if (thumbBuffer) {
    db.prepare('UPDATE files SET has_thumbnail = 1 WHERE id = ?').run(fileId);
  }

  reportProgress(onProgress, { phase: 'metadata', percent: 96, chunksDone, chunksTotal: file.chunk_count });

  const chunks = db.prepare(`
    SELECT c.*, r.full_name FROM chunks c
    JOIN storage_repos r ON c.repo_id = r.id
    WHERE c.file_id = ? ORDER BY c.chunk_index
  `).all(fileId);

  const encryptionMeta = JSON.parse(file.encryption_meta);
  const fileRecord = {
    id: file.id,
    name: file.name,
    path: file.path,
    parent_path: file.parent_path,
    size: file.size,
    mime_type: file.mime_type,
    chunk_count: file.chunk_count,
    is_folder: 0,
    created_at: file.created_at,
  };

  const chunkRecords = chunks.map((chunk) => ({
    chunk_index: chunk.chunk_index,
    full_name: chunk.full_name,
    repo_path: chunk.repo_path,
    sha: chunk.sha,
    size: chunk.size,
    plain_size: chunk.plain_size,
    chunk_iv: chunk.chunk_iv,
    chunk_tag: chunk.chunk_tag,
  }));

  if (thumbBuffer) {
    await metadata.saveThumbnail(userId, fileId, thumbBuffer, file.name);
  }

  const manifestSha = await metadata.saveFileManifest(userId, fileRecord, chunkRecords, encryptionMeta, !!thumbBuffer);
  await purgeDuplicateFiles(userId, fileId, file.path, file.parent_path);

  db.prepare('UPDATE files SET upload_status = ? WHERE id = ?').run('ready', fileId);
  const historySource = contentReplaceSources.get(fileId) || 'upload';
  contentReplaceSources.delete(fileId);
  await maybeRecordFileHistory(userId, fileId, { source: historySource, manifestSha });

  reportProgress(onProgress, { phase: 'done', percent: 100, chunksDone, chunksTotal: file.chunk_count });

  notifyPlaylistFolderSync(userId, [fileId]);

  return {
    id: fileId,
    name: file.name,
    size: file.size,
    chunks: file.chunk_count,
    encrypted: true,
  };
}

function markUploadFailed(userId, fileId) {
  db.prepare(
    'UPDATE files SET upload_status = ? WHERE id = ? AND user_id = ? AND upload_status = ?'
  ).run('failed', fileId, userId, 'uploading');
}

async function cancelUploadSession(userId, fileId) {
  const file = db.prepare(
    'SELECT * FROM files WHERE id = ? AND user_id = ? AND upload_status IN (\'uploading\', \'failed\')'
  ).get(fileId, userId);
  if (!file) return;
  try { require('./seamless-upload').cleanupStaging(userId, fileId); } catch {}
  require('./git-upload').cleanupWorkspace(userId, fileId);
  await deleteFile(userId, fileId);
}

function getUploadSession(userId, fileId) {
  const file = db.prepare(
    'SELECT * FROM files WHERE id = ? AND user_id = ? AND upload_status IN (\'uploading\', \'failed\')'
  ).get(fileId, userId);
  if (!file) return null;

  const chunksDone = getUploadedChunkCount(fileId);
  return {
    fileId: file.id,
    fileName: file.name,
    parentPath: file.parent_path,
    fileSize: file.size,
    mimeType: file.mime_type,
    totalChunks: file.chunk_count,
    chunksDone,
    nextChunk: findNextChunkIndex(file.id, file.chunk_count),
    percent: uploadPercent(chunksDone, file.chunk_count),
    resumable: true,
  };
}

async function purgeDuplicateFiles(userId, keepFileId, filePath, parentPath) {
  const dupes = db.prepare(
    'SELECT id FROM files WHERE user_id = ? AND path = ? AND parent_path = ? AND id != ? AND is_folder = 0'
  ).all(userId, filePath, parentPath, keepFileId);

  for (const { id } of dupes) {
    db.prepare('DELETE FROM chunks WHERE file_id = ?').run(id);
    db.prepare('DELETE FROM files WHERE id = ?').run(id);
    await metadata.deleteFileMetadata(userId, id);
    require('./cache').remove(userId, id);
  }
}

async function fetchAndDecrypt(userId, file, chunks, onProgress, view = null) {
  if (isChunkMode(file, chunks)) {
    const fileKey = await getFileKeyFromMeta(userId, file);
    const total = chunks.length;
    const { createAdaptivePool, mapAdaptive } = require('./adaptive-concurrency');
    const rateLimit = require('./github-rate-limit');
    const user = getUser(userId);
    const tokenKey = user?.access_token ? rateLimit.keyForToken(user.access_token) : null;
    const recommended = tokenKey ? rateLimit.getRecommendedConcurrency(tokenKey, 16) : 16;
    const pool = createAdaptivePool(chunks.length, {
      max: 32,
      initial: recommended,
      getMax: tokenKey ? () => rateLimit.getRecommendedConcurrency(tokenKey, 16) : null,
    });
    let fetched = 0;

    const parts = await mapAdaptive(chunks, pool, async (chunk) => {
      const enc = await accounts.downloadChunkForView(userId, chunk, view);
      const dec = crypto.decryptChunk(enc, fileKey, chunk.chunk_iv, chunk.chunk_tag);
      pool.recordBytes(dec.length);
      fetched += 1;
      if (onProgress) onProgress(fetched, total, 'fetching');
      return { index: chunk.chunk_index, dec };
    });

    parts.sort((a, b) => a.index - b.index);
    if (onProgress) onProgress(total, total, 'done');
    return Buffer.concat(parts.map((p) => p.dec));
  }

  const total = chunks.length;
  const { createAdaptivePool, mapAdaptive } = require('./adaptive-concurrency');
  const rateLimit = require('./github-rate-limit');
  const user = getUser(userId);
  const tokenKey = user?.access_token ? rateLimit.keyForToken(user.access_token) : null;
  const recommended = tokenKey ? rateLimit.getRecommendedConcurrency(tokenKey, 16) : 16;
  const pool = createAdaptivePool(chunks.length, {
    max: 32,
    initial: recommended,
    getMax: tokenKey ? () => rateLimit.getRecommendedConcurrency(tokenKey, 16) : null,
  });
  let fetched = 0;

  const buffers = await mapAdaptive(chunks, pool, async (chunk) => {
    const data = await accounts.downloadChunkForView(userId, chunk, view);
    pool.recordBytes(data.length);
    fetched += 1;
    if (onProgress) onProgress(fetched, total, 'fetching');
    return { index: chunk.chunk_index, data };
  });

  buffers.sort((a, b) => a.index - b.index);
  const ordered = buffers.map((b) => b.data);

  if (onProgress) onProgress(total, total, 'decrypting');

  const encrypted = Buffer.concat(ordered);
  const encryptionMeta = await resolveEncryptionMeta(userId, file);
  const masterKey = crypto.getMasterKey(user);
  const fileKey = crypto.deserializeEncryption(encryptionMeta, masterKey);
  const plaintext = crypto.decryptBuffer(encrypted, fileKey, encryptionMeta.iv, encryptionMeta.auth_tag);

  if (onProgress) onProgress(total, total, 'done');
  return plaintext;
}

function isChunkMode(file, chunks) {
  return !!(chunks[0] && chunks[0].chunk_iv && chunks[0].chunk_tag);
}

async function resolveEncryptionMeta(userId, file) {
  let encryptionMeta = file.encryption_meta ? JSON.parse(file.encryption_meta) : null;
  if (!encryptionMeta) {
    const manifest = await metadata.getFileManifest(userId, file.id);
    if (manifest?.encryption) encryptionMeta = manifest.encryption;
  }
  if (!encryptionMeta) throw new Error('Missing encryption metadata for file');
  return encryptionMeta;
}

async function getFileKeyFromMeta(userId, file) {
  const encryptionMeta = await resolveEncryptionMeta(userId, file);
  const masterKey = crypto.getMasterKey(getUser(userId));
  return crypto.deserializeEncryption(encryptionMeta, masterKey);
}

async function maybeRecordFileHistory(userId, fileId, opts = {}) {
  try {
    const fileHistory = require('./file-history');
    if (!fileHistory.isEnabled()) return;
    await fileHistory.recordVersion(userId, fileId, opts);
  } catch (err) {
    const logger = require('../lib/logger');
    logger.warn('file_history_record_failed', { userId, fileId, error: err.message });
  }
}

async function downloadFileVersion(userId, fileId, versionId, onProgress = null) {
  const fileHistory = require('./file-history');
  const row = fileHistory.getVersion(userId, fileId, versionId);
  const snapshot = JSON.parse(row.manifest_json);
  if (!fileHistory.snapshotIsDownloadable(snapshot)) {
    throw new Error('This version cannot be downloaded — encryption metadata was not stored for this snapshot');
  }
  if (!snapshot.chunks?.length) throw new Error('Version has no chunks');

  const fauxFile = {
    id: fileId,
    encryption_meta: JSON.stringify(snapshot.encryption),
    size: snapshot.size,
    mime_type: snapshot.mime_type,
    name: snapshot.name,
  };
  const fileKey = await getFileKeyFromMeta(userId, fauxFile);
  const sorted = snapshot.chunks.slice().sort((a, b) => a.chunk_index - b.chunk_index);
  const parts = [];

  for (let i = 0; i < sorted.length; i++) {
    const chunk = sorted[i];
    const repo = db.prepare('SELECT * FROM storage_repos WHERE id = ?').get(chunk.repo_id);
    if (!repo) throw new Error(`Storage repo missing for chunk ${chunk.chunk_index}`);
    const fullName = chunk.full_name || repo.full_name;
    const [owner, name] = fullName.split('/');
    const octokit = accounts.createClientForUpload(userId, repo);
    const enc = await github.downloadBlobBySha(octokit, owner, name, chunk.sha, { subsystem: 'download' });
    const dec = crypto.decryptChunk(enc, fileKey, chunk.chunk_iv, chunk.chunk_tag);
    parts.push(dec);
    if (onProgress) onProgress(i + 1, sorted.length);
  }

  return {
    buffer: Buffer.concat(parts),
    file: {
      id: fileId,
      name: snapshot.name,
      mime_type: snapshot.mime_type || 'application/octet-stream',
      size: snapshot.size,
    },
    versionNum: row.version_num,
  };
}

async function restoreFileVersion(userId, fileId, versionId) {
  const fileHistory = require('./file-history');
  const row = fileHistory.getVersion(userId, fileId, versionId);
  const snapshot = JSON.parse(row.manifest_json);
  if (!fileHistory.snapshotIsDownloadable(snapshot)) {
    throw new Error('Cannot restore this version — missing encryption metadata');
  }

  const file = db.prepare(
    "SELECT * FROM files WHERE id = ? AND user_id = ? AND is_folder = 0 AND is_deleted = 0",
  ).get(fileId, userId);
  if (!file) throw new Error('File not found');
  if (file.upload_status && file.upload_status !== 'ready') {
    throw new Error('Cannot restore while an upload is in progress');
  }

  const sorted = snapshot.chunks.slice().sort((a, b) => a.chunk_index - b.chunk_index);
  if (!sorted.length) throw new Error('Version has no chunks');

  const currentChunks = db.prepare('SELECT * FROM chunks WHERE file_id = ? ORDER BY chunk_index').all(fileId);
  const currentFp = currentChunks.length
    ? fileHistory.contentFingerprint(currentChunks, file.size)
    : null;
  if (currentFp && currentFp === row.content_fingerprint) {
    return { fileId, restoredFromVersion: row.version_num, size: snapshot.size, unchanged: true };
  }

  await fileHistory.recordVersionBeforeReplace(userId, fileId, {
    source: 'restore',
    note: `Before restoring version ${row.version_num}`,
  });

  await clearFileChunksForReplace(userId, fileId);

  const insertChunk = db.prepare(`
    INSERT INTO chunks (file_id, chunk_index, repo_id, repo_path, sha, size, chunk_iv, chunk_tag, plain_size)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateRepo = db.prepare(
    'UPDATE storage_repos SET chunk_count = chunk_count + 1, total_bytes = total_bytes + ? WHERE id = ?',
  );

  for (const chunk of sorted) {
    let repoId = chunk.repo_id;
    let repo = repoId ? db.prepare('SELECT * FROM storage_repos WHERE id = ?').get(repoId) : null;
    if (!repo && chunk.full_name) {
      repo = db.prepare(
        'SELECT * FROM storage_repos WHERE user_id = ? AND full_name = ? LIMIT 1',
      ).get(userId, chunk.full_name);
      repoId = repo?.id;
    }
    if (!repo || !repoId) {
      throw new Error(`Storage repo "${chunk.full_name || 'unknown'}" is no longer available`);
    }

    insertChunk.run(
      fileId,
      chunk.chunk_index,
      repoId,
      chunk.repo_path,
      chunk.sha,
      chunk.size,
      chunk.chunk_iv,
      chunk.chunk_tag,
      chunk.plain_size ?? chunk.size,
    );
    updateRepo.run(chunk.size, repoId);
  }

  db.prepare(`
    UPDATE files SET size = ?, mime_type = ?, chunk_count = ?, encryption_meta = ?,
      upload_status = 'ready', has_hls = 0, hls_playlist_path = NULL,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    snapshot.size,
    snapshot.mime_type || file.mime_type,
    sorted.length,
    JSON.stringify(snapshot.encryption),
    fileId,
  );

  db.prepare('DELETE FROM hls_segments WHERE file_id = ?').run(fileId);

  const updated = db.prepare('SELECT * FROM files WHERE id = ?').get(fileId);
  const chunkRecords = sorted.map((c) => ({
    chunk_index: c.chunk_index,
    full_name: c.full_name,
    repo_path: c.repo_path,
    sha: c.sha,
    size: c.size,
    plain_size: c.plain_size,
    chunk_iv: c.chunk_iv,
    chunk_tag: c.chunk_tag,
  }));

  let manifestSha = null;
  if (metadata.getMetadataRepo(userId)) {
    manifestSha = await metadata.saveFileManifest(
      userId,
      {
        id: updated.id,
        name: updated.name,
        path: updated.path,
        parent_path: updated.parent_path,
        size: updated.size,
        mime_type: updated.mime_type,
        chunk_count: updated.chunk_count,
        is_folder: 0,
        created_at: updated.created_at,
      },
      chunkRecords,
      snapshot.encryption,
      !!updated.has_thumbnail,
    );
  }

  await maybeRecordFileHistory(userId, fileId, {
    source: 'restore',
    manifestSha,
    note: `Restored from version ${row.version_num}`,
  });

  require('./cache').remove(userId, fileId);
  touchFile(fileId);
  notifyPlaylistFolderSync(userId, [fileId]);

  return {
    fileId,
    restoredFromVersion: row.version_num,
    size: snapshot.size,
    name: updated.name,
  };
}

function previewByteLimit(file) {
  return thumbnails.previewByteLimit(file.mime_type, file.name, file.size);
}

const LEGACY_FULL_DECRYPT_LIMIT = 30 * 1024 * 1024;

async function fetchPreviewForThumbnail(userId, file) {
  const chunks = db.prepare(`
    SELECT c.*, r.full_name, r.default_branch
    FROM chunks c JOIN storage_repos r ON c.repo_id = r.id
    WHERE c.file_id = ? ORDER BY c.chunk_index
  `).all(file.id);

  if (!chunks.length) throw new Error('No file chunks found on GitHub');

  const maxBytes = previewByteLimit(file);

  if (!isChunkMode(file, chunks)) {
    if (file.size > LEGACY_FULL_DECRYPT_LIMIT) return null;
    const full = await fetchAndDecrypt(userId, file, chunks, null);
    return full.subarray(0, maxBytes);
  }

  const fileKey = await getFileKeyFromMeta(userId, file);
  const parts = [];
  let total = 0;

  for (const chunk of chunks) {
    if (total >= maxBytes) break;
    if (!chunk.chunk_iv || !chunk.chunk_tag) {
      throw new Error('Missing chunk encryption data');
    }
    const enc = await accounts.downloadChunkWithFallback(userId, chunk);
    if (!enc?.length) throw new Error(`Chunk ${chunk.chunk_index} not found on GitHub`);
    const dec = crypto.decryptChunk(enc, fileKey, chunk.chunk_iv, chunk.chunk_tag);
    parts.push(dec);
    total += dec.length;
  }

  if (!parts.length) throw new Error('Could not download file data for thumbnail');
  return Buffer.concat(parts).subarray(0, maxBytes);
}

async function refreshThumbnail(userId, fileId) {
  const file = db.prepare(
    'SELECT * FROM files WHERE id = ? AND user_id = ? AND is_folder = 0'
  ).get(fileId, userId);
  if (!file) throw new Error('File not found');
  if (file.upload_status && file.upload_status !== 'ready') {
    throw new Error('Cannot refresh thumbnail while upload is in progress');
  }
  if (!metadata.getMetadataRepo(userId)) {
    throw new Error('Metadata repository not configured');
  }

  let thumbBuffer = await thumbnails.generateFromLookup(file.mime_type, file.name);

  if (!thumbBuffer) {
    try {
      const preview = await fetchPreviewForThumbnail(userId, file);
      if (preview?.length) {
        thumbBuffer = await thumbnails.generate(preview, file.mime_type, file.name);
      }
    } catch (err) {
      if (!thumbBuffer) throw err;
    }
  }

  if (!thumbBuffer) {
    throw new Error('Could not find or generate a thumbnail for this file');
  }

  return commitThumbnail(userId, file, fileId, thumbBuffer);
}

async function commitThumbnail(userId, file, fileId, thumbBuffer) {
  await metadata.saveThumbnail(userId, fileId, thumbBuffer, file.name);
  db.prepare('UPDATE files SET has_thumbnail = 1 WHERE id = ?').run(fileId);

  const chunks = db.prepare(`
    SELECT c.*, r.full_name FROM chunks c
    JOIN storage_repos r ON c.repo_id = r.id
    WHERE c.file_id = ? ORDER BY c.chunk_index
  `).all(fileId);

  const encryptionMeta = await resolveEncryptionMeta(userId, file);
  const fileRecord = {
    id: file.id,
    name: file.name,
    path: file.path,
    parent_path: file.parent_path,
    size: file.size,
    mime_type: file.mime_type,
    chunk_count: file.chunk_count,
    is_folder: 0,
    created_at: file.created_at,
  };
  const chunkRecords = chunks.map((chunk) => ({
    chunk_index: chunk.chunk_index,
    full_name: chunk.full_name,
    repo_path: chunk.repo_path,
    sha: chunk.sha,
    size: chunk.size,
    plain_size: chunk.plain_size,
  }));

  await metadata.saveFileManifest(userId, fileRecord, chunkRecords, encryptionMeta, true);

  return { id: fileId, has_thumbnail: true };
}

async function setCustomThumbnail(userId, fileId, imageBuffer) {
  const file = db.prepare(
    'SELECT * FROM files WHERE id = ? AND user_id = ? AND is_folder = 0'
  ).get(fileId, userId);
  if (!file) throw new Error('File not found');
  if (file.upload_status && file.upload_status !== 'ready') {
    throw new Error('Cannot set thumbnail while upload is in progress');
  }
  if (!metadata.getMetadataRepo(userId)) {
    throw new Error('Metadata repository not configured');
  }
  if (!imageBuffer?.length) throw new Error('No image provided');

  const thumbBuffer = await thumbnails.toThumbJpeg(imageBuffer);
  if (!thumbBuffer) throw new Error('Invalid or unsupported image file');

  return commitThumbnail(userId, file, fileId, thumbBuffer);
}

async function downloadFileWithProgress(userId, fileId, onProgress, view = null) {
  const user = getUser(userId);
  if (!user) throw new Error('User not found');

  const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(fileId, userId);
  if (!file || file.is_folder) throw new Error('File not found');

  const cache = require('./cache');
  const useCache = !view || view.type === 'primary';
  if (useCache) {
    const cached = cache.get(userId, fileId);
    if (cached) {
      if (onProgress) onProgress(1, 1, 'cached');
      return { buffer: fs.readFileSync(cached.path), file };
    }
  }

  const chunks = db.prepare(
    'SELECT c.*, r.full_name, r.default_branch FROM chunks c JOIN storage_repos r ON c.repo_id = r.id WHERE c.file_id = ? ORDER BY c.chunk_index'
  ).all(fileId);

  const buffer = await fetchAndDecrypt(userId, file, chunks, onProgress, view);
  if (useCache && buffer.length) {
    cache.put(userId, fileId, buffer, file);
  }
  return { buffer, file };
}

async function downloadFile(userId, fileId, view = null) {
  return downloadFileWithProgress(userId, fileId, null, view);
}

const NODE_BUFFER_MAX = 0x7fffffff;

async function downloadFileToPath(userId, fileId, outPath, onProgress = null, view = null) {
  const user = getUser(userId);
  if (!user) throw new Error('User not found');

  const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(fileId, userId);
  if (!file || file.is_folder) throw new Error('File not found');

  const cacheMod = require('./cache');
  const useCache = !view || view.type === 'primary';
  if (useCache) {
    const cached = cacheMod.get(userId, fileId);
    if (cached?.path && fs.existsSync(cached.path)) {
      if (onProgress) onProgress(1, 1, 'cached');
      fs.copyFileSync(cached.path, outPath);
      return file;
    }
  }

  const chunks = db.prepare(
    'SELECT c.*, r.full_name, r.default_branch FROM chunks c JOIN storage_repos r ON c.repo_id = r.id WHERE c.file_id = ? ORDER BY c.chunk_index'
  ).all(fileId);
  if (!chunks.length) throw new Error('No file chunks found');

  if (isChunkMode(file, chunks)) {
    const fileKey = await getFileKeyFromMeta(userId, file);
    const total = chunks.length;
    const fd = fs.openSync(outPath, 'w');
    try {
      let offset = 0;
      const offsets = chunks.map((chunk) => {
        const pos = offset;
        offset += chunk.plain_size || chunk.size || 0;
        return pos;
      });
      if (file.size > 0) {
        try { fs.truncateSync(fd, file.size); } catch {}
      }
      const { mapConcurrent } = require('./chunk-session');
      const progress = { done: 0 };
      const concurrency = Math.min(16, Math.max(4, Math.ceil(total / 8)));
      await mapConcurrent(chunks, concurrency, async (chunk, i) => {
        const enc = await accounts.downloadChunkForView(userId, chunk, view);
        const dec = crypto.decryptChunk(enc, fileKey, chunk.chunk_iv, chunk.chunk_tag);
        fs.writeSync(fd, dec, 0, dec.length, offsets[i]);
        progress.done += 1;
        if (onProgress) onProgress(progress.done, total, 'fetching');
      });
    } finally {
      fs.closeSync(fd);
    }
    if (onProgress) onProgress(total, total, 'done');
    return file;
  }

  if (file.size > NODE_BUFFER_MAX) {
    throw new Error(
      'File exceeds 2 GB in-memory limit for whole-file encryption. '
      + 'Re-upload with chunked encryption to enable HLS conversion.'
    );
  }

  const buffer = await fetchAndDecrypt(userId, file, chunks, onProgress, view);
  fs.writeFileSync(outPath, buffer);
  if (useCache && buffer.length) cacheMod.put(userId, fileId, buffer, file);
  return file;
}

function getFileDetails(userId, fileId, req = null) {
  const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(fileId, userId);
  if (!file) throw new Error('File not found');

  const chunks = db.prepare(`
    SELECT c.chunk_index, c.repo_path, c.sha, c.size, c.plain_size, c.chunk_iv,
           r.full_name, r.name as repo_name, r.owner, r.is_metadata
    FROM chunks c JOIN storage_repos r ON c.repo_id = r.id
    WHERE c.file_id = ? ORDER BY c.chunk_index
  `).all(fileId);

  const reposUsed = {};
  for (const c of chunks) {
    reposUsed[c.full_name] = (reposUsed[c.full_name] || 0) + 1;
  }

  const hlsSegmentCount = db.prepare(
    'SELECT COUNT(*) as n FROM hls_segments WHERE file_id = ?'
  ).get(fileId)?.n || 0;
  const hlsDurationSec = db.prepare(
    'SELECT COALESCE(SUM(duration), 0) as s FROM hls_segments WHERE file_id = ?'
  ).get(fileId)?.s || 0;
  const hlsMinSegments = require('./capacity').estimateMinHlsSegmentCount(file.size);

  return {
    file: {
      id: file.id,
      name: file.name,
      path: file.path,
      parent_path: file.parent_path,
      size: file.size,
      mime_type: file.mime_type,
      is_folder: !!file.is_folder,
      chunk_count: file.chunk_count,
      has_thumbnail: !!file.has_thumbnail,
      has_hls: !!file.has_hls,
      hls_playlist_path: file.hls_playlist_path || null,
      encryption_mode: file.encryption_mode || 'whole',
      share_token: file.share_token,
      created_at: file.created_at,
      hls_segment_count: hlsSegmentCount,
      hls_duration_sec: Number(hlsDurationSec) || 0,
      hls_min_segments: hlsMinSegments,
    },
    chunks: chunks.map(c => ({
      index: c.chunk_index,
      repo: c.full_name,
      path: c.repo_path,
      sha: c.sha,
      encrypted_size: c.size,
      plain_size: c.plain_size || c.size,
      has_chunk_key: !!c.chunk_iv,
    })),
    repos_used: reposUsed,
    share_url: file.share_token ? appUrl.publicUrl(req, `/share/${file.share_token}`) : null,
  };
}

function createShareToken(userId, fileId, req = null) {
  const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(fileId, userId);
  if (!file) throw new Error('Item not found');

  let token = file.share_token;
  if (!token) {
    token = uuidv4().replace(/-/g, '');
    db.prepare('UPDATE files SET share_token = ? WHERE id = ?').run(token, fileId);
  }

  ensureShareKeyMeta(userId, fileId, token);

  return { token, url: appUrl.publicUrl(req, `/share/${token}`), is_folder: !!file.is_folder };
}

async function ensureShareKeyMeta(userId, fileId, shareToken) {
  const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(fileId, userId);
  if (!file) throw new Error('Item not found');

  const store = parseShareKeyMetaStore(file.share_key_meta);
  if (store[shareToken]?.wrapped_key) {
    return store[shareToken];
  }

  if (store.__legacy__ && file.share_token) {
    store[file.share_token] = { ...store.__legacy__, wrap_token: file.share_token };
    delete store.__legacy__;
    if (store[shareToken]?.wrapped_key) {
      db.prepare('UPDATE files SET share_key_meta = ? WHERE id = ?').run(JSON.stringify(store), fileId);
      return store[shareToken];
    }
  }

  const fileKey = await getFileKeyFromMeta(userId, file);
  const shareMeta = crypto.wrapKeyForShare(fileKey, shareToken);
  shareMeta.wrap_token = shareToken;
  store[shareToken] = shareMeta;
  delete store.__legacy__;
  db.prepare('UPDATE files SET share_key_meta = ? WHERE id = ?').run(JSON.stringify(store), fileId);
  return shareMeta;
}

function parseShareKeyMetaStore(raw) {
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};
  if (parsed.wrapped_key) {
    const token = parsed.wrap_token || null;
    if (token) return { [token]: parsed };
    return { __legacy__: parsed };
  }
  return parsed;
}

function revokeShareToken(userId, fileId) {
  db.prepare('UPDATE files SET share_token = NULL, share_key_meta = NULL WHERE id = ? AND user_id = ?').run(fileId, userId);
}

function getShareClientStreamEnabled(userId) {
  const user = db.prepare('SELECT share_client_stream FROM users WHERE id = ?').get(userId);
  if (!user) return false;
  if (user.share_client_stream == null) return true;
  return !!user.share_client_stream;
}

function setShareClientStreamEnabled(userId, enabled) {
  db.prepare('UPDATE users SET share_client_stream = ? WHERE id = ?').run(enabled ? 1 : 0, userId);
  return { client_stream: !!enabled };
}

function githubRawUrl(fullName, branch, repoPath) {
  const [owner, repo] = fullName.split('/');
  const path = String(repoPath || '').split('/').map(encodeURIComponent).join('/');
  return `https://raw.githubusercontent.com/${owner}/${repo}/${branch || 'main'}/${path}`;
}

async function buildShareManifestForFile(file, token) {
  const owner = db.prepare('SELECT id, share_client_stream FROM users WHERE id = ?').get(file.user_id);
  const clientStream = owner ? getShareClientStreamEnabled(owner.id) : false;

  const shareMeta = await ensureShareKeyMeta(file.user_id, file.id, token);

  const chunks = db.prepare(`
    SELECT c.chunk_index, c.plain_size, c.size, c.chunk_iv, c.chunk_tag,
           c.repo_path, r.full_name, r.default_branch, r.is_public
    FROM chunks c JOIN storage_repos r ON c.repo_id = r.id
    WHERE c.file_id = ? ORDER BY c.chunk_index
  `).all(file.id);

  const reposInFile = [...new Set(chunks.map((c) => c.full_name))];
  const publicRepos = new Set(chunks.filter((c) => c.is_public === 1).map((c) => c.full_name));
  const allReposPublic = reposInFile.length > 0 && reposInFile.every((name) => publicRepos.has(name));

  const hlsAvailable = !!(file.has_hls && file.hls_playlist_repo_id && file.hls_playlist_path);
  let hlsPlaylistUrl = null;
  let hlsSegmentCount = 0;
  if (hlsAvailable) {
    const playlistRepo = db.prepare('SELECT * FROM storage_repos WHERE id = ?').get(file.hls_playlist_repo_id);
    if (playlistRepo) {
      hlsPlaylistUrl = githubRawUrl(playlistRepo.full_name, playlistRepo.default_branch, file.hls_playlist_path);
    }
    const segCount = db.prepare('SELECT COUNT(*) as n FROM hls_segments WHERE file_id = ?').get(file.id);
    hlsSegmentCount = segCount?.n || 0;
  }

  return {
    id: file.id,
    name: file.name,
    size: file.size,
    mime_type: file.mime_type,
    chunk_count: file.chunk_count || chunks.length,
    encryption_mode: file.encryption_mode || 'chunk',
    chunk_mode: isChunkMode(file, chunks),
    client_stream: clientStream,
    share_key: shareMeta,
    offline_capable: true,
    direct_fetch: clientStream,
    all_repos_public: allReposPublic,
    hls_available: !!hlsPlaylistUrl,
    hls_playlist_url: hlsPlaylistUrl,
    hls_segment_count: hlsSegmentCount,
    chunks: chunks.map((c) => ({
      index: c.chunk_index,
      plain_size: c.plain_size || c.size,
      encrypted_size: c.size,
      iv: c.chunk_iv,
      tag: c.chunk_tag,
      repo: c.full_name,
      repo_path: c.repo_path,
      raw_url: githubRawUrl(c.full_name, c.default_branch, c.repo_path),
    })),
  };
}

async function getShareManifest(token, fileId = null) {
  const file = resolveSharedFile(token, fileId);
  if (!file) throw new Error('Share not found');
  return buildShareManifestForFile(file, token);
}

async function getPlaylistManifest(playlistToken, fileId) {
  const playlists = require('./playlists');
  const file = playlists.resolvePlaylistFile(playlistToken, fileId);
  if (!file) throw new Error('Share not found');
  return buildShareManifestForFile(file, playlistToken);
}

async function getShareEncryptedChunk(token, fileId, chunkIndex) {
  const file = resolveSharedFile(token, fileId);
  if (!file) throw new Error('Share not found');

  const owner = db.prepare('SELECT share_client_stream FROM users WHERE id = ?').get(file.user_id);
  if (!getShareClientStreamEnabled(file.user_id)) {
    throw new Error('Client-side streaming is disabled for this share');
  }

  const chunk = db.prepare(`
    SELECT c.*, r.full_name, r.default_branch
    FROM chunks c JOIN storage_repos r ON c.repo_id = r.id
    WHERE c.file_id = ? AND c.chunk_index = ?
  `).get(file.id, chunkIndex);

  if (!chunk) throw new Error('Chunk not found');

  const enc = await accounts.downloadChunkWithFallback(file.user_id, chunk);
  return { buffer: enc, chunk };
}

async function getPlaylistEncryptedChunk(playlistToken, fileId, chunkIndex) {
  const playlists = require('./playlists');
  const file = playlists.resolvePlaylistFile(playlistToken, fileId);
  if (!file) throw new Error('Share not found');

  if (!getShareClientStreamEnabled(file.user_id)) {
    throw new Error('Client-side streaming is disabled for this share');
  }

  const chunk = db.prepare(`
    SELECT c.*, r.full_name, r.default_branch
    FROM chunks c JOIN storage_repos r ON c.repo_id = r.id
    WHERE c.file_id = ? AND c.chunk_index = ?
  `).get(file.id, chunkIndex);

  if (!chunk) throw new Error('Chunk not found');

  const enc = await accounts.downloadChunkWithFallback(file.user_id, chunk);
  return { buffer: enc, chunk };
}

function getSharedByToken(token) {
  return db.prepare('SELECT * FROM files WHERE share_token = ?').get(token);
}

function getFileByShareToken(token) {
  return db.prepare('SELECT * FROM files WHERE share_token = ? AND is_folder = 0').get(token);
}

function isPathWithinSharedFolder(folderPath, targetPath) {
  return targetPath === folderPath || targetPath.startsWith(`${folderPath}/`);
}

function resolveSharedFile(token, fileId = null) {
  const shared = getSharedByToken(token);
  if (!shared) return null;

  if (!shared.is_folder) {
    if (fileId && fileId !== shared.id) return null;
    return shared;
  }

  if (!fileId) return null;

  const file = db.prepare(
    'SELECT * FROM files WHERE id = ? AND user_id = ? AND is_folder = 0'
  ).get(fileId, shared.user_id);
  if (!file || !isPathWithinSharedFolder(shared.path, file.path)) return null;
  return file;
}

function listSharedFolder(token, subPath = null) {
  const shared = getSharedByToken(token);
  if (!shared?.is_folder) return null;

  const parentPath = subPath || shared.path;
  if (!isPathWithinSharedFolder(shared.path, parentPath)) return null;

  const files = db.prepare(`
    SELECT id, name, path, size, mime_type, is_folder, parent_path, chunk_count, has_thumbnail, created_at
    FROM files
    WHERE user_id = ? AND parent_path = ?
      AND (upload_status IS NULL OR upload_status = 'ready')
      AND is_deleted = 0
    ORDER BY is_folder DESC, name ASC
  `).all(shared.user_id, parentPath);

  return {
    name: shared.name,
    path: parentPath,
    root_path: shared.path,
    files: files.map((f) => ({
      id: f.id,
      name: f.name,
      path: f.path,
      size: f.size,
      mime_type: f.mime_type,
      is_folder: !!f.is_folder,
      chunk_count: f.chunk_count,
      has_thumbnail: !!f.has_thumbnail,
      has_hls: !!f.has_hls,
      hls_segment_count: f.has_hls ? getHlsSegmentCount(f.id) : 0,
    })),
  };
}

async function shareThumbnailAvailable(file) {
  if (!file) return false;
  if (file.has_thumbnail) return true;

  const thumbCache = require('./thumb-cache');
  if (thumbCache.has(file.user_id, file.id)) return true;

  const manifest = await metadata.getFileManifest(file.user_id, file.id);
  if (manifest?.thumbnail) return true;

  return thumbnails.isAudio(file.mime_type, file.name)
    || thumbnails.isVideo(file.mime_type, file.name);
}

async function getShareThumbnail(file) {
  if (!file) return null;

  const thumbCache = require('./thumb-cache');
  const cached = thumbCache.get(file.user_id, file.id);
  if (cached) return cached;

  if (file.has_thumbnail) {
    const thumb = await metadata.getThumbnail(file.user_id, file.id);
    if (thumb) return thumb;
  }

  const manifest = await metadata.getFileManifest(file.user_id, file.id);
  if (manifest?.thumbnail) {
    const thumb = await metadata.getThumbnail(file.user_id, file.id);
    if (thumb) return thumb;
  }

  if (!metadata.getMetadataRepo(file.user_id)) return null;

  if (thumbnails.isAudio(file.mime_type, file.name)
    || thumbnails.isVideo(file.mime_type, file.name)) {
    try {
      let thumbBuffer = await thumbnails.generateFromLookup(file.mime_type, file.name);
      if (!thumbBuffer) {
        const preview = await fetchPreviewForThumbnail(file.user_id, file);
        if (preview?.length) {
          thumbBuffer = await thumbnails.generate(preview, file.mime_type, file.name);
        }
      }
      if (thumbBuffer) {
        await metadata.saveThumbnail(file.user_id, file.id, thumbBuffer, file.name);
        db.prepare('UPDATE files SET has_thumbnail = 1 WHERE id = ?').run(file.id);
        return thumbBuffer;
      }
    } catch {
      // on-demand thumbnail generation failed
    }
  }

  return null;
}

async function deleteFile(userId, fileId) {
  const user = getUser(userId);
  if (!user) throw new Error('User not found');

  const file = db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(fileId, userId);
  if (!file) throw new Error('File not found');

  if (!file.is_folder) {
    await cleanupSiblingStaleUploadSessions(userId, file);
  }

  capacity.releaseHlsReserve(userId, fileId);

  if (file.is_folder) {
    const children = db.prepare(
      'SELECT * FROM files WHERE user_id = ? AND parent_path = ?'
    ).all(userId, file.path);
    for (const child of children) {
      await deleteFile(userId, child.id);
    }
    db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
    await metadata.deleteFileMetadata(userId, fileId);
    return;
  }

  const chunks = db.prepare(`
    SELECT c.*, r.full_name, r.default_branch, r.linked_account_id, r.id as storage_repo_id
    FROM chunks c JOIN storage_repos r ON c.repo_id = r.id WHERE c.file_id = ?
  `).all(fileId);

  const updateRepo = db.prepare(
    'UPDATE storage_repos SET chunk_count = chunk_count - 1, total_bytes = total_bytes - ? WHERE id = ?'
  );

  for (const chunk of chunks) {
    const primaryRepo = db.prepare('SELECT * FROM storage_repos WHERE id = ?').get(chunk.repo_id);
    if (chunk.sha && primaryRepo) {
      const octokit = accounts.createClientForRepo(userId, primaryRepo);
      const [owner, repoName] = chunk.full_name.split('/');
      try {
        await withTimeout(
          github.deleteChunk(octokit, owner, repoName, chunk.repo_path, chunk.sha, chunk.default_branch),
          15000, `delete chunk ${chunk.repo_path}`
        );
      } catch { /* gone or timeout - DB cleanup happens below */ }
    }
    updateRepo.run(chunk.size, chunk.repo_id);

    const backups = db.prepare(`
      SELECT cb.*, r.* FROM chunk_backups cb
      JOIN storage_repos r ON cb.repo_id = r.id WHERE cb.chunk_id = ?
    `).all(chunk.id);
    for (const backup of backups) {
      if (backup.sha) {
        const octokit = accounts.createClientForRepo(userId, backup);
        const [owner, repoName] = backup.full_name.split('/');
        try {
          await withTimeout(
            github.deleteChunk(octokit, owner, repoName, chunk.repo_path, backup.sha, backup.default_branch),
            15000, `delete backup ${chunk.repo_path}`
          );
        } catch { /* gone or timeout */ }
      }
      updateRepo.run(chunk.size, backup.repo_id);
      db.prepare('DELETE FROM chunk_backups WHERE id = ?').run(backup.id);
    }
  }

  db.prepare(`
    DELETE FROM chunk_sync_failures
    WHERE chunk_id IN (SELECT id FROM chunks WHERE file_id = ?)
  `).run(fileId);
  db.prepare('DELETE FROM chunk_backups WHERE chunk_id IN (SELECT id FROM chunks WHERE file_id = ?)').run(fileId);
  db.prepare('DELETE FROM chunks WHERE file_id = ?').run(fileId);
  db.prepare('DELETE FROM hls_segments WHERE file_id = ?').run(fileId);
  db.prepare('DELETE FROM playlist_items WHERE file_id = ?').run(fileId);
  invalidateUploadTasksForFile(userId, fileId);
  db.prepare('DELETE FROM files WHERE id = ?').run(fileId);
  await metadata.deleteFileMetadata(userId, fileId);
  require('./cache').remove(userId, fileId);
}

function getHlsSegmentCount(fileId) {
  const row = db.prepare('SELECT COUNT(*) as n FROM hls_segments WHERE file_id = ?').get(fileId);
  return row?.n || 0;
}

function listFiles(userId, parentPath, view = null, opts = {}) {
  const { getFileChunkStats, folderVisibleInView } = require('./view-mode');
  const normalized = parentPath === '' ? '/' : parentPath;
  const sortCols = {
    name: 'name', size: 'size', date: 'created_at', type: 'mime_type',
    modified: 'updated_at', accessed: 'last_accessed', created: 'created_at',
  };
  const sortCol = sortCols[opts.sort] || 'name';
  const sortDir = opts.order === 'DESC' ? 'DESC' : 'ASC';
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 0, 0), 500);
  const offset = Math.max(parseInt(opts.offset, 10) || 0, 0);
  const rows = db.prepare(`
    SELECT id, name, path, size, mime_type, is_folder, parent_path, chunk_count, has_thumbnail, has_hls, created_at,
      (SELECT COUNT(*) FROM hls_segments WHERE file_id = files.id) AS hls_segment_count,
      (SELECT COALESCE(SUM(duration), 0) FROM hls_segments WHERE file_id = files.id) AS hls_duration_sec
    FROM files
    WHERE user_id = ? AND parent_path = ?
      AND (upload_status IS NULL OR upload_status = 'ready')
      AND is_deleted = 0
    ORDER BY is_folder DESC, ${sortCol} ${sortDir}
  `).all(userId, normalized);

  // Apply search and type filters in memory (additional DB filter for search if needed)
  let filtered = rows;
  if (opts.search) {
    const term = opts.search.toLowerCase();
    filtered = rows.filter((f) => f.name.toLowerCase().includes(term));
  }
  if (opts.type) {
    if (opts.type === 'video') filtered = filtered.filter((f) => /^video\//.test(f.mime_type) || /\.(mp4|webm|mkv|avi|mov|m4v|ogv)$/i.test(f.name));
    else if (opts.type === 'audio') filtered = filtered.filter((f) => /^audio\//.test(f.mime_type) || /\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(f.name));
    else if (opts.type === 'image') filtered = filtered.filter((f) => /^image\//.test(f.mime_type) || /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i.test(f.name));
    else if (opts.type === 'document') filtered = filtered.filter((f) => /\.(pdf|doc|docx|txt|md|json|csv|xml|xls|xlsx|ppt|pptx|rtf)$/i.test(f.name) || /^text\//.test(f.mime_type) || f.mime_type === 'application/pdf');
    else if (opts.type === 'archive') filtered = filtered.filter((f) => /\.(zip|rar|7z|tar|gz|bz2|xz|tgz)$/i.test(f.name) || /zip|archive|compressed/i.test(f.mime_type || ''));
    else if (opts.type === 'code') filtered = filtered.filter((f) => /\.(js|ts|jsx|tsx|py|rb|go|rs|java|c|cpp|h|cs|php|swift|kt|sql|sh|yaml|yml|toml|html|css|scss|vue|svelte)$/i.test(f.name));
    else if (opts.type === 'folder') filtered = filtered.filter((f) => f.is_folder);
    else if (opts.type === 'file') filtered = filtered.filter((f) => !f.is_folder);
  }

  const total = filtered.length;
  const page = limit > 0 ? filtered.slice(offset, offset + limit) : filtered;

  if (!view || view.type === 'primary') {
    const files = page.map((file) => ({
      ...file,
      view_status: file.is_folder ? 'folder' : 'synced',
      view_chunks_available: file.chunk_count,
      view_chunks_total: file.chunk_count,
      hls_segment_count: file.hls_segment_count || 0,
      hls_duration_sec: Number(file.hls_duration_sec) || 0,
    }));
    metadata.warmThumbnailsBackground(userId, files);
    return {
      files,
      total,
      hasMore: limit > 0 && offset + limit < total,
      nextOffset: limit > 0 ? offset + limit : total,
    };
  }

  const viewFiltered = filtered.filter((file) => {
    if (file.is_folder) {
      return folderVisibleInView(userId, file.path, view);
    }
    const stats = getFileChunkStats(userId, file.id, view);
    file.view_status = stats.status;
    file.view_chunks_available = stats.chunks_available;
    file.view_chunks_total = stats.chunks_total;
    return stats.chunks_available > 0;
  });
  const viewTotal = viewFiltered.length;
  const viewPage = limit > 0 ? viewFiltered.slice(offset, offset + limit) : viewFiltered;
  const files = viewPage.map((file) => {
    if (file.is_folder) {
      return { ...file, view_status: 'folder', view_chunks_available: 0, view_chunks_total: 0 };
    }
    const stats = getFileChunkStats(userId, file.id, view);
    return {
      ...file,
      view_status: stats.status,
      view_chunks_available: stats.chunks_available,
      view_chunks_total: stats.chunks_total,
      hls_segment_count: file.hls_segment_count || 0,
      hls_duration_sec: Number(file.hls_duration_sec) || 0,
    };
  });
  return {
    files,
    total: viewTotal,
    hasMore: limit > 0 && offset + limit < viewTotal,
    nextOffset: limit > 0 ? offset + limit : viewTotal,
  };
}

function searchFilesGlobal(userId, query, opts = {}) {
  const term = String(query || '').trim().toLowerCase();
  if (!term || term.length < 2) return { files: [], total: 0 };
  const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 100, 1), 200);
  const sortCols = { name: 'name', size: 'size', date: 'created_at', modified: 'updated_at', accessed: 'last_accessed' };
  const sortCol = sortCols[opts.sort] || 'name';
  const sortDir = opts.order === 'DESC' ? 'DESC' : 'ASC';

  const rows = db.prepare(`
    SELECT id, name, path, size, mime_type, is_folder, parent_path, chunk_count, has_thumbnail, created_at, last_accessed, is_favorite
    FROM files
    WHERE user_id = ? AND is_deleted = 0
      AND (upload_status IS NULL OR upload_status = 'ready')
      AND LOWER(name) LIKE ?
    ORDER BY is_folder DESC, ${sortCol} ${sortDir}
    LIMIT ?
  `).all(userId, `%${term}%`, limit);

  return { files: rows, total: rows.length };
}

function softTrashItems(userId, ids) {
  let moved = 0;
  const trashOne = db.prepare("UPDATE files SET is_deleted = 1, deleted_at = datetime('now'), updated_at = datetime('now') WHERE id = ? AND user_id = ? AND is_deleted = 0");
  const trashDesc = db.prepare(`
    UPDATE files SET is_deleted = 1, deleted_at = datetime('now'), updated_at = datetime('now')
    WHERE user_id = ? AND is_deleted = 0
      AND (parent_path = ? OR parent_path LIKE ? OR path LIKE ?)
  `);

  for (const id of ids) {
    const file = db.prepare('SELECT id, is_folder, path FROM files WHERE id = ? AND user_id = ?').get(id, userId);
    if (!file) continue;
    if (file.is_folder) {
      const childPrefix = file.path === '/' ? '/%' : `${file.path}/%`;
      trashOne.run(id, userId);
      const r = trashDesc.run(userId, file.path, childPrefix, childPrefix);
      moved += r.changes;
    } else {
      const r = trashOne.run(id, userId);
      if (r.changes) moved++;
    }
  }
  notifyPlaylistFolderSync(userId, ids);
  return moved;
}

function restoreItems(userId, ids) {
  let restored = 0;
  const restoreOne = db.prepare('UPDATE files SET is_deleted = 0, deleted_at = NULL, updated_at = datetime(\'now\') WHERE id = ? AND user_id = ?');
  const restoreDesc = db.prepare(`
    UPDATE files SET is_deleted = 0, deleted_at = NULL, updated_at = datetime('now')
    WHERE user_id = ? AND is_deleted = 1
      AND (parent_path = ? OR parent_path LIKE ? OR path LIKE ?)
  `);

  for (const id of ids) {
    const file = db.prepare('SELECT id, is_folder, path FROM files WHERE id = ? AND user_id = ?').get(id, userId);
    if (!file) continue;
    if (file.is_folder) {
      const childPrefix = file.path === '/' ? '/%' : `${file.path}/%`;
      restoreOne.run(id, userId);
      const r = restoreDesc.run(userId, file.path, childPrefix, childPrefix);
      restored += r.changes;
    } else {
      const r = restoreOne.run(id, userId);
      if (r.changes) restored++;
    }
  }
  notifyPlaylistFolderSync(userId, ids);
  return restored;
}

function joinFilePath(parentPath, name) {
  const parent = normalizeParentPath(parentPath);
  return parent === '/' ? `/${name}` : `${parent}/${name}`;
}

function parentPathFromFilePath(filePath) {
  const parts = filePath.split('/').filter(Boolean);
  if (parts.length <= 1) return '/';
  return `/${parts.slice(0, -1).join('/')}`;
}

function isDescendantOrSelf(ancestorPath, path) {
  return path === ancestorPath || path.startsWith(`${ancestorPath}/`);
}

function isTopLevelMove(item, items) {
  let parent = normalizeParentPath(item.parent_path);
  while (parent !== '/') {
    const parentFolder = items.find((entry) => entry.is_folder && entry.path === parent);
    if (parentFolder) return false;
    parent = parentPathFromFilePath(parent);
  }
  return true;
}

function updateDescendantPaths(userId, oldPrefix, newPrefix) {
  const descendants = db.prepare(
    'SELECT * FROM files WHERE user_id = ? AND path LIKE ?'
  ).all(userId, `${oldPrefix}/%`);

  for (const descendant of descendants) {
    const newPath = `${newPrefix}${descendant.path.slice(oldPrefix.length)}`;
    const newParent = parentPathFromFilePath(newPath);
    db.prepare("UPDATE files SET path = ?, parent_path = ?, updated_at = datetime('now') WHERE id = ?")
      .run(newPath, newParent, descendant.id);
  }
}

async function renameItem(userId, fileId, newName) {
  const trimmed = String(newName || '').trim();
  if (!trimmed) throw new Error('Name is required');
  if (/[\\/]/.test(trimmed)) throw new Error('Invalid name');

  const item = db.prepare(
    'SELECT * FROM files WHERE id = ? AND user_id = ? AND is_deleted = 0'
  ).get(fileId, userId);
  if (!item) throw new Error('Item not found');

  if (item.name === trimmed) {
    return { id: fileId, name: trimmed, path: item.path, is_folder: !!item.is_folder };
  }

  const parent = normalizeParentPath(item.parent_path);
  const conflict = db.prepare(
    'SELECT id FROM files WHERE user_id = ? AND parent_path = ? AND name = ? AND id != ? AND is_deleted = 0'
  ).get(userId, parent, trimmed, fileId);
  if (conflict) throw new Error(`"${trimmed}" already exists in this folder`);

  const oldPath = item.path;
  const newPath = joinFilePath(parent, trimmed);

  db.prepare("UPDATE files SET name = ?, path = ?, updated_at = datetime('now') WHERE id = ?")
    .run(trimmed, newPath, fileId);

  if (item.is_folder) {
    updateDescendantPaths(userId, oldPath, newPath);
  }

  const affectedIds = [fileId];
  if (item.is_folder) {
    const descendants = db.prepare(
      'SELECT id FROM files WHERE user_id = ? AND path LIKE ?'
    ).all(userId, `${newPath}/%`);
    for (const d of descendants) affectedIds.push(d.id);
  }

  for (const id of affectedIds) {
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(id);
    if (file) await metadata.updatePathMetadata(userId, file);
  }

  notifyPlaylistFolderSync(userId, affectedIds);
  return { id: fileId, name: trimmed, path: newPath, is_folder: !!item.is_folder };
}

async function moveItems(userId, ids, destinationParentPath) {
  const dest = normalizeParentPath(destinationParentPath);
  const uniqueIds = [...new Set((ids || []).filter(Boolean))];
  if (!uniqueIds.length) throw new Error('No items to move');

  if (dest !== '/') {
    const destFolder = db.prepare(
      'SELECT id FROM files WHERE user_id = ? AND path = ? AND is_folder = 1'
    ).get(userId, dest);
    if (!destFolder) throw new Error('Destination folder not found');
  }

  const items = uniqueIds
    .map((id) => db.prepare('SELECT * FROM files WHERE id = ? AND user_id = ?').get(id, userId))
    .filter(Boolean);
  if (!items.length) throw new Error('No items to move');

  const topLevelItems = items.filter((item) => isTopLevelMove(item, items));
  const placeholders = uniqueIds.map(() => '?').join(',');

  for (const item of topLevelItems) {
    if (normalizeParentPath(item.parent_path) === dest) continue;

    if (item.is_folder && (dest === item.path || isDescendantOrSelf(item.path, dest))) {
      throw new Error(`Cannot move "${item.name}" into itself or a subfolder`);
    }

    const conflict = db.prepare(
      `SELECT id FROM files WHERE user_id = ? AND parent_path = ? AND name = ? AND id NOT IN (${placeholders})`
    ).get(userId, dest, item.name, ...uniqueIds);
    if (conflict) throw new Error(`"${item.name}" already exists in destination`);

    const batchConflict = topLevelItems.find(
      (other) => other.id !== item.id && other.name === item.name
        && normalizeParentPath(other.parent_path) !== dest
    );
    if (batchConflict) throw new Error(`"${item.name}" already exists in destination`);
  }

  const movedIds = [];

  for (const item of topLevelItems) {
    if (normalizeParentPath(item.parent_path) === dest) continue;

    const oldPath = item.path;
    const newPath = joinFilePath(dest, item.name);

    db.prepare("UPDATE files SET parent_path = ?, path = ?, updated_at = datetime('now') WHERE id = ?")
      .run(dest, newPath, item.id);

    if (item.is_folder) {
      updateDescendantPaths(userId, oldPath, newPath);
    }

    movedIds.push(item.id);
  }

  if (!movedIds.length) return { moved: 0, skipped: topLevelItems.length };

  const affectedIds = new Set(movedIds);
  for (const id of movedIds) {
    const moved = db.prepare('SELECT * FROM files WHERE id = ?').get(id);
    if (moved?.is_folder) {
      const descendants = db.prepare(
        'SELECT id FROM files WHERE user_id = ? AND path LIKE ?'
      ).all(userId, `${moved.path}/%`);
      for (const descendant of descendants) affectedIds.add(descendant.id);
    }
  }

  for (const id of affectedIds) {
    const file = db.prepare('SELECT * FROM files WHERE id = ?').get(id);
    if (file) await metadata.updatePathMetadata(userId, file);
  }

  notifyPlaylistFolderSync(userId, [...affectedIds]);

  return { moved: movedIds.length };
}

async function createFolder(userId, name, parentPath) {
  const normalized = parentPath === '' ? '/' : parentPath;
  const folderPath = normalized === '/' ? `/${name}` : `${normalized}/${name}`;

  const existing = db.prepare(
    'SELECT id FROM files WHERE user_id = ? AND parent_path = ? AND name = ? AND is_deleted = 0'
  ).get(userId, normalized, name);
  if (existing) return { id: existing.id, name, path: folderPath, is_folder: true };

  const id = uuidv4();
  const folder = {
    id, name, path: folderPath, parent_path: normalized,
    is_folder: 1, size: 0, created_at: new Date().toISOString(),
  };

  db.prepare(`
    INSERT INTO files (id, user_id, name, path, size, is_folder, parent_path)
    VALUES (?, ?, ?, ?, 0, 1, ?)
  `).run(id, userId, name, folderPath, normalized);

  await metadata.saveFileManifest(userId, folder, [], null, false);
  return { id, name, path: folderPath, is_folder: true };
}

async function getStorageStats(userId) {
  const repos = db.prepare('SELECT * FROM storage_repos WHERE user_id = ?').all(userId).map(r => ({
    ...r,
    is_full: (r.total_bytes || 0) >= REPO_CAPACITY_BYTES,
  }));
  const fileCount = db.prepare(
    'SELECT COUNT(*) as count FROM files WHERE user_id = ? AND is_folder = 0'
  ).get(userId);
  const totalSize = db.prepare(
    'SELECT COALESCE(SUM(size), 0) as total FROM files WHERE user_id = ? AND is_folder = 0'
  ).get(userId);
  const metaRepo = metadata.getMetadataRepo(userId);
  const gitUpload = require('./git-upload');

  return {
    repos,
    fileCount: fileCount.count,
    totalSize: totalSize.total,
    chunkSize: CHUNK_SIZE,
    encrypted: true,
    metadata_repo: metaRepo?.full_name || null,
    gitAvailable: await gitUpload.isGitAvailable(),
    poolFull: repos.filter(r => !r.is_metadata && r.is_active).length > 0 &&
              repos.filter(r => !r.is_metadata && r.is_active && !r.is_full).length === 0,
  };
}

function addRepo(userId, fullName, defaultBranch, options = {}) {
  const { linkedAccountId = null, repoRole = 'primary', isPublic = null } = options;
  const [owner, name] = fullName.split('/');
  const result = db.prepare(`
    INSERT INTO storage_repos (user_id, owner, name, full_name, default_branch, is_metadata, linked_account_id, repo_role, is_public)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
  `).run(
    userId, owner, name, fullName, defaultBranch || 'main', linkedAccountId, repoRole,
    isPublic == null ? 0 : (isPublic ? 1 : 0)
  );
  const repo = db.prepare('SELECT * FROM storage_repos WHERE id = ?').get(result.lastInsertRowid);
  accounts.ensureBackupReposForAllAccounts(userId).catch(() => {});
  return repo;
}

function removeRepo(userId, repoId) {
  const repo = db.prepare('SELECT * FROM storage_repos WHERE id = ? AND user_id = ?').get(repoId, userId);
  if (!repo) throw new Error('Repo not found');
  if (repo.is_metadata) throw new Error('Cannot remove the metadata repository');

  const chunks = db.prepare(
    'SELECT COUNT(*) as count FROM chunks c JOIN storage_repos r ON c.repo_id = r.id WHERE r.id = ? AND r.user_id = ?'
  ).get(repoId, userId);
  const backups = db.prepare(
    'SELECT COUNT(*) as count FROM chunk_backups cb JOIN storage_repos r ON cb.repo_id = r.id WHERE r.id = ? AND r.user_id = ?'
  ).get(repoId, userId);
  if (chunks.count > 0 || backups.count > 0) {
    throw new Error('Cannot remove repo with stored chunks. Delete files first or deactivate.');
  }
  db.prepare('DELETE FROM storage_repos WHERE id = ? AND user_id = ?').run(repoId, userId);
}

function toggleRepo(userId, repoId, active) {
  const repo = db.prepare('SELECT * FROM storage_repos WHERE id = ? AND user_id = ?').get(repoId, userId);
  if (repo?.is_metadata) throw new Error('Cannot disable the metadata repository');
  db.prepare('UPDATE storage_repos SET is_active = ? WHERE id = ? AND user_id = ?').run(active ? 1 : 0, repoId, userId);
}

function getReadyFile(userId, fileId) {
  const file = db.prepare(`
    SELECT * FROM files
    WHERE id = ? AND user_id = ? AND is_folder = 0
      AND (upload_status IS NULL OR upload_status = 'ready')
  `).get(fileId, userId);
  if (!file) throw new Error('File not found or upload still in progress');
  if (!file.chunk_count) throw new Error('File has no chunks to verify');
  return file;
}

function getChunkSizeForFile(fileId, file) {
  const firstChunk = db.prepare(
    'SELECT plain_size FROM chunks WHERE file_id = ? ORDER BY chunk_index LIMIT 1'
  ).get(fileId);
  if (firstChunk?.plain_size) return firstChunk.plain_size;
  return Math.ceil(file.size / file.chunk_count) || file.size;
}

function getExpectedPlainChunkSize(file, chunkIndex, chunkSize) {
  const idx = parseInt(chunkIndex, 10);
  const start = idx * chunkSize;
  if (!Number.isFinite(idx) || idx < 0 || start >= file.size) {
    throw new Error('Invalid chunk index');
  }
  return Math.min(chunkSize, file.size - start);
}

async function checkChunkPresentOnGitHub(userId, chunkRow, repo) {
  const [owner, repoName] = repo.full_name.split('/');
  const octokit = accounts.createClientForRepo(userId, repo);
  const branch = repo.default_branch || 'main';
  const remoteSha = await github.getFileSha(
    octokit, owner, repoName, chunkRow.repo_path, branch, { subsystem: 'verify-repair' }
  );
  if (!remoteSha) return { present: false };
  if (!chunkRow.sha || chunkRow.sha === 'pending' || chunkRow.sha !== remoteSha) {
    db.prepare('UPDATE chunks SET sha = ? WHERE id = ?').run(remoteSha, chunkRow.id);
  }
  return { present: true, sha: remoteSha };
}

async function verifyFileChunksOnGitHub(userId, fileId, onProgress = null) {
  const file = getReadyFile(userId, fileId);
  const total = file.chunk_count;
  const dbChunks = db.prepare(`
    SELECT c.*, r.full_name, r.default_branch, r.linked_account_id, r.is_active
    FROM chunks c
    JOIN storage_repos r ON c.repo_id = r.id
    WHERE c.file_id = ?
  `).all(fileId);
  const byIndex = new Map(dbChunks.map((row) => [row.chunk_index, row]));

  const { mapConcurrent } = require('./chunk-session');
  const indices = Array.from({ length: total }, (_, i) => i);

  const results = await mapConcurrent(indices, 4, async (chunkIndex) => {
    const row = byIndex.get(chunkIndex);
    if (!row) return { chunkIndex, present: false };
    if (!row.is_active) return { chunkIndex, present: false };
    try {
      const repo = db.prepare('SELECT * FROM storage_repos WHERE id = ?').get(row.repo_id);
      const result = await checkChunkPresentOnGitHub(userId, row, repo);
      return { chunkIndex, present: result.present };
    } catch {
      return { chunkIndex, present: false };
    }
  });

  const missing = results.filter((r) => !r.present).map((r) => r.chunkIndex).sort((a, b) => a - b);
  const verified = results.filter((r) => r.present).length;

  if (onProgress) {
    onProgress({
      checked: total,
      total,
      verified,
      missing: missing.length,
      percent: 100,
    });
  }

  return {
    valid: missing.length === 0,
    totalChunks: total,
    verified,
    missing,
    dbChunks: dbChunks.length,
  };
}

async function repairFileChunk(userId, fileId, chunkIndex, buffer, taskContext = null) {
  const file = getReadyFile(userId, fileId);
  const chunkIdx = parseInt(chunkIndex, 10);
  const chunkSize = getChunkSizeForFile(fileId, file);
  const expectedPlain = getExpectedPlainChunkSize(file, chunkIdx, chunkSize);
  if (buffer.length !== expectedPlain) {
    throw new Error(`Chunk ${chunkIdx} size mismatch: expected ${expectedPlain} bytes, got ${buffer.length}`);
  }
  if (buffer.length > MAX_CHUNK_BYTES + GCM_OVERHEAD_BYTES) {
    throw new Error(`Chunk blob is too large (${(buffer.length / MB).toFixed(1)} MB)`);
  }

  const existing = db.prepare(
    'SELECT * FROM chunks WHERE file_id = ? AND chunk_index = ?'
  ).get(fileId, chunkIdx);

  let repo = null;
  let repoPath;
  let octokit;
  let owner;
  let repoName;
  let existingSha = null;

  if (existing) {
    const existingRepo = db.prepare('SELECT * FROM storage_repos WHERE id = ?').get(existing.repo_id);
    if (existingRepo?.is_active) {
      repo = existingRepo;
      repoPath = existing.repo_path;
      [owner, repoName] = repo.full_name.split('/');
      octokit = accounts.createClientForRepo(userId, repo);
      const remoteSha = await github.getFileSha(
        octokit, owner, repoName, repoPath, repo.default_branch,
        { subsystem: 'verify-repair', bypassMissing: true }
      );
      if (remoteSha) {
        if (existing.sha !== remoteSha) {
          db.prepare('UPDATE chunks SET sha = ? WHERE id = ?').run(remoteSha, existing.id);
        }
        const chunksDone = getUploadedChunkCount(fileId);
        return {
          skipped: true,
          chunkIndex: chunkIdx,
          chunksDone,
          totalChunks: file.chunk_count,
          percent: uploadPercent(chunksDone, file.chunk_count),
        };
      }
      existingSha = existing.sha && existing.sha !== 'pending' ? existing.sha : null;
    }
  }

  const repos = getActiveRepos(userId);
  if (!repos.length) throw new Error('No storage repositories configured');

  if (!repo) {
    ({ repo, octokit, owner, repoName } = await resolveRepoForChunkUpload(userId, repos, chunkIdx));
    repoPath = `.vault/chunks/${fileId}/${String(chunkIdx).padStart(5, '0')}.bin`;
  }

  const fileKey = await getFileKeyFromMeta(userId, file);
  const { encrypted, iv, authTag } = crypto.encryptChunk(buffer, fileKey);

  const rateLimit = require('./github-rate-limit');
  const token = accounts.getTokenForRepo(userId, repo);
  const tokenKey = rateLimit.keyForToken(token);
  let clearRateCb = () => {};
  if (taskContext?.taskId) {
    const tasks = require('./tasks');
    clearRateCb = rateLimit.setWaitCallback(tokenKey, (info) => {
      const secs = Math.ceil(info.waitMs / 1000);
      tasks.update(taskContext.taskId, taskContext.userId, {
        phase: 'rate-limit',
        currentRepo: `GitHub rate limit — resuming in ${secs}s`,
        lastLog: `Waiting for GitHub rate limit (${secs}s)`,
      });
    });
  }

  let sha = 'pending';
  try {
    try {
      sha = await github.uploadChunk(
        octokit, owner, repoName, repoPath, encrypted, repo.default_branch, existingSha
      );
    } catch (uploadErr) {
      if (isGitHubNotFound(uploadErr)) {
        const info = await github.getRepoInfo(octokit, owner, repoName);
        const branch = info.default_branch || 'main';
        if (branch !== repo.default_branch) {
          db.prepare('UPDATE storage_repos SET default_branch = ? WHERE id = ?').run(branch, repo.id);
          repo.default_branch = branch;
        }
        sha = await github.uploadChunk(
          octokit, owner, repoName, repoPath, encrypted, branch, existingSha
        );
      } else {
        throw uploadErr;
      }
    }
  } finally {
    clearRateCb();
  }

  const updateRepo = db.prepare(
    'UPDATE storage_repos SET chunk_count = chunk_count + 1, total_bytes = total_bytes + ? WHERE id = ?'
  );

  if (existing) {
    const repoChanged = existing.repo_id !== repo.id;
    db.prepare(`
      UPDATE chunks
      SET repo_id = ?, repo_path = ?, sha = ?, size = ?, chunk_iv = ?, chunk_tag = ?, plain_size = ?
      WHERE id = ?
    `).run(
      repo.id, repoPath, sha, encrypted.length,
      iv.toString('base64'), authTag.toString('base64'), buffer.length,
      existing.id
    );
    if (repoChanged) updateRepo.run(encrypted.length, repo.id);
  } else {
    db.prepare(`
      INSERT INTO chunks (file_id, chunk_index, repo_id, repo_path, sha, size, chunk_iv, chunk_tag, plain_size)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fileId, chunkIdx, repo.id, repoPath, sha, encrypted.length,
      iv.toString('base64'), authTag.toString('base64'), buffer.length
    );
    updateRepo.run(encrypted.length, repo.id);
  }

  const chunksDone = getUploadedChunkCount(fileId);
  return {
    skipped: false,
    repaired: true,
    chunkIndex: chunkIdx,
    chunksDone,
    totalChunks: file.chunk_count,
    percent: uploadPercent(chunksDone, file.chunk_count),
    currentRepo: repo.full_name,
  };
}

async function finalizeFileRepair(userId, fileId) {
  const file = getReadyFile(userId, fileId);
  const verify = await verifyFileChunksOnGitHub(userId, fileId);
  if (!verify.valid) {
    throw new Error(`Repair incomplete: ${verify.missing.length} chunk(s) still missing on GitHub`);
  }

  const chunks = db.prepare(`
    SELECT c.*, r.full_name FROM chunks c
    JOIN storage_repos r ON c.repo_id = r.id
    WHERE c.file_id = ? ORDER BY c.chunk_index
  `).all(fileId);

  const encryptionMeta = await resolveEncryptionMeta(userId, file);
  const fileRecord = {
    id: file.id,
    name: file.name,
    path: file.path,
    parent_path: file.parent_path,
    size: file.size,
    mime_type: file.mime_type,
    chunk_count: file.chunk_count,
    is_folder: 0,
    created_at: file.created_at,
  };
  const chunkRecords = chunks.map((chunk) => ({
    chunk_index: chunk.chunk_index,
    full_name: chunk.full_name,
    repo_path: chunk.repo_path,
    sha: chunk.sha,
    size: chunk.size,
    plain_size: chunk.plain_size,
  }));

  if (metadata.getMetadataRepo(userId)) {
    const manifestSha = await metadata.saveFileManifest(userId, fileRecord, chunkRecords, encryptionMeta, !!file.has_thumbnail);
    await maybeRecordFileHistory(userId, file.id, { source: 'repair', manifestSha });
  }

  const backupSync = require('./backup-sync');
  backupSync.startAllBackupSyncs(userId);
  touchFile(fileId);

  return { fileId, totalChunks: file.chunk_count, repaired: true };
}

function notifyPlaylistFolderSync(userId, fileIds) {
  if (!fileIds?.length) return;
  try {
    const playlistsSvc = require('./playlists');
    const unique = [...new Set(fileIds.filter(Boolean))];
    for (const fileId of unique) {
      playlistsSvc.syncPlaylistsForFile(userId, fileId);
    }
  } catch {
    /* playlist sync is best-effort */
  }
}

module.exports = {
  isChunkMode,
  uploadFile,
  initUploadSession,
  uploadPlainChunk,
  finalizeUpload,
  cancelUploadSession,
  getUploadSession,
  markUploadFailed,
  uploadPercent,
  downloadFile,
  downloadFileVersion,
  restoreFileVersion,
  downloadFileToPath,
  downloadFileWithProgress,
  deleteFile,
  listFiles,
  searchFilesGlobal,
  softTrashItems,
  restoreItems,
  createFolder,
  renameItem,
  moveItems,
  refreshThumbnail,
  setCustomThumbnail,
  getStorageStats,
  getFileDetails,
  createShareToken,
  revokeShareToken,
  ensureShareKeyMeta,
  getShareClientStreamEnabled,
  setShareClientStreamEnabled,
  getShareManifest,
  getPlaylistManifest,
  pickRepo,
  getShareEncryptedChunk,
  getPlaylistEncryptedChunk,
  getSharedByToken,
  getFileByShareToken,
  resolveSharedFile,
  listSharedFolder,
  shareThumbnailAvailable,
  getShareThumbnail,
  planUpload,
  normalizeChunkSize,
  githubRawUrl,
  addRepo,
  removeRepo,
  toggleRepo,
  CHUNK_SIZE,
  MAX_CHUNK_BYTES,
  GITHUB_MAX_BLOB_BYTES,
  GB,
  MB,
  getUploadedChunkIndices,
  getUploadedChunkCount,
  getChunkSizeForFile,
  verifyFileChunksOnGitHub,
  repairFileChunk,
  finalizeFileRepair,
};
