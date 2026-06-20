import dotenv from 'dotenv';
import path from 'path';
import crypto from 'crypto';
import { openDatabase, closeDatabase } from './db/database';
import { getSettings, updateSettings } from './db/settings-repo';
import * as queueRepo from './db/queue-repo';
import { startSyncLoop, stopSyncLoop, onSyncStateChange } from './core/sync-engine';
import { stopWatcher } from './core/file-watcher';
import { startProcessing, stopProcessing, kickQueue } from './core/upload-queue';
import { logger } from './services/logger';
import { startAgentClient } from './core/agent-client';
import {
  ensureDataDir,
  getDefaultDataDir,
  getDefaultSyncRoot,
  onRemoteConfigApplied,
  restartWatchers,
} from './core/runtime';
import type { AdditionalSyncFolder, SyncState } from './shared/types';

dotenv.config();

function parseAdditionalFoldersFromEnv(raw: string | undefined): AdditionalSyncFolder[] {
  if (!raw?.trim()) return [];
  const now = new Date().toISOString();
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((f) => f && typeof f.localPath === 'string')
        .map((f) => ({
          id: f.id || crypto.randomUUID(),
          name: f.name || path.basename(f.localPath),
          localPath: f.localPath,
          enabled: f.enabled !== false,
          addedAt: now,
        }));
    }
  } catch {
    // fall through to comma-separated paths
  }
  return raw.split(',')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((localPath) => ({
      id: crypto.randomUUID(),
      name: path.basename(localPath),
      localPath,
      enabled: true,
      addedAt: now,
    }));
}

function applyEnvSettings(): void {
  const patch: Record<string, unknown> = {};
  if (process.env.VAULT_URL) patch.serverUrl = process.env.VAULT_URL.replace(/\/+$/, '');
  if (process.env.VAULT_API_KEY) patch.apiKey = process.env.VAULT_API_KEY;
  if (process.env.VAULT_SYNC_ROOT) patch.syncRootPath = process.env.VAULT_SYNC_ROOT;
  else if (!getSettings().syncRootPath) patch.syncRootPath = getDefaultSyncRoot();
  if (process.env.VAULT_SYNC_INTERVAL) {
    const n = parseInt(process.env.VAULT_SYNC_INTERVAL, 10);
    if (Number.isFinite(n) && n >= 5) patch.syncIntervalSeconds = n;
  }
  if (process.env.VAULT_SYNC_ENABLED !== undefined) {
    patch.syncEnabled = process.env.VAULT_SYNC_ENABLED !== '0' && process.env.VAULT_SYNC_ENABLED !== 'false';
  }
  if (process.env.VAULT_CONVERT_HLS !== undefined) {
    patch.convertHlsEnabled = process.env.VAULT_CONVERT_HLS !== '0' && process.env.VAULT_CONVERT_HLS !== 'false';
  }
  const extra = parseAdditionalFoldersFromEnv(process.env.VAULT_ADDITIONAL_FOLDERS);
  if (extra.length) patch.additionalSyncFolders = extra;
  if (Object.keys(patch).length) updateSettings(patch);
}

async function main(): Promise<void> {
  const dataDir = getDefaultDataDir();
  ensureDataDir(dataDir);
  openDatabase(dataDir);

  const queueReset = queueRepo.prepareQueueAfterRestart();
  if (queueReset.deduped > 0 || queueReset.cancelled > 0 || queueReset.sessionsCleared > 0) {
    logger.info('cli', `Queue cleanup: ${queueReset.deduped} duplicate(s), ${queueReset.cancelled} invalid, ${queueReset.sessionsCleared} stale session(s) cleared`);
  }

  applyEnvSettings();

  const settings = getSettings();
  if (!settings.serverUrl || !settings.apiKey) {
    console.error('Set VAULT_URL and VAULT_API_KEY in .env (or environment) before starting the CLI sync client.');
    process.exit(1);
  }

  onSyncStateChange((state: SyncState) => {
    logger.info('cli', `Sync state: ${state.status} (pending uploads: ${state.pendingUploads})`);
  });

  restartWatchers();
  startProcessing(2000);
  kickQueue();
  await startSyncLoop();

  const stopAgent = startAgentClient({
    onRemoteConfig: () => onRemoteConfigApplied(),
  });

  logger.info('cli', `Vault Sync CLI running (data: ${dataDir}, root: ${getSettings().syncRootPath})`);

  const shutdown = () => {
    logger.info('cli', 'Shutting down...');
    stopAgent();
    stopSyncLoop();
    stopWatcher();
    stopProcessing();
    closeDatabase();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
