import path from 'path';
import fs from 'fs';
import { getDatabase } from '../db/database';
import * as fileTreeRepo from '../db/file-tree-repo';
import * as queueRepo from '../db/queue-repo';
import { getSettings, updateSettings } from '../db/settings-repo';
import { VaultApiClient } from './api-client';
import { detectConflicts, makeConflictCopyPath } from './conflict-detector';
import { computeFileHash } from '../services/hasher';
import { logger } from '../services/logger';
import type { FileEntry, SyncFileEntry, SyncState } from '../shared/types';

let running = false;
let syncTimer: NodeJS.Timeout | null = null;
let currentState: SyncState = { status: 'idle', lastSyncAt: null, lastError: null, pendingUploads: 0, pendingDownloads: 0, conflictCount: 0, totalFiles: 0 };
let onStateChange: ((state: SyncState) => void) | null = null;

export function getSyncState(): SyncState {
  return { ...currentState };
}

export function onSyncStateChange(cb: (state: SyncState) => void): void {
  onStateChange = cb;
}

function emitState(partial: Partial<SyncState>): void {
  currentState = { ...currentState, ...partial };
  if (onStateChange) onStateChange(currentState);
}

export async function startSyncLoop(): Promise<void> {
  const settings = getSettings();
  if (!settings.syncEnabled || !settings.serverUrl || !settings.apiKey) {
    logger.warn('sync', 'Sync not started — missing config');
    return;
  }

  running = true;
  logger.info('sync', 'Sync loop started');
  await runSyncCycle();

  syncTimer = setInterval(async () => {
    if (!running) return;
    await runSyncCycle();
  }, settings.syncIntervalSeconds * 1000);
}

export function stopSyncLoop(): void {
  running = false;
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  emitState({ status: 'idle' });
  logger.info('sync', 'Sync loop stopped');
}

async function runSyncCycle(): Promise<void> {
  const settings = getSettings();
  if (!settings.serverUrl || !settings.apiKey) {
    emitState({ status: 'idle', lastError: 'Not authenticated' });
    return;
  }

  emitState({ status: 'syncing' });
  const api = new VaultApiClient({ serverUrl: settings.serverUrl, apiKey: settings.apiKey });
  logger.info('sync', 'Starting sync cycle');

  try {
    await syncRemoteMetadata(api, settings.syncRootPath);
    await scanLocalFiles(settings.syncRootPath);
    updateCounts();
    updateSettings({ lastSyncCursor: new Date().toISOString() });
    emitState({ status: 'idle', lastSyncAt: new Date().toISOString(), lastError: null });
    logger.info('sync', 'Sync cycle complete');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error('sync', `Sync cycle failed: ${msg}`);
    emitState({ status: 'error', lastError: msg });
  }
}

