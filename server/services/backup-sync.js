const db = require('../db/database');
const accounts = require('./accounts');
const tasks = require('./tasks');
const rateLimit = require('./github-rate-limit');
const workloadGovernor = require('./workload-governor');
const chunkLookup = require('./chunk-lookup-cache');
const { mapConcurrent } = require('./chunk-session');

const activeSyncs = new Map();
const SYNC_CONCURRENCY = 2;
const SYNC_BATCH_SIZE = 8;
const STALE_SYNC_MS = 30 * 60 * 1000;
const RECONCILE_MAX_ROUNDS = 8;
const NO_PROGRESS_BACKOFF_MS = 30000;

function syncKey(userId, linkedAccountId) {
  return `${userId}:${linkedAccountId}`;
}

function isSyncActive(key) {
  const entry = activeSyncs.get(key);
  if (!entry) return false;
  const tk = entry.tokenKey;
  if (tk && rateLimit.isPaused(tk)) return true;
  if (Date.now() - entry.startedAt > STALE_SYNC_MS) {
    activeSyncs.delete(key);
    return false;
  }
  return true;
}

function formatWait(seconds) {
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.ceil(seconds / 60);
  return mins === 1 ? '1 min' : `${mins} min`;
}

function backupTokenKey(userId, linkedAccountId) {
  const account = accounts.getLinkedAccount(userId, linkedAccountId);
  return account?.access_token ? rateLimit.keyForToken(account.access_token) : null;
}

const SOURCE_MISSING_SHA = '__source_missing__';

function skipUnrecoverableChunk(userId, chunkRow, linkedAccountId, reason) {
  const backupRepos = accounts.getBackupReposForPrimary(userId, chunkRow.repo_id, linkedAccountId);
  for (const repo of backupRepos) {
    db.prepare(`
      INSERT OR IGNORE INTO chunk_backups (chunk_id, repo_id, sha)
      VALUES (?, ?, ?)
    `).run(chunkRow.id, repo.id, SOURCE_MISSING_SHA);
  }
  chunkLookup.markSyncConfirmedMissing(chunkRow.id, linkedAccountId, reason);
  if (chunkRow.file_id) {
    db.prepare('UPDATE files SET backup_skip = 1 WHERE id = ? AND user_id = ?')
      .run(chunkRow.file_id, userId);
  }
}

function reconcileUnrecoverableChunks(userId, linkedAccountId) {
  const rows = db.prepare(`
    SELECT c.id, c.file_id, c.repo_id, c.repo_path, c.size, csf.last_error
    FROM chunk_sync_failures csf
    JOIN chunks c ON c.id = csf.chunk_id
    JOIN files f ON f.id = c.file_id
    WHERE f.user_id = ? AND csf.linked_account_id = ?
      AND (csf.confirmed_missing = 1 OR csf.last_error LIKE '%not found%')
      AND NOT EXISTS (
        SELECT 1 FROM chunk_backups cb
        JOIN storage_repos br ON cb.repo_id = br.id
        WHERE cb.chunk_id = c.id
          AND br.linked_account_id = ?
          AND br.repo_role = 'backup'
          AND br.mirrors_repo_id = c.repo_id
      )
  `).all(userId, linkedAccountId, linkedAccountId);

  for (const row of rows) {
    skipUnrecoverableChunk(userId, row, linkedAccountId, row.last_error || 'Source chunk missing');
  }
  return rows.length;
}

function findMissingBackups(userId, linkedAccountId, limit = 200) {
  return db.prepare(`
    SELECT c.id, c.file_id, c.repo_id, c.repo_path, c.size
    FROM chunks c
    JOIN files f ON f.id = c.file_id
    WHERE f.user_id = ?
      AND (f.upload_status IS NULL OR f.upload_status = 'ready')
      AND (f.backup_skip IS NULL OR f.backup_skip = 0)
      AND NOT EXISTS (
        SELECT 1 FROM chunk_backups cb
        JOIN storage_repos br ON cb.repo_id = br.id
        WHERE cb.chunk_id = c.id
          AND br.linked_account_id = ?
          AND br.repo_role = 'backup'
          AND br.mirrors_repo_id = c.repo_id
      )
    ORDER BY c.id ASC
    LIMIT ?
  `).all(userId, linkedAccountId, limit);
}

