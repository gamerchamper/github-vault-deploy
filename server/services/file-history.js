/**
 * Experimental file version history — snapshots manifest + chunk SHAs on each content change.
 * Git manifest commits provide an audit trail; historical chunks are fetched by blob SHA.
 */
const crypto = require('crypto');
const db = require('../db/database');
const github = require('./github');
const metadata = require('./metadata');

const ENABLED = process.env.EXPERIMENTAL_FILE_HISTORY !== '0';
const MAX_VERSIONS_PER_FILE = parseInt(process.env.FILE_HISTORY_MAX_VERSIONS || '40', 10);

function isEnabled() {
  return ENABLED;
}

function contentFingerprint(chunks, size) {
  const parts = (chunks || [])
    .slice()
    .sort((a, b) => a.chunk_index - b.chunk_index)
    .map((c) => `${c.chunk_index}:${c.sha}:${c.plain_size ?? c.size}`);
  return crypto.createHash('sha256').update(`${size}|${parts.join('|')}`).digest('hex');
}

function buildSnapshot(file, chunks, encryptionMeta) {
  return {
    file_id: file.id,
    name: file.name,
    path: file.path,
    parent_path: file.parent_path,
    size: file.size,
    mime_type: file.mime_type,
    chunk_count: file.chunk_count,
    encryption: encryptionMeta,
    chunks: chunks.map((c) => ({
      chunk_index: c.chunk_index,
      repo_id: c.repo_id,
      full_name: c.full_name,
      repo_path: c.repo_path,
      sha: c.sha,
      size: c.size,
      plain_size: c.plain_size,
      chunk_iv: c.chunk_iv,
      chunk_tag: c.chunk_tag,
    })),
    recorded_at: new Date().toISOString(),
  };
}

function loadChunksForFile(fileId) {
  return db.prepare(`
    SELECT c.*, r.full_name
    FROM chunks c
    JOIN storage_repos r ON c.repo_id = r.id
    WHERE c.file_id = ?
    ORDER BY c.chunk_index
  `).all(fileId);
}

function getLatestVersion(fileId) {
  return db.prepare(`
    SELECT * FROM file_versions
    WHERE file_id = ?
    ORDER BY version_num DESC
    LIMIT 1
  `).get(fileId);
}

function pruneOldVersions(fileId) {
  const rows = db.prepare(`
    SELECT id FROM file_versions
    WHERE file_id = ?
    ORDER BY version_num DESC
  `).all(fileId);
  if (rows.length <= MAX_VERSIONS_PER_FILE) return;
  const drop = rows.slice(MAX_VERSIONS_PER_FILE);
  const del = db.prepare('DELETE FROM file_versions WHERE id = ?');
  for (const row of drop) del.run(row.id);
}

async function recordVersion(userId, fileId, { source = 'upload', manifestSha = null, note = null } = {}) {
  if (!ENABLED) return null;

  const file = db.prepare(
    "SELECT * FROM files WHERE id = ? AND user_id = ? AND is_folder = 0 AND upload_status = 'ready'",
  ).get(fileId, userId);
  if (!file) return null;

  const chunks = loadChunksForFile(fileId);
  if (!chunks.length) return null;

  let encryptionMeta;
  try {
    encryptionMeta = JSON.parse(file.encryption_meta);
  } catch {
    encryptionMeta = null;
  }
  if (!encryptionMeta) return null;

  const fingerprint = contentFingerprint(chunks, file.size);
  const latest = getLatestVersion(fileId);
  if (latest?.content_fingerprint === fingerprint) {
    if (manifestSha && latest.manifest_sha !== manifestSha) {
      db.prepare('UPDATE file_versions SET manifest_sha = ? WHERE id = ?').run(manifestSha, latest.id);
    }
    return latest;
  }

  const versionNum = (latest?.version_num ?? 0) + 1;
  const snapshot = buildSnapshot(file, chunks, encryptionMeta);

  const result = db.prepare(`
    INSERT INTO file_versions (
      file_id, user_id, version_num, size, chunk_count, content_fingerprint,
      manifest_sha, source, note, manifest_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fileId,
    userId,
    versionNum,
    file.size,
    file.chunk_count,
    fingerprint,
    manifestSha,
    source,
    note,
    JSON.stringify(snapshot),
  );

  pruneOldVersions(fileId);

  return db.prepare('SELECT * FROM file_versions WHERE id = ?').get(Number(result.lastInsertRowid));
}

function mapVersionRow(row, { isCurrent = false } = {}) {
  return {
    id: row.id,
    versionNum: row.version_num,
    size: row.size,
    chunkCount: row.chunk_count,
    contentFingerprint: row.content_fingerprint,
    manifestSha: row.manifest_sha,
    source: row.source,
    note: row.note,
    createdAt: row.created_at,
    isCurrent: !!isCurrent,
  };
}

async function listManifestCommits(userId, fileId, limit = 30) {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  const metaRepo = metadata.getMetadataRepo(userId);
  if (!user || !metaRepo) return [];

  const path = `.vault/metadata/files/${fileId}.json`;
  const [owner, name] = metaRepo.full_name.split('/');
  const octokit = github.createClient(user.access_token);

  try {
    const rateLimit = require('./github-rate-limit');
    const { data } = await rateLimit.runWithSubsystem('metadata', () =>
      octokit.repos.listCommits({
        owner,
        repo: name,
        path,
        per_page: Math.min(limit, 100),
      }),
    );
    return (data || []).map((c) => ({
      sha: c.sha,
      message: c.commit?.message || '',
      date: c.commit?.committer?.date || c.commit?.author?.date,
      author: c.commit?.author?.name,
    }));
  } catch {
    return [];
  }
}

async function listVersions(userId, fileId) {
  if (!ENABLED) {
    return { enabled: false, versions: [], gitCommits: [] };
  }

  const file = db.prepare('SELECT id FROM files WHERE id = ? AND user_id = ?').get(fileId, userId);
  if (!file) throw new Error('File not found');

  const rows = db.prepare(`
    SELECT * FROM file_versions
    WHERE file_id = ? AND user_id = ?
    ORDER BY version_num DESC
  `).all(fileId, userId);

  const latest = rows[0];
  const versions = rows.map((row, idx) => mapVersionRow(row, { isCurrent: idx === 0 }));

  const gitCommits = await listManifestCommits(userId, fileId);

  return {
    enabled: true,
    fileId,
    versions,
    gitCommits,
    currentVersionId: latest?.id ?? null,
  };
}

function getVersion(userId, fileId, versionId) {
  const row = db.prepare(`
    SELECT * FROM file_versions
    WHERE id = ? AND file_id = ? AND user_id = ?
  `).get(versionId, fileId, userId);
  if (!row) throw new Error('Version not found');
  return row;
}

module.exports = {
  isEnabled,
  recordVersion,
  listVersions,
  getVersion,
  contentFingerprint,
  listManifestCommits,
};