async function syncRemoteMetadata(api: VaultApiClient, syncRoot: string): Promise<void> {
  const db = getDatabase();

  async function walkFolder(folderPath: string): Promise<void> {
    const result = await api.listFiles(folderPath, 500, 0);
    if (!result.ok) {
      logger.error('sync', `Failed to list ${folderPath}: ${result.error.message}`);
      return;
    }

    for (const file of result.value.files) {
      const isFolder = !!(file.isFolder || file.is_folder);
      const localRel = isFolder
        ? file.path.slice(1) + (file.path === '/' ? '' : '/')
        : file.path.slice(1);
      const normalizedRel = localRel.replace(/\//g, path.sep);
      const absPath = path.join(syncRoot, normalizedRel);

      const existing = fileTreeRepo.getFileByRelPath(normalizedRel);
      const syncEntry: SyncFileEntry = {
        fileId: file.id,
        localRelPath: normalizedRel,
        remotePath: file.path,
        name: file.name,
        size: file.size,
        mimeType: file.mimeType,
        isFolder,
        localMtimeMs: existing?.localMtimeMs ?? null,
        localHash: existing?.localHash ?? null,
        remoteHash: file.contentHash,
        remoteUpdatedAt: file.updatedAt,
        syncStatus: existing ? existing.syncStatus : 'remote_only',
        syncTaskId: existing?.syncTaskId ?? null,
        syncError: null,
      };

      fileTreeRepo.upsertFile(db, syncEntry);

      if (!isFolder && !existing) {
        if (!fs.existsSync(absPath)) {
          logger.info('sync', `New remote file: ${normalizedRel} (needs download)`);
        }
      }
    }

    if (result.value.hasMore && result.value.nextOffset !== undefined) {
      const next = await api.listFiles(folderPath, 500, result.value.nextOffset);
      if (next.ok) {
        for (const file of next.value.files) {
          const isFolderPg = !!(file.isFolder || file.is_folder);
          const localRel = file.path.slice(1);
          const normalizedRel = localRel.replace(/\//g, path.sep);
          const existing = fileTreeRepo.getFileByRelPath(normalizedRel);
          fileTreeRepo.upsertFile(db, {
            fileId: file.id,
            localRelPath: normalizedRel,
            remotePath: file.path,
            name: file.name,
            size: file.size,
            mimeType: file.mimeType,
            isFolder: isFolderPg,
            localMtimeMs: existing?.localMtimeMs ?? null,
            localHash: existing?.localHash ?? null,
            remoteHash: file.contentHash,
            remoteUpdatedAt: file.updatedAt,
            syncStatus: existing ? existing.syncStatus : 'remote_only',
            syncTaskId: existing?.syncTaskId ?? null,
            syncError: null,
          });
        }
      }
    }

    for (const file of result.value.files) {
      const isFolder = !!(file.isFolder || file.is_folder);
      if (isFolder) {
        await walkFolder(file.path);
      }
    }
  }

  await walkFolder('/');
}

async function scanLocalFiles(syncRoot: string): Promise<void> {
  const db = getDatabase();
  const known = new Set(fileTreeRepo.getAllFiles().map((f) => f.localRelPath));
  const seen = new Set<string>();

  function walk(dir: string, relDir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.vault-')) continue;
      if (entry.name.startsWith('~$')) continue;
      if (entry.name.endsWith('.tmp') || entry.name.endsWith('.part') || entry.name.endsWith('.crdownload')) continue;

      const relPath = relDir ? path.join(relDir, entry.name) : entry.name;
      seen.add(relPath);

      if (entry.isDirectory()) {
        const existing = fileTreeRepo.getFileByRelPath(relPath);
        if (!existing) {
          fileTreeRepo.upsertFile(db, {
            fileId: null,
            localRelPath: relPath,
            remotePath: null,
            name: entry.name,
            size: 0,
            mimeType: null,
            isFolder: true,
            localMtimeMs: null,
            localHash: null,
            remoteHash: null,
            remoteUpdatedAt: null,
            syncStatus: 'local_only',
            syncTaskId: null,
            syncError: null,
          });
        } else {
          fileTreeRepo.upsertFile(db, { ...existing, isFolder: true });
        }
        walk(path.join(dir, entry.name), relPath);
      } else {
        validateAndQueueFile(dir, entry.name, relPath);
      }
    }
  }

  walk(syncRoot, '');

  for (const filePath of known) {
    if (!seen.has(filePath)) {
      const existing = fileTreeRepo.getFileByRelPath(filePath);
      if (existing && existing.syncStatus === 'synced') {
        logger.info('sync', `Local file deleted: ${filePath}`);
        fileTreeRepo.upsertFile(db, { ...existing, syncStatus: 'deleted' });
      }
    }
  }
}

async function validateAndQueueFile(dir: string, name: string, relPath: string): Promise<void> {
  const absPath = path.join(dir, name);
  const existing = fileTreeRepo.getFileByRelPath(relPath);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return;
  }

  if (!existing || existing.syncStatus === 'local_only') {
    const hash = await computeFileHash(absPath).catch(() => null);
    if (!hash) return;

    const dupEntry = fileTreeRepo.getFileByHash(hash);
    if (dupEntry && dupEntry.fileId && dupEntry.syncStatus === 'synced') {
      logger.info('sync', `Duplicate by hash: ${relPath} matches ${dupEntry.localRelPath}`);
      fileTreeRepo.upsertFile(getDatabase(), {
        fileId: dupEntry.fileId,
        localRelPath: relPath,
        remotePath: dupEntry.remotePath,
        name,
        size: stat.size,
        mimeType: existing?.mimeType ?? null,
        isFolder: false,
        localMtimeMs: stat.mtimeMs,
        localHash: hash,
        remoteHash: dupEntry.remoteHash,
        remoteUpdatedAt: dupEntry.remoteUpdatedAt,
        syncStatus: 'synced',
        syncTaskId: null,
        syncError: null,
      });
      return;
    }

    if (existing?.syncStatus === 'synced' && existing.localHash === hash) return;

    logger.info('sync', `New/modified file: ${relPath}`);
    fileTreeRepo.upsertFile(getDatabase(), {
      fileId: existing?.fileId ?? null,
      localRelPath: relPath,
      remotePath: existing?.remotePath ?? null,
      name,
      size: stat.size,
      mimeType: existing?.mimeType ?? null,
      isFolder: false,
      localMtimeMs: stat.mtimeMs,
      localHash: hash,
      remoteHash: existing?.remoteHash ?? null,
      remoteUpdatedAt: existing?.remoteUpdatedAt ?? null,
      syncStatus: 'local_only',
      syncTaskId: null,
      syncError: null,
    });

    queueRepo.addToQueue({
      fileId: existing?.fileId ?? null,
      localRelPath: relPath,
      localHash: hash,
      size: stat.size,
      mimeType: existing?.mimeType ?? null,
      status: 'pending',
      uploadMode: 'seamless',
      percent: 0,
      error: null,
      retryCount: 0,
      maxRetries: 100,
      taskId: null,
      sessionJson: null,
      priority: 0,
    });
  }
}

function updateCounts(): void {
  const counts = fileTreeRepo.getSyncStatusCounts();
  const queueCount = queueRepo.getActiveCount();
  emitState({
    totalFiles: counts.total,
    pendingUploads: counts.localOnly + queueCount,
    pendingDownloads: 0,
    conflictCount: counts.conflict,
  });
}
