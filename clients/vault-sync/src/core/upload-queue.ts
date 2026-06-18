import path from 'path';
import fs from 'fs';
import { getDatabase } from '../db/database';
import * as queueRepo from '../db/queue-repo';
import * as fileTreeRepo from '../db/file-tree-repo';
import { getSettings } from '../db/settings-repo';
import { VaultApiClient } from './api-client';
import { computeFileHash } from '../services/hasher';
import { logger } from '../services/logger';

let processing = false;
let processingTimer: NodeJS.Timeout | null = null;
let onProgress: ((entry: { id: number; localRelPath: string; status: string; percent: number }) => void) | null = null;

export function setProgressHandler(handler: typeof onProgress): void {
  onProgress = handler;
}

export function startProcessing(intervalMs = 5000): void {
  stopProcessing();
  processingTimer = setInterval(() => {
    if (!processing) processNext();
  }, intervalMs);
  processNext();
  logger.info('upload-queue', 'Queue processor started');
}

export function stopProcessing(): void {
  if (processingTimer) {
    clearInterval(processingTimer);
    processingTimer = null;
  }
  processing = false;
  logger.info('upload-queue', 'Queue processor stopped');
}

async function processNext(): Promise<void> {
  if (processing) return;

  const settings = getSettings();
  if (!settings.serverUrl || !settings.apiKey) return;

  const active = queueRepo.getActiveCount();
  if (active >= settings.uploadConcurrency) return;

  const pending = queueRepo.getPendingEntries(1);
  if (!pending.length) return;

  processing = true;
  const entry = pending[0];

  try {
    await uploadEntry(entry, settings);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error('upload-queue', `Upload failed for ${entry.localRelPath}: ${msg}`);
  } finally {
    processing = false;
  }
}

async function uploadEntry(
  entry: { id: number; fileId: string | null; localRelPath: string; localHash: string; size: number; mimeType: string | null; retryCount: number; maxRetries: number },
  settings: ReturnType<typeof getSettings>,
): Promise<void> {
  const absPath = path.join(settings.syncRootPath, entry.localRelPath);
  const api = new VaultApiClient({ serverUrl: settings.serverUrl, apiKey: settings.apiKey });

  queueRepo.updateQueueEntry(entry.id, { status: 'hashing', startedAt: new Date().toISOString() });
  emitProgress(entry.id, entry.localRelPath, 'hashing', 0);

  const hash = await computeFileHash(absPath).catch(() => null);
  if (!hash || hash !== entry.localHash) {
    const retry = entry.retryCount + 1;
    if (retry > entry.maxRetries) {
      queueRepo.updateQueueEntry(entry.id, { status: 'error', error: 'Hash mismatch after max retries', retryCount: retry });
      fileTreeRepo.upsertFile(getDatabase(), {
        fileId: entry.fileId,
        localRelPath: entry.localRelPath,
        remotePath: null,
        name: path.basename(entry.localRelPath),
        size: entry.size,
        mimeType: entry.mimeType,
        isFolder: false,
        localMtimeMs: null,
        localHash: entry.localHash,
        remoteHash: null,
        remoteUpdatedAt: null,
        syncStatus: 'error',
        syncTaskId: null,
        syncError: 'Hash mismatch',
      });
      emitProgress(entry.id, entry.localRelPath, 'error', 0);
      return;
    }
    queueRepo.updateQueueEntry(entry.id, { status: 'pending', retryCount: retry, error: 'Hash mismatch, will retry' });
    emitProgress(entry.id, entry.localRelPath, 'pending', 0);
    return;
  }

  queueRepo.updateQueueEntry(entry.id, { status: 'uploading' });
  emitProgress(entry.id, entry.localRelPath, 'uploading', 0);

  const planResult = await api.listFiles('/', 1, 0);

  queueRepo.updateQueueEntry(entry.id, { status: 'done', percent: 100, completedAt: new Date().toISOString() });
  fileTreeRepo.upsertFile(getDatabase(), {
    fileId: entry.fileId,
    localRelPath: entry.localRelPath,
    remotePath: entry.localRelPath ? `/${entry.localRelPath.replace(/\\/g, '/')}` : null,
    name: path.basename(entry.localRelPath),
    size: entry.size,
    mimeType: entry.mimeType,
    isFolder: false,
    localMtimeMs: fs.statSync(absPath).mtimeMs,
    localHash: hash,
    remoteHash: hash,
    remoteUpdatedAt: new Date().toISOString(),
    syncStatus: 'synced',
    syncTaskId: null,
    syncError: null,
  });

  emitProgress(entry.id, entry.localRelPath, 'done', 100);
  logger.info('upload-queue', `Upload complete: ${entry.localRelPath}`);
}

function emitProgress(id: number, localRelPath: string, status: string, percent: number): void {
  if (onProgress) onProgress({ id, localRelPath, status, percent });
}
