import path from 'path';
import fs from 'fs';
import { getDatabase } from '../db/database';
import * as queueRepo from '../db/queue-repo';
import * as fileTreeRepo from '../db/file-tree-repo';
import { getSettings } from '../db/settings-repo';
import { VaultApiClient } from './api-client';
import { computeFileHash } from '../services/hasher';
import { logger } from '../services/logger';

const CHUNK_SIZE = 1024 * 1024;
const MAX_FILE_SIZE_SIMPLE = 50 * 1024 * 1024;

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
    queueRepo.updateQueueEntry(entry.id, { status: 'pending', error: msg, retryCount: entry.retryCount + 1 });
    emitProgress(entry.id, entry.localRelPath, 'pending', 0);
  } finally {
    processing = false;
    setTimeout(() => processNext(), 1000);
  }
}

async function uploadEntry(
  entry: { id: number; fileId: string | null; localRelPath: string; localHash: string; size: number; mimeType: string | null; retryCount: number; maxRetries: number },
  settings: ReturnType<typeof getSettings>,
): Promise<void> {
  const absPath = path.join(settings.syncRootPath, entry.localRelPath);

  if (!fs.existsSync(absPath)) {
    queueRepo.updateQueueEntry(entry.id, { status: 'error', error: 'File no longer exists' });
    return;
  }

  const stat = fs.statSync(absPath);
  if (stat.size !== entry.size) {
    queueRepo.updateQueueEntry(entry.id, { status: 'pending', error: 'File size changed, will re-queue' });
    return;
  }

  const api = new VaultApiClient({ serverUrl: settings.serverUrl, apiKey: settings.apiKey });

  queueRepo.updateQueueEntry(entry.id, { status: 'hashing', startedAt: new Date().toISOString() });
  emitProgress(entry.id, entry.localRelPath, 'hashing', 0);

  const hash = await computeFileHash(absPath).catch(() => null);
  if (!hash || hash !== entry.localHash) {
    const retry = entry.retryCount + 1;
    if (retry > entry.maxRetries) {
      queueRepo.updateQueueEntry(entry.id, { status: 'error', error: 'Hash mismatch', retryCount: retry });
      fileTreeRepo.upsertFile(getDatabase(), {
        fileId: null, localRelPath: entry.localRelPath, remotePath: null,
        name: path.basename(entry.localRelPath), size: entry.size, mimeType: entry.mimeType || null,
        isFolder: false, localMtimeMs: stat.mtimeMs, localHash: hash,
        remoteHash: null, remoteUpdatedAt: null, syncStatus: 'error', syncTaskId: null, syncError: 'Hash mismatch',
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

  const fileName = path.basename(entry.localRelPath);

  if (stat.size <= MAX_FILE_SIZE_SIMPLE) {
    await uploadSimple(entry, api, absPath, fileName, hash, stat);
  } else {
    await uploadChunked(entry, api, absPath, fileName, hash, stat);
  }
}

async function uploadSimple(
  entry: { id: number; localRelPath: string; mimeType: string | null },
  api: VaultApiClient,
  absPath: string,
  fileName: string,
  hash: string,
  stat: fs.Stats,
): Promise<void> {
  const buf = fs.readFileSync(absPath);
  const result = await api.uploadFile(buf, fileName, '/', CHUNK_SIZE);

  if (!result.ok) {
    throw new Error(`Upload failed: ${result.error.message}`);
  }

  const jobId = result.value.jobId;

  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const progress = await api.getUploadProgress(jobId);
    if (!progress.ok) continue;
    const p = progress.value;
    emitProgress(entry.id, entry.localRelPath, 'uploading', p.percent || 0);

    if (p.status === 'done') {
      finalizeSuccess(entry, fileName, hash, stat, null);
      return;
    }
    if (p.status === 'error') {
      throw new Error(p.error || 'Upload failed on server');
    }
  }

  throw new Error('Upload timed out waiting for server completion');
}

async function uploadChunked(
  entry: { id: number; localRelPath: string; mimeType: string | null; fileId: string | null },
  api: VaultApiClient,
  absPath: string,
  fileName: string,
  hash: string,
  stat: fs.Stats,
): Promise<void> {
  const mimeType = entry.mimeType || guessMime(fileName);

  const initResult = await api.uploadInit(fileName, '/', stat.size, mimeType);
  if (!initResult.ok) {
    throw new Error(`Upload init failed: ${initResult.error.message}`);
  }

  const { fileId, jobId, totalChunks, chunkSize } = initResult.value;
  queueRepo.updateQueueEntry(entry.id, { fileId, taskId: jobId });

  const fileHandle = await fs.promises.open(absPath, 'r');
  let lastPercent = 0;

  try {
    for (let i = 0; i < totalChunks; i++) {
      const offset = i * chunkSize;
      const size = Math.min(chunkSize, stat.size - offset);
      const chunkBuf = Buffer.alloc(size);
      await fileHandle.read(chunkBuf, 0, size, offset);

      const chunkResult = await api.uploadChunk(fileId, i, chunkBuf, jobId);
      if (!chunkResult.ok) {
        throw new Error(`Chunk ${i} upload failed: ${chunkResult.error.message}`);
      }

      const pct = Math.round((chunkResult.value.chunksDone / chunkResult.value.totalChunks) * 100);
      if (pct !== lastPercent) {
        lastPercent = pct;
        emitProgress(entry.id, entry.localRelPath, 'uploading', pct);
      }
    }
  } finally {
    await fileHandle.close();
  }

  const completeResult = await api.uploadComplete(fileId, jobId);
  if (!completeResult.ok) {
    throw new Error(`Upload complete failed: ${completeResult.error.message}`);
  }

  finalizeSuccess(entry, fileName, hash, stat, completeResult.value.id);
}

function finalizeSuccess(
  entry: { id: number; localRelPath: string },
  fileName: string,
  hash: string,
  stat: fs.Stats,
  remoteFileId: string | null,
): void {
  const remotePath = '/' + entry.localRelPath.replace(/\\/g, '/');
  queueRepo.updateQueueEntry(entry.id, { status: 'done', percent: 100, completedAt: new Date().toISOString() });
  fileTreeRepo.upsertFile(getDatabase(), {
    fileId: remoteFileId,
    localRelPath: entry.localRelPath,
    remotePath,
    name: fileName,
    size: stat.size,
    mimeType: null,
    isFolder: false,
    localMtimeMs: stat.mtimeMs,
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function guessMime(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  const map: Record<string, string> = {
    '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.mkv': 'video/x-matroska',
    '.webm': 'video/webm', '.avi': 'video/x-msvideo', '.mov': 'video/quicktime',
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.pdf': 'application/pdf', '.zip': 'application/zip',
    '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4', '.aac': 'audio/aac',
  };
  return map[ext] || 'application/octet-stream';
}

function emitProgress(id: number, localRelPath: string, status: string, percent: number): void {
  if (onProgress) onProgress({ id, localRelPath, status, percent });
}
