import path from 'path';
import fs from 'fs';
import os from 'os';
import { getSettings } from '../db/settings-repo';
import { resolveAbsPathToStored, getEnabledAdditionalFolders } from '../services/sync-mappings';
import { startAllWatchers } from './file-watcher';
import {
  handleWatcherEvent,
  startSyncLoop,
  stopSyncLoop,
  scanAdditionalFolderNow,
} from './sync-engine';
import { resetFolderCache, kickQueue } from './upload-queue';
import { registerAdditionalFolderRoots } from './folder-sync';
import { logger } from '../services/logger';

export function collectWatchRoots(): string[] {
  const settings = getSettings();
  const roots: string[] = [];
  if (settings.syncRootPath) roots.push(settings.syncRootPath);
  for (const mapping of getEnabledAdditionalFolders(settings)) {
    roots.push(mapping.localPath);
  }
  return roots;
}

export function restartWatchers(): void {
  startAllWatchers(collectWatchRoots(), (absPath) => {
    const s = getSettings();
    return resolveAbsPathToStored(s, absPath);
  }, (event, filePath) => {
    handleWatcherEvent(event, filePath).catch((err) => {
      logger.warn('watcher', `Event failed (${event} ${filePath}): ${err instanceof Error ? err.message : String(err)}`);
    });
  });
}

export async function onRemoteConfigApplied(): Promise<void> {
  resetFolderCache();
  restartWatchers();
  try {
    await registerAdditionalFolderRoots();
  } catch (err) {
    logger.warn('agent', `Folder root registration failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const settings = getSettings();
  for (const folder of getEnabledAdditionalFolders(settings)) {
    scanAdditionalFolderNow(folder.id).catch(() => {});
  }
  kickQueue();
  stopSyncLoop();
  startSyncLoop().catch(() => {});
}

export function getDefaultDataDir(): string {
  return process.env.VAULT_SYNC_DATA_DIR || path.join(os.homedir(), '.vault-sync');
}

export function getDefaultSyncRoot(): string {
  return process.env.VAULT_SYNC_ROOT || path.join(os.homedir(), 'GitHub Vault');
}

export function ensureDataDir(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
}