function getQueueStats(userId, linkedAccountId) {
  const totalChunks = totalReadyChunks(userId);
  const missing = countMissingBackups(userId, linkedAccountId);
  const synced = Math.max(0, totalChunks - missing);

  let backoff = 0;
  let failed = 0;
  let nextRetryAt = null;
  try {
    const row = db.prepare(`
      SELECT
        SUM(CASE WHEN csf.confirmed_missing = 1 THEN 1 ELSE 0 END) as failed,
        SUM(CASE WHEN csf.confirmed_missing = 0 AND csf.next_retry_at > datetime('now') THEN 1 ELSE 0 END) as backoff,
        MIN(CASE WHEN csf.confirmed_missing = 0 AND csf.next_retry_at > datetime('now') THEN csf.next_retry_at END) as next_retry
      FROM chunk_sync_failures csf
      JOIN chunks c ON c.id = csf.chunk_id
      JOIN files f ON f.id = c.file_id
      WHERE f.user_id = ? AND csf.linked_account_id = ?
        AND NOT EXISTS (
          SELECT 1 FROM chunk_backups cb
          JOIN storage_repos br ON cb.repo_id = br.id
          WHERE cb.chunk_id = c.id AND br.linked_account_id = ? AND br.repo_role = 'backup'
        )
    `).get(userId, linkedAccountId, linkedAccountId);
    backoff = row?.backoff || 0;
    failed = row?.failed || 0;
    nextRetryAt = row?.next_retry || null;
  } catch { /* table may not exist */ }

  const processing = Math.max(0, missing - backoff - failed);
  return {
    total: totalChunks,
    synced,
    missing,
    processing,
    backoff,
    failed,
    next_retry_at: nextRetryAt,
    next_retry_seconds: nextRetryAt
      ? Math.max(0, Math.ceil((new Date(nextRetryAt).getTime() - Date.now()) / 1000))
      : null,
  };
}

function countMissingBackups(userId, linkedAccountId) {
  return db.prepare(`
    SELECT COUNT(*) as c FROM chunks c
    JOIN files f ON f.id = c.file_id
    WHERE f.user_id = ?
      AND (f.upload_status IS NULL OR f.upload_status = 'ready')
      AND (f.backup_skip IS NULL OR f.backup_skip = 0)
      AND NOT EXISTS (
        SELECT 1 FROM chunk_backups cb
        JOIN storage_repos br ON cb.repo_id = br.id
        WHERE cb.chunk_id = c.id
          AND br.linked_account_id = ?
          AND br.repo_role = 'backup'
          AND br.mirrors_repo_id = c.repo_id
      )
  `).get(userId, linkedAccountId).c;
}

function parseAccountId(payloadJson) {
  try {
    const payload = payloadJson ? JSON.parse(payloadJson) : {};
    return Number(payload.accountId);
  } catch {
    return null;
  }
}

function getActiveTask(userId, accountId) {
  const rows = db.prepare(`
    SELECT id, phase, percent, payload, status, updated_at
    FROM tasks
    WHERE user_id = ? AND type = 'backup-sync' AND status = 'processing'
    ORDER BY updated_at DESC
  `).all(userId);

  for (const row of rows) {
    if (parseAccountId(row.payload) === Number(accountId)) return row;
  }
  return null;
}

function getBackupTask(userId, accountId) {
  const rows = db.prepare(`
    SELECT id, phase, percent, payload, status, updated_at
    FROM tasks
    WHERE user_id = ? AND type = 'backup-sync' AND status IN ('processing', 'paused', 'error')
    ORDER BY updated_at DESC
  `).all(userId);

  for (const row of rows) {
    if (parseAccountId(row.payload) !== Number(accountId)) continue;
    const payload = row.payload ? JSON.parse(row.payload) : {};
    if (row.status === 'error' && !payload.resumable) continue;
    return row;
  }
  return null;
}

function backupReposReady(userId, linkedAccountId) {
  const count = db.prepare(`
    SELECT COUNT(*) as c FROM storage_repos
    WHERE user_id = ? AND linked_account_id = ? AND repo_role = 'backup'
  `).get(userId, linkedAccountId).c;
  return count > 0;
}

function totalReadyChunks(userId) {
  return db.prepare(`
    SELECT COUNT(*) as c FROM chunks c JOIN files f ON f.id = c.file_id
    WHERE f.user_id = ? AND (f.upload_status IS NULL OR f.upload_status = 'ready')
  `).get(userId).c;
}

