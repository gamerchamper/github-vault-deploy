const REPO_CAPACITY_BYTES = parseInt(process.env.REPO_CAPACITY_GB || '1', 10) * 1024 * 1024 * 1024;

function buildRepoCapacity(repo, githubSizeKb) {
  const vaultUsed = repo.total_bytes || 0;
  const githubBytes = (githubSizeKb || 0) * 1024;
  const repoSize = Math.max(githubBytes, vaultUsed);
  const otherUsed = Math.max(0, repoSize - vaultUsed);
  const capacity = REPO_CAPACITY_BYTES;
  const available = Math.max(0, capacity - vaultUsed);
  const usedPercent = capacity > 0 ? Math.min(100, (vaultUsed / capacity) * 100) : 0;
  const vaultPercent = usedPercent;

  return {
    repo_size: repoSize,
    vault_used: vaultUsed,
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
  // Use database-stored values — zero API calls. The GitHub API 'size' field is
  // only cosmetic for "other files" display and not needed for vault operations.
  return repos.map((repo) => ({
    repo,
    capacity: buildRepoCapacity(repo, Math.round((repo.total_bytes || 0) / 1024)),
    github: null,
  }));
}

async function getReposCapacityForUser(userId, repos) {
  // Same: use database values, zero API calls
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
      acc.other_used += capacity.other_used;
      acc.capacity += capacity.capacity;
      acc.available += capacity.available;
      acc.chunk_count += capacity.chunk_count;
      return acc;
    },
    { repo_size: 0, vault_used: 0, other_used: 0, capacity: 0, available: 0, chunk_count: 0 }
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
  buildRepoCapacity,
  getReposCapacity,
  getReposCapacityForUser,
  aggregateCapacity,
};
