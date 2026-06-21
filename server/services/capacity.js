const db = require('../db/database');

const REPO_CAPACITY_BYTES = parseInt(process.env.REPO_CAPACITY_GB || '1', 10) * 1024 * 1024 * 1024;
const ENCRYPT_OVERHEAD_FACTOR = 1.02;
const HLS_OVERHEAD_FACTOR = 1.02;
const AVG_HLS_SEGMENT_BYTES = 512 * 1024;
const MAX_HLS_SEGMENT_BYTES = 40 * 1024 * 1024;

function estimateEncryptedUploadBytes(fileSize) {
  return Math.ceil(fileSize * ENCRYPT_OVERHEAD_FACTOR);
}

function estimateHlsBytes(fileSize) {
  return Math.ceil(fileSize * HLS_OVERHEAD_FACTOR);
}

function estimateHlsSegmentCount(fileSize) {
  const hlsBytes = estimateHlsBytes(fileSize);
  return Math.max(1, Math.ceil(hlsBytes / AVG_HLS_SEGMENT_BYTES));
}

/** Lower bound for valid HLS (assumes very high bitrate, large 6s segments). */
function estimateMinHlsSegmentCount(fileSize) {
  if (!fileSize || fileSize <= 0) return 1;
  return Math.max(1, Math.ceil(fileSize / MAX_HLS_SEGMENT_BYTES));
}

function getRepoEffectiveBytes(repo) {
  return (repo.total_bytes || 0) + (repo.reserved_bytes || 0);
}

function distributeBytesAcrossRepos(repos, totalBytes) {
  if (!repos.length || totalBytes <= 0) return {};
  const perRepo = {};
  const base = Math.floor(totalBytes / repos.length);
  let remainder = totalBytes - base * repos.length;
  repos.forEach((repo, index) => {
    perRepo[repo.id] = base + (index < remainder ? 1 : 0);
  });
  return perRepo;
}

function projectUploadStorage(repos, fileSize, chunkSize, convertHls = false) {
  const uploadBytes = estimateEncryptedUploadBytes(fileSize);
  const hlsBytes = convertHls ? estimateHlsBytes(fileSize) : 0;
  const normalizedChunkSize = Math.max(64 * 1024, parseInt(chunkSize, 10) || 921600);
  const chunkCount = Math.ceil(uploadBytes / normalizedChunkSize) || 1;
  const avgChunkBytes = Math.ceil(uploadBytes / chunkCount);
  const segmentCount = hlsBytes > 0
    ? Math.max(1, Math.ceil(hlsBytes / AVG_HLS_SEGMENT_BYTES))
    : 0;
  const avgSegmentBytes = segmentCount > 0 ? Math.ceil(hlsBytes / segmentCount) : 0;

  const projections = repos.map((repo) => ({
    id: repo.id,
    full_name: repo.full_name,
    currentBytes: getRepoEffectiveBytes(repo),
    projectedBytes: getRepoEffectiveBytes(repo),
  }));

  if (!projections.length) {
    return {
      uploadBytes,
      hlsBytes,
      totalBytes: uploadBytes + hlsBytes,
      chunkCount,
      segmentCount,
      projections,
      poolAvailableBytes: 0,
      fits: false,
      insufficientBytes: uploadBytes + hlsBytes,
      repoOverflow: [],
    };
  }

  for (let i = 0; i < chunkCount; i++) {
    projections[i % projections.length].projectedBytes += avgChunkBytes;
  }
  for (let i = 0; i < segmentCount; i++) {
    projections[i % projections.length].projectedBytes += avgSegmentBytes;
  }

  const poolAvailableBytes = repos.reduce(
    (sum, repo) => sum + Math.max(0, REPO_CAPACITY_BYTES - getRepoEffectiveBytes(repo)),
    0
  );
  const totalBytes = uploadBytes + hlsBytes;
  const repoOverflow = projections.filter((p) => p.projectedBytes > REPO_CAPACITY_BYTES);
  const fits = repoOverflow.length === 0 && totalBytes <= poolAvailableBytes;

  return {
    uploadBytes,
    hlsBytes,
    totalBytes,
    chunkCount,
    segmentCount,
    projections,
    poolAvailableBytes,
    fits,
    insufficientBytes: fits ? 0 : Math.max(0, totalBytes - poolAvailableBytes),
    repoOverflow,
  };
}