function shouldFastResume(userId, linkedAccountId) {
  const missing = countMissingBackups(userId, linkedAccountId);
  return missing > 0 && backupReposReady(userId, linkedAccountId);
}

function reportChunkProgress(taskId, userId, linkedAccountId, accountUsername, batchDone, batchTotal) {
  const totalChunks = totalReadyChunks(userId);
  const missing = countMissingBackups(userId, linkedAccountId);
  const done = totalChunks - missing;
  tasks.update(taskId, userId, {
    phase: 'chunk-fallback',
    percent: totalChunks ? Math.round((done / totalChunks) * 100) : 100,
    chunksDone: done,
    chunksTotal: totalChunks,
    currentRepo: `@${accountUsername} (${batchDone}/${batchTotal} this batch, ${missing} left)`,
  });
}

function pruneDuplicateBackupTasks(userId, linkedAccountId, keepId = null) {
  const rows = db.prepare(`
    SELECT id, payload, updated_at, status
    FROM tasks
    WHERE user_id = ? AND type = 'backup-sync'
      AND status IN ('processing', 'paused', 'error')
    ORDER BY updated_at DESC
  `).all(userId);

  const matching = rows.filter((row) => {
    if (parseAccountId(row.payload) !== Number(linkedAccountId)) return false;
    if (row.status === 'error') {
      try {
        const payload = row.payload ? JSON.parse(row.payload) : {};
        return payload.resumable !== false;
      } catch {
        return true;
      }
    }
    return true;
  });
  if (!matching.length) return keepId || null;
  if (matching.length <= 1) return keepId || matching[0].id;

  const keep = keepId || matching[0].id;
  for (const row of matching) {
    if (row.id !== keep) tasks.remove(row.id, userId);
  }
  return keep;
}

function dedupeAllBackupTasks(userId) {
  const backupAccounts = db.prepare(`
    SELECT id FROM linked_accounts
    WHERE user_id = ? AND role = 'backup' AND is_active = 1
  `).all(userId);
  for (const { id } of backupAccounts) {
    pruneDuplicateBackupTasks(userId, id);
  }
}

function getSyncStatus(userId) {
  const backupAccounts = db.prepare(`
    SELECT id, username FROM linked_accounts
    WHERE user_id = ? AND role = 'backup' AND is_active = 1
  `).all(userId);

  const totalChunks = db.prepare(`
    SELECT COUNT(*) as c FROM chunks c
    JOIN files f ON f.id = c.file_id
    WHERE f.user_id = ? AND (f.upload_status IS NULL OR f.upload_status = 'ready')
  `).get(userId).c;

  return backupAccounts.map((account) => {
    const missing = countMissingBackups(userId, account.id);
    const key = syncKey(userId, account.id);
    const syncing = isSyncActive(key);
    const task = getActiveTask(userId, account.id) || getBackupTask(userId, account.id);
    const tokenKey = backupTokenKey(userId, account.id);
    const pause = tokenKey ? rateLimit.getPauseInfo(tokenKey) : null;
    const queue = getQueueStats(userId, account.id);
    const percent = totalChunks ? Math.round((queue.synced / totalChunks) * 100) : 100;
    let phase = task?.phase || (syncing ? 'syncing' : null);
    if (pause) phase = 'rate-limit';
    if (task?.status === 'paused') phase = 'paused';
    if (queue.backoff > 0 && phase === 'chunk-fallback') phase = 'backoff';

    return {
      account_id: account.id,
      username: account.username,
      missing_chunks: missing,
      total_chunks: totalChunks,
      synced_chunks: queue.synced,
      processing_chunks: queue.processing,
      backoff_chunks: queue.backoff,
      failed_chunks: queue.failed,
      percent: (syncing || task?.status === 'processing') && task?.percent != null ? task.percent : percent,
      syncing: syncing || !!pause,
      paused: task?.status === 'paused',
      pause_reason: task?.pauseReason || null,
      up_to_date: missing === 0,
      method: 'fork',
      phase,
      rate_limit_seconds: pause?.seconds_left || null,
      next_retry_seconds: queue.next_retry_seconds,
      queue,
    };
  });
}

