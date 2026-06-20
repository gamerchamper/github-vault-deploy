import path from 'path';
import fs from 'fs';
import { getDatabase } from '../db/database';
import * as queueRepo from '../db/queue-repo';
import * as fileTreeRepo from '../db/file-tree-repo';
import { getSettings } from '../db/settings-repo';
import { VaultApiClient } from './api-client';
import { logger } from '../services/logger';
import { normalizeRelPath } from '../services/paths';
import {
  absPathFromStored,
  remoteParentFromStored,
  remotePathFromStored,
} from '../services/sync-mappings';

const POLL_INTERVAL_MS = 1000;
const MAX_PART_RETRIES = 12;
const ensuredFolderPaths = new Set<string>();

let processing = false;
let processingTimer: NodeJS.Timeout | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let onProgress: ((entry: { id: number; localRelPath: string; status: string; percent: number }) => void) | null = null;

function isStaleSessionError(msg: string): boolean {
  return /upload session not found|already completed/i.test(msg);
}

function clearUploadSession(entryId: number): void {
  queueRepo.updateQueueEntry(entryId, { fileId: null, taskId: null, sessionJson: null });
}

function scheduleRetry(delayMs: number): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    kickQueue();
  }, delayMs);
}

export function setProgressHandler(handler: typeof onProgress): void {
  onProgress = handler;
}

export function kickQueue(): void {
  if (!processing) processNext();
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
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  processing = false;
  logger.info('upload-queue', 'Queue processor stopped');
}

export function resetFolderCache(): void {
  ensuredFolderPaths.clear();
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
  logger.info('upload-queue', `Processing upload: ${entry.localRelPath} (${entry.size} bytes)`);

  let succeeded = false;
  try {
    await uploadEntrySeamless(entry, settings);
    succeeded = true;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('already exists') && entry.fileId) {
      clearUploadSession(entry.id);
      try {
        await uploadEntrySeamless({ ...entry, fileId: entry.fileId }, settings);
        succeeded = true;
        return;
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        logger.error('upload-queue', `Replace retry failed for ${entry.localRelPath}: ${retryMsg}`);
      }
    }
    if (msg.includes('already exists')) {
      queueRepo.updateQueueEntry(entry.id, { status: 'done', percent: 100, completedAt: new Date().toISOString(), error: null });
      markAsSynced(entry, settings, entry.fileId);
      emitProgress(entry.id, entry.localRelPath, 'done', 100);
      logger.info('upload-queue', `Already on server, marked synced: ${entry.localRelPath}`);
      succeeded = true;
    } else {
      if (isStaleSessionError(msg)) {
        clearUploadSession(entry.id);
      }
      logger.error('upload-queue', `Upload failed for ${entry.localRelPath}: ${msg}`);
      if (entry.retryCount + 1 >= entry.maxRetries) {
        queueRepo.updateQueueEntry(entry.id, { status: 'error', error: msg, retryCount: entry.retryCount + 1 });
        emitProgress(entry.id, entry.localRelPath, 'error', 0);
      } else {
        queueRepo.updateQueueEntry(entry.id, { status: 'pending', error: msg, retryCount: entry.retryCount + 1 });
        emitProgress(entry.id, entry.localRelPath, 'pending', 0);
      }
      const backoffMs = isStaleSessionError(msg)
        ? 2000
        : Math.min(30000, 2000 * Math.pow(2, Math.min(entry.retryCount, 4)));
      scheduleRetry(backoffMs);
    }
  } finally {
    processing = false;
    if (succeeded) kickQueue();
  }
}

function computeChunkSize(fileSize: number): number {
  if (fileSize < 50 * 1024 * 1024) return 1024 * 1024;
  if (fileSize < 500 * 1024 * 1024) return 2 * 1024 * 1024;
  if (fileSize < 2 * 1024 * 1024 * 1024) return 5 * 1024 * 1024;
  return 10 * 1024 * 1024;
}

function guessMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  const map: Record<string, string> = {
    '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
    '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.m4v': 'video/x-m4v',
    '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav',
    '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
    '.json': 'application/json', '.txt': 'text/plain', '.zip': 'application/zip',
  };
  return map[ext] || 'application/octet-stream';
}