function checkUploadFits(repos, fileSize, chunkSize, convertHls = false) {
  return projectUploadStorage(repos, fileSize, chunkSize, convertHls);
}

function projectHlsStorage(repos, fileSize, options = {}) {
  const { alreadyReserved = false } = options;
  const hlsBytes = estimateHlsBytes(fileSize);
  const segmentCount = Math.max(1, Math.ceil(hlsBytes / AVG_HLS_SEGMENT_BYTES));
  const avgSegmentBytes = Math.ceil(hlsBytes / segmentCount);

  const projections = repos.map((repo) => ({
    id: repo.id,
    full_name: repo.full_name,
    currentBytes: getRepoEffectiveBytes(repo),
    projectedBytes: getRepoEffectiveBytes(repo),
  }));

  if (!projections.length) {
    return {
      hlsBytes,
      segmentCount,
      projections,
      poolAvailableBytes: 0,
      fits: false,
      insufficientBytes: hlsBytes,
      repoOverflow: [],
      alreadyReserved,
    };
  }

  if (!alreadyReserved) {
    for (let i = 0; i < segmentCount; i++) {
      projections[i % projections.length].projectedBytes += avgSegmentBytes;
    }
  }

  const poolAvailableBytes = repos.reduce(
    (sum, repo) => sum + Math.max(0, REPO_CAPACITY_BYTES - getRepoEffectiveBytes(repo)),
    0
  );
  const repoOverflow = projections.filter((p) => p.projectedBytes > REPO_CAPACITY_BYTES);
  const fits = alreadyReserved
    ? repoOverflow.length === 0
    : repoOverflow.length === 0 && hlsBytes <= poolAvailableBytes;

  return {
    hlsBytes,
    segmentCount,
    projections,
    poolAvailableBytes,
    fits,
    insufficientBytes: fits ? 0 : Math.max(0, hlsBytes - poolAvailableBytes),
    repoOverflow,
    alreadyReserved,
  };
}

function checkHlsConversionFits(repos, fileSize, options = {}) {
  return projectHlsStorage(repos, fileSize, options);
}

function hlsFitsError(projection) {
  const parts = [
    `Need ${formatBytesShort(projection.hlsBytes)} for HLS segments (~${projection.segmentCount})`,
  ];

  if (projection.alreadyReserved) {
    parts[0] = `HLS space was reserved at upload, but per-repo limits are exceeded after storing encrypted chunks`;
  }

  if (projection.repoOverflow.length) {
    const overflowDetail = projection.repoOverflow.slice(0, 8).map((r) => {
      const over = Math.max(0, r.projectedBytes - REPO_CAPACITY_BYTES);
      return over > 0 ? `${r.full_name} (+${formatBytesShort(over)})` : r.full_name;
    }).join(', ');
    parts.push(
      `${projection.repoOverflow.length === 1 ? 'This repo exceeds' : 'These repos exceed'} `
      + `the ${formatBytesShort(REPO_CAPACITY_BYTES)} per-repo limit: ${overflowDetail}`
      + (projection.repoOverflow.length > 8 ? ` (+${projection.repoOverflow.length - 8} more)` : '')
    );
    if (!projection.alreadyReserved && projection.poolAvailableBytes >= projection.hlsBytes) {
      parts.push('The vault pool still has free space overall — spread HLS across more repos or free space on the full repos.');
    }
  }

  if (!projection.fits && (!projection.repoOverflow.length || projection.poolAvailableBytes < projection.hlsBytes)) {
    parts.push(`Only ${formatBytesShort(projection.poolAvailableBytes)} is free across active repos. Add storage repositories or delete files.`);
  } else if (!projection.fits && projection.repoOverflow.length) {
    parts.push('Add storage repositories or delete files on the full repos, then resume.');
  }

  return parts.join('. ') + '.';
}