function hasActiveUpload(userId) {
  tasks.cleanupStaleUploadTasks(userId);
  const active = db.prepare(`
    SELECT id, updated_at FROM tasks
    WHERE user_id = ? AND type = 'upload' AND status IN ('processing', 'pending')
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(userId);
  if (!active) return false;
  // If an upload task hasn't been updated in 6 hours, consider it stale
  const staleMs = 6 * 60 * 60 * 1000;
  if (Date.now() - new Date(active.updated_at).getTime() > staleMs) {
    tasks.update(active.id, userId, { status: 'error', error: 'Upload timed out', resumable: false });
    tasks.appendLog(active.id, userId, 'Upload task timed out — marked as error');
    return false;
  }
  return true;
}

function shouldPauseBackground(userId) {
  return hasActiveUpload(userId);
}

function waitForNoActiveUpload(userId, intervalMs = 15000) {
  return new Promise((resolve) => {
    const check = () => {
      if (!hasActiveUpload(userId)) return resolve();
      setTimeout(check, intervalMs);
    };
    check();
  });
}

function forceBackupSync(userId, linkedAccountId) {
  tasks.cleanupStaleUploadTasks(userId);
  dedupeAllBackupTasks(userId);
  chunkLookup.clearSyncFailuresForAccount(linkedAccountId);

  // Remove stuck/non-resumable tasks so a fresh sync can start
  const stuck = db.prepare(`
    SELECT id FROM tasks
    WHERE user_id = ? AND type = 'backup-sync'
      AND (phase = 'stuck' OR (status = 'error' AND phase != 'done'))
  `).all(userId);
  for (const row of stuck) {
    db.prepare('DELETE FROM tasks WHERE id = ? AND user_id = ?').run(row.id, userId);
  }

  const key = syncKey(userId, linkedAccountId);
  const entry = activeSyncs.get(key);
  if (entry && Date.now() - entry.startedAt > STALE_SYNC_MS) {
    activeSyncs.delete(key);
  }

  const existing = getBackupTask(userId, linkedAccountId);
  if (existing?.id) {
    tasks.update(existing.id, userId, {
      status: 'processing',
      phase: 'chunk-fallback',
      pauseReason: null,
      error: null,
      resumable: true,
    });
    tasks.appendLog(existing.id, userId, 'Force-started by user');
  }

  return runBackupSync(userId, linkedAccountId, { fastResume: true, force: true });
}

function maybeResumeSync(userId) {
  if (hasActiveUpload(userId)) return;

  const backupAccounts = db.prepare(`
    SELECT id FROM linked_accounts
    WHERE user_id = ? AND role = 'backup' AND is_active = 1
  `).all(userId);

  for (const { id } of backupAccounts) {
    const missing = countMissingBackups(userId, id);
    if (missing === 0) continue;
    const tokenKey = backupTokenKey(userId, id);
    if (tokenKey && rateLimit.isPaused(tokenKey)) continue;
    const key = syncKey(userId, id);
    if (isSyncActive(key)) continue;

    // Don't restart if the most recent backup-sync ended stuck for this account
    const recentBackupTask = db.prepare(`
      SELECT id, phase, status, payload FROM tasks
      WHERE user_id = ? AND type = 'backup-sync'
      ORDER BY updated_at DESC LIMIT 1
    `).get(userId);
    if (recentBackupTask) {
      const payload = recentBackupTask.payload ? JSON.parse(recentBackupTask.payload) : {};
      const isStuck = recentBackupTask.phase === 'stuck' && recentBackupTask.status === 'error';
      const isNonResumable = recentBackupTask.status === 'error' && !payload.resumable;
      if ((isStuck || isNonResumable) && parseAccountId(recentBackupTask.payload) === Number(id)) continue;
    }

    const pausedTask = getBackupTask(userId, id);
    const fastResume = shouldFastResume(userId, id)
      || pausedTask?.status === 'paused';
    runBackupSync(userId, id, { fastResume });
  }
}

async function syncOneChunk(userId, chunkRow, linkedAccountId, taskId, { force = false } = {}) {
  if (!chunkLookup.shouldRetrySync(chunkRow.id, linkedAccountId, { force })) {
    return false;
  }
  try {
    const chunk = db.prepare(`
      SELECT c.*, r.full_name, r.default_branch
      FROM chunks c JOIN storage_repos r ON c.repo_id = r.id
      WHERE c.id = ?
    `).get(chunkRow.id);
    if (!chunk) return false;

    const encrypted = await rateLimit.runWithSubsystem('backup-sync', () =>
      accounts.downloadChunkFromPrimary(userId, chunk)
    );
    await rateLimit.runWithSubsystem('backup-sync', () =>
      accounts.mirrorChunk(userId, chunk.id, encrypted, chunk.repo_path, chunk.repo_id, linkedAccountId)
    );
    chunkLookup.clearSyncFailure(chunkRow.id, linkedAccountId);
    return true;
  } catch (err) {
    const msg = err.response?.data?.message || err.message || 'Unknown error';
    const is404 = err.status === 404 || /not found/i.test(msg);
    if (is404) {
      skipUnrecoverableChunk(userId, chunkRow, linkedAccountId, msg);
      if (taskId) {
        tasks.appendLog(taskId, userId, `Chunk ${chunkRow.id} unavailable on primary — file marked not backable`);
      }
      return 'skipped';
    }
    chunkLookup.recordSyncFailure(chunkRow.id, linkedAccountId, msg);
    const failRow = chunkLookup.loadSyncFailure(chunkRow.id, linkedAccountId);
    if (failRow?.fail_count <= 1) {
      console.error(`[backup-sync] Chunk ${chunkRow.id} failed: ${msg}`);
    }
    if (taskId) {
      tasks.appendLog(taskId, userId, `Chunk ${chunkRow.id} skipped: ${msg.slice(0, 200)}`);
    }
    return false;
  }
}

async function runBackupSync(userId, linkedAccountId, { fastResume = false, force = false } = {}) {
  const key = syncKey(userId, linkedAccountId);
  if (isSyncActive(key)) return activeSyncs.get(key).promise;

  let taskId = null;
  let rateLimitUnsub = () => {};
  const entry = { startedAt: Date.now(), tokenKey: null, promise: null };

  entry.promise = workloadGovernor.runBackground(userId, async () => {
    const account = accounts.getLinkedAccount(userId, linkedAccountId);
    if (!account || account.role !== 'backup' || !account.is_active) return;

    if (hasActiveUpload(userId)) {
      const existingTask = getBackupTask(userId, linkedAccountId);
      if (existingTask?.id) {
        tasks.update(existingTask.id, userId, {
          status: 'paused',
          phase: 'paused',
          pauseReason: 'Waiting for upload to finish',
          resumable: true,
        });
        tasks.appendLog(existingTask.id, userId, 'Paused — upload in progress');
      }
      return;
    }

    const reconciled = reconcileUnrecoverableChunks(userId, linkedAccountId);
    if (reconciled > 0) {
      console.log(`[backup-sync] Skipped ${reconciled} unrecoverable chunk(s) for account ${linkedAccountId}`);
    }

    entry.tokenKey = rateLimit.keyForToken(account.access_token);
    const tokenKey = entry.tokenKey;
    rateLimitUnsub = rateLimit.setWaitCallback(tokenKey, (info) => {
      if (!taskId) return;
      const totalChunks = totalReadyChunks(userId);
      const missing = countMissingBackups(userId, linkedAccountId);
      const done = totalChunks - missing;
      tasks.update(taskId, userId, {
        phase: 'rate-limit',
        percent: totalChunks ? Math.round((done / totalChunks) * 100) : 100,
        chunksDone: done,
        chunksTotal: totalChunks,
        currentRepo: `GitHub rate limit — resuming in ${formatWait(Math.ceil(info.waitMs / 1000))}`,
      });
    });

    const existingTask = getBackupTask(userId, linkedAccountId);
    taskId = pruneDuplicateBackupTasks(userId, linkedAccountId, existingTask?.id);
    if (taskId) {
      tasks.update(taskId, userId, {
        title: `Backup sync (@${account.username})`,
        status: 'processing',
        error: null,
        resumable: true,
        accountId: linkedAccountId,
        method: 'fork',
      });
    } else {
      const task = tasks.create(userId, {
        type: 'backup-sync',
        title: `Backup sync (@${account.username})`,
        payload: { accountId: linkedAccountId, method: 'fork', resumable: true },
      });
      taskId = task.id;
    }

    const useFastResume = fastResume || shouldFastResume(userId, linkedAccountId);

    if (useFastResume) {
      const totalChunks = totalReadyChunks(userId);
      const missing = countMissingBackups(userId, linkedAccountId);
      const done = totalChunks - missing;
      tasks.appendLog(taskId, userId, `Resuming backup sync — ${missing} chunks remaining (${done}/${totalChunks})`);
      tasks.update(taskId, userId, {
        phase: 'chunk-fallback',
        percent: totalChunks ? Math.round((done / totalChunks) * 100) : 100,
        chunksDone: done,
        chunksTotal: totalChunks,
        currentRepo: `Resuming — ${missing} chunks left`,
      });
    } else {
      tasks.update(taskId, userId, {
        phase: 'setup',
        percent: 2,
        currentRepo: 'Checking backup repos',
      });

      await accounts.ensureBackupReposForAccount(userId, linkedAccountId);

      tasks.update(taskId, userId, {
        phase: 'fork-sync',
        percent: 5,
        currentRepo: 'Syncing forks from upstream',
      });

      await accounts.syncForkBackups(userId, linkedAccountId, (progress) => {
        tasks.update(taskId, userId, progress);
      });
    }

    let reconcileRounds = 0;
    let stuckChunks = 0;
    let noProgressStreak = 0;
    while (true) {
      if (hasActiveUpload(userId)) {
        tasks.update(taskId, userId, {
          status: 'paused',
          phase: 'paused',
          pauseReason: 'Waiting for upload to finish',
        });
        tasks.appendLog(taskId, userId, 'Paused — upload in progress');
        await waitForNoActiveUpload(userId);
        tasks.update(taskId, userId, {
          status: 'processing',
          phase: 'chunk-fallback',
          pauseReason: null,
        });
        tasks.appendLog(taskId, userId, 'Resuming after upload finished');
      }

      const totalMissing = countMissingBackups(userId, linkedAccountId);
      if (!totalMissing) break;
      const totalChunks = totalReadyChunks(userId);

      const rawMissing = findMissingBackups(userId, linkedAccountId, SYNC_BATCH_SIZE);
      const missing = chunkLookup.filterRetryableChunks(rawMissing, linkedAccountId, { force });

      if (rawMissing.length && !missing.length && !force) {
        const queue = getQueueStats(userId, linkedAccountId);
        const waitSec = queue.next_retry_seconds || 30;
        tasks.update(taskId, userId, {
          phase: 'backoff',
          percent: totalChunks ? Math.round((queue.synced / totalChunks) * 100) : 100,
          chunksDone: queue.synced,
          chunksTotal: totalChunks,
          currentRepo: `Backoff: ${queue.backoff} chunks — retry in ${waitSec}s`,
        });
        tasks.appendLog(taskId, userId, `Waiting for backoff (${queue.backoff} chunks, ${queue.failed} failed)`);
        await new Promise((r) => setTimeout(r, Math.min(waitSec * 1000, 60000)));
        continue;
      }

      if (missing.length) {
        const beforeMissing = totalMissing;
        const concurrency = Math.min(
          SYNC_CONCURRENCY,
          rateLimit.getRecommendedConcurrency(tokenKey, SYNC_CONCURRENCY)
        );
        let completed = 0;
        let succeeded = 0;
        await mapConcurrent(missing, concurrency, async (chunkRow) => {
          if (hasActiveUpload(userId)) return;
          const ok = await syncOneChunk(userId, chunkRow, linkedAccountId, taskId, { force });
          if (ok) succeeded += 1;
          completed += 1;
          reportChunkProgress(taskId, userId, linkedAccountId, account.username, completed, missing.length);
          await new Promise((resolve) => setImmediate(resolve));
        });

        const afterMissing = countMissingBackups(userId, linkedAccountId);
        if (succeeded === 0 && afterMissing >= beforeMissing) {
          noProgressStreak += 1;
          if (reconcileRounds < RECONCILE_MAX_ROUNDS) {
            reconcileRounds += 1;
            tasks.update(taskId, userId, {
              phase: 'reconcile',
              percent: totalChunks ? Math.round(((totalChunks - afterMissing) / totalChunks) * 100) : 100,
              chunksDone: totalChunks - afterMissing,
              chunksTotal: totalChunks,
              currentRepo: `Reconciling (round ${reconcileRounds})`,
            });
            await rateLimit.runWithSubsystem('reconcile', () =>
              accounts.reconcileAllBackupRepos(userId, linkedAccountId, (reconciled, total) => {
                const currentDone = totalChunks - countMissingBackups(userId, linkedAccountId);
                tasks.update(taskId, userId, {
                  phase: 'reconcile',
                  percent: totalChunks ? Math.round((currentDone / totalChunks) * 100) : 100,
                  chunksDone: currentDone,
                  chunksTotal: totalChunks,
                  currentRepo: `Reconciling ${reconciled}/${total}`,
                });
              })
            );
          }
          if (noProgressStreak >= 3) {
            tasks.appendLog(taskId, userId, `No progress — backing off ${NO_PROGRESS_BACKOFF_MS / 1000}s`);
            await new Promise((r) => setTimeout(r, NO_PROGRESS_BACKOFF_MS));
            noProgressStreak = 0;
          }
        } else {
          noProgressStreak = 0;
        }
        continue;
      }

      if (reconcileRounds < RECONCILE_MAX_ROUNDS && totalMissing > 0) {
        reconcileRounds += 1;
        const done = totalChunks - totalMissing;
        tasks.update(taskId, userId, {
          phase: 'reconcile',
          percent: totalChunks ? Math.round((done / totalChunks) * 100) : 100,
          chunksDone: done,
          chunksTotal: totalChunks,
          currentRepo: `@${account.username} (round ${reconcileRounds})`,
        });
        await rateLimit.runWithSubsystem('reconcile', () =>
          accounts.reconcileAllBackupRepos(userId, linkedAccountId, (reconciled, total) => {
            const currentDone = totalChunks - countMissingBackups(userId, linkedAccountId);
            tasks.update(taskId, userId, {
              phase: 'reconcile',
              percent: totalChunks ? Math.round((currentDone / totalChunks) * 100) : 100,
              chunksDone: currentDone,
              chunksTotal: totalChunks,
              currentRepo: `Reconciling ${reconciled}/${total}`,
            });
          })
        );
        continue;
      }

      // No progress possible — remaining chunks may be orphaned or already exist on backup GitHub but not in DB
      const stuck = countMissingBackups(userId, linkedAccountId);
      if (stuck > 0) {
        tasks.update(taskId, userId, {
          status: 'error',
          phase: 'stuck',
          percent: totalChunks ? Math.round(((totalChunks - stuck) / totalChunks) * 100) : 100,
          chunksDone: totalChunks - stuck,
          chunksTotal: totalChunks,
          pauseReason: `${stuck} chunk(s) cannot be synced — they may be missing from storage repos`,
          resumable: false,
          error: `${stuck} chunk(s) unreadable from primary storage repos`,
        });
        tasks.appendLog(taskId, userId, `Backup sync stuck: ${stuck} chunk(s) unreachable`);
        stuckChunks = stuck;
      }
      break;
    }

    if (!stuckChunks) {
      tasks.update(taskId, userId, {
        status: 'done',
        phase: 'done',
        percent: 100,
      });
      tasks.appendLog(taskId, userId, 'Backup sync complete');
    }
    pruneDuplicateBackupTasks(userId, linkedAccountId);
  }).catch((err) => {
    console.error(`Backup sync failed for user ${userId} account ${linkedAccountId}:`, err.message);
    if (taskId) {
      tasks.update(taskId, userId, {
        status: 'error',
        phase: 'error',
        error: err.message,
        resumable: true,
      });
    }
  }).finally(() => {
    rateLimitUnsub();
    activeSyncs.delete(key);
  });

  activeSyncs.set(key, entry);
  return entry.promise;
}

function startAllBackupSyncs(userId) {
  dedupeAllBackupTasks(userId);
  const linked = db.prepare(`
    SELECT id FROM linked_accounts WHERE user_id = ? AND role = 'backup' AND is_active = 1
  `).all(userId);
  for (const { id } of linked) {
    runBackupSync(userId, id, { fastResume: shouldFastResume(userId, id) });
  }
}

function startBackupSyncsForAllUsers() {
  const users = db.prepare(`
    SELECT DISTINCT user_id FROM linked_accounts WHERE role = 'backup' AND is_active = 1
  `).all();
  for (const { user_id: userId } of users) {
    if (hasActiveUpload(userId)) {
      console.log(`Deferring backup sync for user ${userId} — upload in progress`);
      continue;
    }
    dedupeAllBackupTasks(userId);
    startAllBackupSyncs(userId);
  }
}

module.exports = {
  findMissingBackups,
  countMissingBackups,
  getQueueStats,
  getSyncStatus,
  maybeResumeSync,
  forceBackupSync,
  runBackupSync,
  shouldFastResume,
  dedupeAllBackupTasks,
  startAllBackupSyncs,
  startBackupSyncsForAllUsers,
};