async function ensureFolderOnServer(api: VaultApiClient, parentPath: string): Promise<void> {
  if (parentPath === '/' || !parentPath) return;
  if (ensuredFolderPaths.has(parentPath)) return;

  const segments = parentPath.replace(/^\//, '').split('/').filter(Boolean);
  let current = '/';
  for (const seg of segments) {
    const folderPath = current === '/' ? `/${seg}` : `${current}/${seg}`;
    if (!ensuredFolderPaths.has(folderPath)) {
      const result = await api.createFolder(seg, current);
      if (!result.ok) {
        const msg = result.error.message || `HTTP ${result.error.status}`;
        if (!msg.includes('already exists')) {
          logger.warn('upload-queue', `Folder create "${seg}" in "${current}" failed: ${msg}`);
        }
      }
      ensuredFolderPaths.add(folderPath);
    }
    current = folderPath;
  }
  ensuredFolderPaths.add(parentPath);
}

async function resolveRemoteFileId(
  api: VaultApiClient,
  fileName: string,
  parentPath: string,
  size: number,
): Promise<string | null> {
  const list = await api.listFiles(parentPath, 500, 0);
  if (!list.ok) return null;
  const match = list.value.files.find((file) => {
    const isFolder = !!(file.isFolder || (file as { is_folder?: boolean }).is_folder);
    return !isFolder && file.name === fileName && file.size === size;
  });
  return match?.id ?? null;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function uploadEntrySeamless(
  entryIn: { id: number; fileId: string | null; taskId: string | null; localRelPath: string; localHash: string; size: number; mimeType: string | null; retryCount: number; maxRetries: number },
  settings: ReturnType<typeof getSettings>,
): Promise<void> {
  let entry = entryIn;
  const normalizedRel = normalizeRelPath(entry.localRelPath);
  const absPath = absPathFromStored(settings, normalizedRel);

  if (!absPath || !fs.existsSync(absPath)) {
    queueRepo.updateQueueEntry(entry.id, { status: 'error', error: 'File no longer exists' });
    return;
  }

  const stat = fs.statSync(absPath);
  if (stat.size === 0) {
    queueRepo.updateQueueEntry(entry.id, { status: 'error', error: 'Empty file (0 bytes) cannot be uploaded' });
    emitProgress(entry.id, entry.localRelPath, 'error', 0);
    return;
  }
  if (stat.size !== entry.size) {
    queueRepo.updateQueueEntry(entry.id, { size: stat.size, error: null });
    entry = { ...entry, size: stat.size };
  }

  const api = new VaultApiClient({ serverUrl: settings.serverUrl, apiKey: settings.apiKey });
  const fileName = normalizedRel.split('/').filter(Boolean).pop() || entry.localRelPath;
  const parentPath = remoteParentFromStored(settings, normalizedRel);
  const mimeType = entry.mimeType || guessMimeType(fileName);
  const chunkSize = computeChunkSize(stat.size);

  if (parentPath && parentPath !== '/') {
    await ensureFolderOnServer(api, parentPath);
  }

  const remoteId = entry.fileId ? null : await resolveRemoteFileId(api, fileName, parentPath, stat.size);
  if (remoteId) {
    queueRepo.updateQueueEntry(entry.id, { status: 'done', percent: 100, fileId: remoteId, completedAt: new Date().toISOString() });
    markAsSynced(entry, settings, remoteId);
    emitProgress(entry.id, entry.localRelPath, 'done', 100);
    logger.info('upload-queue', `Matched existing remote file: ${entry.localRelPath}`);
    return;
  }

  queueRepo.updateQueueEntry(entry.id, { status: 'uploading', startedAt: new Date().toISOString() });
  emitProgress(entry.id, entry.localRelPath, 'uploading', 0);

  const isVideo = mimeType.startsWith('video/') || /\.(mp4|webm|mkv|avi|mov|m4v)$/i.test(fileName);
  const convertHls = isVideo && /\.mp4$/i.test(fileName);

  let initResult = await api.seamlessInit({
    fileName,
    parentPath,
    size: stat.size,
    mimeType,
    chunkSize,
    convertHls,
    replaceFileId: entry.fileId || undefined,
  });

  if (!initResult.ok && isStaleSessionError(initResult.error.message)) {
    clearUploadSession(entry.id);
    initResult = await api.seamlessInit({
      fileName,
      parentPath,
      size: stat.size,
      mimeType,
      chunkSize,
      convertHls,
      replaceFileId: entry.fileId || undefined,
    });
  }

  if (!initResult.ok) {
    throw new Error(`Seamless init failed: ${initResult.error.message}`);
  }

  const { fileId, jobId, totalParts, partSize } = initResult.value;
  queueRepo.updateQueueEntry(entry.id, { fileId, taskId: jobId });
  logger.info('upload-queue', `Seamless upload started: ${entry.localRelPath} — ${totalParts} parts`);

  let statusResult = await api.seamlessStatus(fileId);
  let nextPart = 0;
  if (statusResult.ok && statusResult.value.stagingComplete) {
    logger.info('upload-queue', `Server cache already complete for ${entry.localRelPath}, resuming processing`);
    await api.resumeTask(jobId).catch(() => {});
    await api.seamlessResume(fileId, jobId, convertHls);
    return waitForServerProcessing(entry, api, jobId, fileName, stat);
  } else if (statusResult.ok && statusResult.value.nextPart) {
    nextPart = statusResult.value.nextPart;
  }

  let uploadedBytes = 0;
  let partsDone = nextPart;
  const startTime = Date.now();

  for (let partIndex = nextPart; partIndex < totalParts; partIndex++) {
    const start = partIndex * partSize;
    const length = Math.min(partSize, stat.size - start);
    const buffer = Buffer.alloc(length);
    const fd = await fs.promises.open(absPath, 'r');
    try {
      await fd.read(buffer, 0, length, start);
    } finally {
      await fd.close();
    }

    let lastErr: unknown;
    let success = false;
    for (let attempt = 1; attempt <= MAX_PART_RETRIES; attempt++) {
      try {
        const partResult = await api.seamlessPart(fileId, partIndex, buffer, jobId);
        if (!partResult.ok) {
          if (partResult.error.status === 409) {
            throw new Error('Upload paused on server');
          }
          lastErr = new Error(partResult.error.message);
        } else {
          uploadedBytes += buffer.length;
          partsDone = Math.max(partsDone, partResult.value.partsDone || partIndex + 1);
          const elapsed = (Date.now() - startTime) / 1000;
          const speed = elapsed > 0 ? uploadedBytes / elapsed : 0;
          const pct = Math.round((partsDone / totalParts) * 35);
          emitProgress(entry.id, entry.localRelPath, 'uploading', pct);
          success = true;
          break;
        }
      } catch (e: unknown) {
        lastErr = e;
        if (e instanceof Error && e.message.includes('paused')) throw e;
      }
      await sleep(Math.min(2000 * attempt, 15000));
    }
    if (!success) {
      throw lastErr instanceof Error ? lastErr : new Error(`Part ${partIndex} upload failed`);
    }
  }

  const completeResult = await api.seamlessComplete(fileId, jobId, convertHls);
  if (!completeResult.ok) {
    throw new Error(`Seamless complete failed: ${completeResult.error.message}`);
  }

  logger.info('upload-queue', `All parts cached for ${entry.localRelPath}, waiting for server processing`);
  return waitForServerProcessing(entry, api, jobId, fileName, stat);
}

async function waitForServerProcessing(
  entry: { id: number; localRelPath: string },
  api: VaultApiClient,
  jobId: string,
  fileName: string,
  stat: fs.Stats,
): Promise<void> {
  for (;;) {
    await sleep(POLL_INTERVAL_MS);
    const taskResult = await api.getTask(jobId);
    if (!taskResult.ok) continue;

    const task = taskResult.value as any;
    const pct = task.percent || 0;
    emitProgress(entry.id, entry.localRelPath, 'uploading', pct);

    if (task.status === 'done') {
      finalizeSuccess(entry, fileName, stat, task.fileId || null);
      return;
    }
    if (task.status === 'error') {
      throw new Error(task.error || 'Server processing failed');
    }
    if (task.status === 'cancelled') {
      throw new Error('Upload cancelled on server');
    }
  }
}

function finalizeSuccess(
  entry: { id: number; localRelPath: string; localHash?: string },
  fileName: string,
  stat: fs.Stats,
  remoteFileId: string | null,
): void {
  const settings = getSettings();
  const normalizedRel = normalizeRelPath(entry.localRelPath);
  const remotePath = remotePathFromStored(settings, normalizedRel);
  queueRepo.updateQueueEntry(entry.id, { status: 'done', percent: 100, completedAt: new Date().toISOString() });
  fileTreeRepo.upsertFile(getDatabase(), {
    fileId: remoteFileId,
    localRelPath: normalizeRelPath(entry.localRelPath),
    remotePath,
    name: fileName,
    size: stat.size,
    mimeType: null,
    isFolder: false,
    localMtimeMs: stat.mtimeMs,
    localHash: entry.localHash ?? null,
    remoteHash: null,
    remoteUpdatedAt: new Date().toISOString(),
    syncStatus: 'synced',
    syncTaskId: null,
    syncError: null,
  });
  emitProgress(entry.id, entry.localRelPath, 'done', 100);
  logger.info('upload-queue', `Upload complete: ${entry.localRelPath}`);
}

function markAsSynced(
  entry: { id: number; localRelPath: string; localHash?: string },
  settings: ReturnType<typeof getSettings>,
  remoteFileId: string | null = null,
): void {
  const normalizedRel = normalizeRelPath(entry.localRelPath);
  const absPath = absPathFromStored(settings, normalizedRel);
  let stat: fs.Stats | null = null;
  try { if (absPath) stat = fs.statSync(absPath); } catch {}
  const fileName = normalizedRel.split('/').filter(Boolean).pop() || normalizedRel;
  const remotePath = remotePathFromStored(settings, normalizedRel);
  fileTreeRepo.upsertFile(getDatabase(), {
    fileId: remoteFileId,
    localRelPath: normalizedRel,
    remotePath,
    name: fileName,
    size: stat?.size ?? 0,
    mimeType: null,
    isFolder: false,
    localMtimeMs: stat?.mtimeMs ?? null,
    localHash: entry.localHash ?? null,
    remoteHash: null,
    remoteUpdatedAt: new Date().toISOString(),
    syncStatus: 'synced',
    syncTaskId: null,
    syncError: null,
  });
}

function emitProgress(id: number, localRelPath: string, status: string, percent: number): void {
  if (onProgress) onProgress({ id, localRelPath, status, percent });
}