function formatBytesShort(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function uploadFitsError(projection) {
  const parts = [
    `Need ${formatBytesShort(projection.totalBytes)} total`
    + ` (${formatBytesShort(projection.uploadBytes)} encrypted file`
    + (projection.hlsBytes ? ` + ${formatBytesShort(projection.hlsBytes)} HLS segments` : '')
    + `)`,
    `but only ${formatBytesShort(projection.poolAvailableBytes)} is free across active repos.`,
  ];
  if (projection.repoOverflow.length) {
    parts.push(
      `These repos would exceed the ${formatBytesShort(REPO_CAPACITY_BYTES)} limit: `
      + projection.repoOverflow.map((r) => r.full_name).join(', ')
    );
  } else {
    parts.push('Add storage repositories or delete files before uploading.');
  }
  return parts.join(' ');
}

function reserveHlsStorage(userId, fileId, fileSize, repos) {
  const file = db.prepare('SELECT hls_reserved FROM files WHERE id = ? AND user_id = ?').get(fileId, userId);
  if (file?.hls_reserved) return JSON.parse(file.hls_reserved);

  const hlsBytes = estimateHlsBytes(fileSize);
  const perRepo = distributeBytesAcrossRepos(repos, hlsBytes);
  for (const [repoId, bytes] of Object.entries(perRepo)) {
    if (bytes <= 0) continue;
    db.prepare(`
      UPDATE storage_repos
      SET reserved_bytes = COALESCE(reserved_bytes, 0) + ?
      WHERE id = ? AND user_id = ?
    `).run(bytes, repoId, userId);
  }
  db.prepare('UPDATE files SET hls_reserved = ? WHERE id = ? AND user_id = ?')
    .run(JSON.stringify(perRepo), fileId, userId);
  return perRepo;
}

function consumeHlsReserve(userId, fileId, repoId, bytes) {
  const file = db.prepare('SELECT hls_reserved FROM files WHERE id = ? AND user_id = ?').get(fileId, userId);
  if (!file?.hls_reserved) return;
  const perRepo = JSON.parse(file.hls_reserved);
  const remaining = perRepo[repoId] || 0;
  if (remaining <= 0) return;
  const consumed = Math.min(remaining, bytes);
  perRepo[repoId] = remaining - consumed;
  db.prepare(`
    UPDATE storage_repos
    SET reserved_bytes = CASE
      WHEN COALESCE(reserved_bytes, 0) - ? < 0 THEN 0
      ELSE COALESCE(reserved_bytes, 0) - ?
    END
    WHERE id = ? AND user_id = ?
  `).run(consumed, consumed, repoId, userId);
  const hasRemaining = Object.values(perRepo).some((n) => n > 0);
  db.prepare('UPDATE files SET hls_reserved = ? WHERE id = ? AND user_id = ?')
    .run(hasRemaining ? JSON.stringify(perRepo) : null, fileId, userId);
}

function releaseHlsReserve(userId, fileId) {
  const file = db.prepare('SELECT hls_reserved FROM files WHERE id = ? AND user_id = ?').get(fileId, userId);
  if (!file?.hls_reserved) return;
  const perRepo = JSON.parse(file.hls_reserved);
  for (const [repoId, bytes] of Object.entries(perRepo)) {
    if (bytes <= 0) continue;
    db.prepare(`
      UPDATE storage_repos
      SET reserved_bytes = CASE
        WHEN COALESCE(reserved_bytes, 0) - ? < 0 THEN 0
        ELSE COALESCE(reserved_bytes, 0) - ?
      END
      WHERE id = ? AND user_id = ?
    `).run(bytes, bytes, repoId, userId);
  }
  db.prepare('UPDATE files SET hls_reserved = NULL WHERE id = ? AND user_id = ?').run(fileId, userId);
}

function ensureHlsReserved(userId, fileId, fileSize, repos) {
  return reserveHlsStorage(userId, fileId, fileSize, repos);
}

function buildRepoCapacity(repo, githubSizeKb) {
  const vaultUsed = getRepoEffectiveBytes(repo);
  const githubBytes = (githubSizeKb || 0) * 1024;
  const repoSize = Math.max(githubBytes, vaultUsed);
  const otherUsed = Math.max(0, repoSize - (repo.total_bytes || 0));
  const capacity = REPO_CAPACITY_BYTES;
  const available = Math.max(0, capacity - vaultUsed);
  const usedPercent = capacity > 0 ? Math.min(100, (vaultUsed / capacity) * 100) : 0;
  const vaultPercent = usedPercent;

  return {
    repo_size: repoSize,
    vault_used: repo.total_bytes || 0,
    reserved_bytes: repo.reserved_bytes || 0,
    effective_used: vaultUsed,
    other_used: otherUsed,
    capacity,
    available,
    used_percent: Math.round(usedPercent * 10) / 10,
    vault_percent: Math.round(vaultPercent * 10) / 10,
    chunk_count: repo.chunk_count || 0,
    is_active: !!repo.is_active,
    is_full: available <= 0,
  };
}

async function getReposCapacity(octokit, repos) {
  return repos.map((repo) => ({
    repo,
    capacity: buildRepoCapacity(repo, Math.round((repo.total_bytes || 0) / 1024)),
    github: null,
  }));
}

async function getReposCapacityForUser(userId, repos) {
  return repos.map((repo) => ({
    repo: { ...repo, private: false, is_public: 1 },
    capacity: buildRepoCapacity(repo, Math.round((repo.total_bytes || 0) / 1024)),
  }));
}

function aggregateCapacity(repoCapacities) {
  const active = repoCapacities.filter(r => r.capacity.is_active && !r.repo.is_metadata);

  const totals = active.reduce(
    (acc, { capacity }) => {
      acc.repo_size += capacity.repo_size;
      acc.vault_used += capacity.vault_used;
      acc.reserved_bytes += capacity.reserved_bytes || 0;
      acc.other_used += capacity.other_used;
      acc.capacity += capacity.capacity;
      acc.available += capacity.available;
      acc.chunk_count += capacity.chunk_count;
      return acc;
    },
    { repo_size: 0, vault_used: 0, reserved_bytes: 0, other_used: 0, capacity: 0, available: 0, chunk_count: 0 }
  );

  totals.used_percent = totals.capacity > 0
    ? Math.round((totals.repo_size / totals.capacity) * 1000) / 10
    : 0;
  totals.vault_percent = totals.capacity > 0
    ? Math.round((totals.vault_used / totals.capacity) * 1000) / 10
    : 0;

  return totals;
}

module.exports = {
  REPO_CAPACITY_BYTES,
  ENCRYPT_OVERHEAD_FACTOR,
  HLS_OVERHEAD_FACTOR,
  estimateEncryptedUploadBytes,
  estimateHlsBytes,
  estimateHlsSegmentCount,
  estimateMinHlsSegmentCount,
  AVG_HLS_SEGMENT_BYTES,
  getRepoEffectiveBytes,
  projectUploadStorage,
  checkUploadFits,
  checkHlsConversionFits,
  hlsFitsError,
  projectHlsStorage,
  uploadFitsError,
  reserveHlsStorage,
  consumeHlsReserve,
  releaseHlsReserve,
  ensureHlsReserved,
  buildRepoCapacity,
  getReposCapacity,
  getReposCapacityForUser,
  aggregateCapacity,
};
