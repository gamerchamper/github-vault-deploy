import path from 'path';
import fs from 'fs';
import { getDatabase } from '../db/database';
import * as fileTreeRepo from '../db/file-tree-repo';
import * as queueRepo from '../db/queue-repo';
import { getSettings, updateSettings } from '../db/settings-repo';
import { VaultApiClient } from './api-client';
import { RemoteListingCache } from './remote-listing-cache';
import { computeFileHash } from '../services/hasher';
import { logger } from '../services/logger';
import { normalizeRelPath, toAbsPath, parentPathFromRel } from '../services/paths';
import {
  absPathFromStored,
  getEnabledAdditionalFolders,
  listRemoteWalkRoots,
  remoteParentFromStored,
  remotePathFromStored,
  remotePathToStored,
  toAdditionalStoredRel,
  findMapping,
  SYNC_CONTAINER_NAME,
} from '../services/sync-mappings';
import {
  applyPathChange,
  buildHashIndexKey,
  detectRenamesFromScan,
  trackPendingRemoval,
  tryResolvePendingRename,
} from './rename-sync';
import { syncLocalFolder, syncLocalOnlyFolders, registerAdditionalFolderRoots } from './folder-sync';
import type { SyncFileEntry, SyncState, FileEntry } from '../shared/types';

const YIELD_EVERY_FILES = 20;

const IGNORE_FILE_NAMES = new Set([
  'desktop.ini',
  'thumbs.db',
  '.ds_store',
]);

const IGNORE_FILE_PATTERNS = [
  /^~\$/,
  /\.tmp$/i,
  /\.part$/i,
  /\.crdownload$/i,
  /^\.vault-/,
];

let running = false;
let syncTimer: NodeJS.Timeout | null = null;
let cycleRunning = false;
let currentState: SyncState = { status: 'idle', lastSyncAt: null, lastError: null, pendingUploads: 0, pendingDownloads: 0, conflictCount: 0, totalFiles: 0 };
let onStateChange: ((state: SyncState) => void) | null = null;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function shouldIgnoreScanFile(name: string): boolean {
  if (name.startsWith('.vault-')) return true;
  if (name.startsWith('~$')) return true;
  if (IGNORE_FILE_NAMES.has(name.toLowerCase())) return true;
  return IGNORE_FILE_PATTERNS.some((re) => re.test(name));
}

export function getSyncState(): SyncState {
  return { ...currentState };
}

export function onSyncStateChange(cb: (state: SyncState) => void): void {
  onStateChange = cb;
}

/** Handle watcher events (rename detection, scan). */
export async function handleWatcherEvent(event: string, relPath: string): Promise<void> {
  const normalized = normalizeRelPath(relPath);

  if (event === 'unlink' || event === 'unlinkDir') {
    trackPendingRemoval(normalized, event === 'unlinkDir');
    return;
  }

  if (event === 'add' || event === 'addDir') {
    const resolved = await tryResolvePendingRename(normalized, event === 'addDir');
    if (!resolved) {
      if (event === 'add') {
        await scanLocalFile(normalized);
      } else {
        await syncLocalFolder(normalized);
      }
    }
    updateCounts();
    return;
  }

  if (event === 'change') {
    await scanLocalFile(normalized);
  }
}

/** Scan one file (watcher / manual refresh) and queue if needed. */
export async function scanLocalFile(relPath: string): Promise<void> {
  const settings = getSettings();
  if (!settings.serverUrl || !settings.apiKey) return;
  const normalized = normalizeRelPath(relPath);
  const absPath = absPathFromStored(settings, normalized);
  if (!absPath || !fs.existsSync(absPath) || fs.statSync(absPath).isDirectory()) return;
  const api = new VaultApiClient({ serverUrl: settings.serverUrl, apiKey: settings.apiKey });
  const remoteCache = new RemoteListingCache(api);
  await validateAndQueueFile(path.dirname(absPath), path.basename(absPath), normalized, remoteCache);
  updateCounts();
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

export async function runSyncCycleNow(): Promise<void> {
  await runSyncCycle();
}

/** Immediate scan + upload for one additional PC folder (does not wait on full sync cycle). */
export async function scanAdditionalFolderNow(mappingId: string): Promise<void> {
  const settings = getSettings();
  if (!settings.serverUrl || !settings.apiKey) {
    logger.warn('sync', 'Cannot scan additional folder — not authenticated');
    return;
  }

  const mapping = findMapping(settings, mappingId);
  if (!mapping?.localPath || !fs.existsSync(mapping.localPath)) {
    logger.warn('sync', `Additional folder not found: ${mappingId}`);
    return;
  }

  logger.info('sync', `Scanning additional folder: ${mapping.localPath} → /Sync Folder/${mapping.name}`);
  const api = new VaultApiClient({ serverUrl: settings.serverUrl, apiKey: settings.apiKey });
  const remoteCache = new RemoteListingCache(api);

  const { ensureSyncContainerOnServer } = await import('./folder-sync');
  await ensureSyncContainerOnServer(api);
  await registerAdditionalFolderRoots();
  await syncLocalFolder(toAdditionalStoredRel(mappingId, ''), remoteCache);

  const beforeQueue = queueRepo.getActiveCount();
  await scanLocalFiles(settings, remoteCache);
  await syncLocalOnlyFolders(remoteCache);
  await enqueueAllLocalOnly(settings, remoteCache);
  const afterQueue = queueRepo.getActiveCount();

  updateCounts();
  logger.info('sync', `Additional folder scan done: ${mapping.name} (${afterQueue - beforeQueue} new queue item(s))`);
}

async function runSyncCycle(): Promise<void> {
  if (cycleRunning) {
    logger.info('sync', 'Sync cycle skipped — previous cycle still running');
    return;
  }

  const settings = getSettings();
  if (!settings.serverUrl || !settings.apiKey) {
    emitState({ status: 'idle', lastError: 'Not authenticated' });
    return;
  }

  cycleRunning = true;
  emitState({ status: 'syncing' });
  const api = new VaultApiClient({ serverUrl: settings.serverUrl, apiKey: settings.apiKey });
  const remoteCache = new RemoteListingCache(api);
  logger.info('sync', 'Starting sync cycle');

  try {
    await registerAdditionalFolderRoots();
    // Scan local files first so new additional folders upload without waiting for full remote walk.
    await scanLocalFiles(settings, remoteCache);
    await syncLocalOnlyFolders(remoteCache);
    await enqueueAllLocalOnly(settings, remoteCache);
    await syncRemoteMetadata(api, settings);
    await reconcileOutstandingUploads(settings, remoteCache);
    updateCounts();
    updateSettings({ lastSyncCursor: new Date().toISOString() });
    emitState({ status: 'idle', lastSyncAt: new Date().toISOString(), lastError: null });
    logger.info('sync', 'Sync cycle complete');
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error('sync', `Sync cycle failed: ${msg}`);
    emitState({ status: 'error', lastError: msg });
  } finally {
    cycleRunning = false;
  }
}

async function syncRemoteMetadata(api: VaultApiClient, settings: ReturnType<typeof getSettings>): Promise<void> {
  const db = getDatabase();
  const walkRoots = listRemoteWalkRoots(settings);

  async function walkFolder(folderPath: string): Promise<void> {
    const result = await api.listFiles(folderPath, 500, 0);
    if (!result.ok) {
      logger.error('sync', `Failed to list ${folderPath}: ${result.error.message}`);
      return;
    }

    for (const file of result.value.files) {
      const isFolder = !!(file.isFolder || file.is_folder);
      const storedRel = remotePathToStored(settings, file.path);
      if (storedRel === null) continue;
      const normalizedRel = normalizeRelPath(storedRel);
      const absPath = absPathFromStored(settings, normalizedRel);

      const existing = fileTreeRepo.getFileByRelPath(normalizedRel);
      const existsLocally = absPath && fs.existsSync(absPath)
        && (isFolder ? fs.statSync(absPath).isDirectory() : fs.statSync(absPath).isFile());
      let syncStatus: SyncFileEntry['syncStatus'];
      if (isFolder) {
        syncStatus = existsLocally ? 'synced' : 'remote_only';
      } else {
        syncStatus = existing?.syncStatus ?? 'remote_only';
        if (existsLocally && existing?.syncStatus === 'synced') {
          syncStatus = 'synced';
        } else if (existsLocally && (syncStatus === 'remote_only' || syncStatus === 'local_only')) {
          syncStatus = 'synced';
        }
      }
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
        syncStatus,
        syncTaskId: existing?.syncTaskId ?? null,
        syncError: null,
      };

      fileTreeRepo.upsertFile(db, syncEntry);

      if (!isFolder && !existing && absPath) {
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
          const storedRel = remotePathToStored(settings, file.path);
          if (storedRel === null) continue;
          const normalizedRel = normalizeRelPath(storedRel);
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
            syncStatus: existing?.syncStatus === 'synced' ? 'synced' : (existing ? existing.syncStatus : 'remote_only'),
            syncTaskId: existing?.syncTaskId ?? null,
            syncError: null,
          });
        }
      }
    }

    for (const file of result.value.files) {
      const isFolder = !!(file.isFolder || file.is_folder);
      if (isFolder) {
        const base = folderPath === '/' ? '' : folderPath;
        const syncFolderPath = `/${SYNC_CONTAINER_NAME}`;
        if (base === '' && file.path === syncFolderPath) {
          continue;
        }
        if (file.path === syncFolderPath || file.path.startsWith(`${syncFolderPath}/`)) {
          continue;
        }
        await walkFolder(file.path);
      }
    }
  }

  for (const root of walkRoots) {
    await walkFolder(root);
  }

  const allFiles = fileTreeRepo.getAllFiles();
  const byName = new Map<string, typeof allFiles[number]>();
  for (const f of allFiles) {
    const key = normalizeRelPath(f.localRelPath);
    const prev = byName.get(key);
    if (!prev) {
      byName.set(key, f);
    } else if (prev.syncStatus === 'local_only' && f.syncStatus !== 'local_only') {
      byName.set(key, f);
    }
  }
  for (const f of allFiles) {
    const key = normalizeRelPath(f.localRelPath);
    const canonical = byName.get(key);
    if (canonical && canonical.localRelPath !== f.localRelPath) {
      fileTreeRepo.deleteFileEntry(f.localRelPath);
    }
  }
}

async function reconcileOutstandingUploads(
  settings: ReturnType<typeof getSettings>,
  remoteCache: RemoteListingCache,
): Promise<void> {
  const db = getDatabase();
  let reset = 0;

  const phantoms = fileTreeRepo.getAllFiles().filter((f) => !f.isFolder && f.syncStatus === 'synced' && !f.fileId);
  for (const file of phantoms) {
    fileTreeRepo.upsertFile(db, { ...file, syncStatus: 'local_only', fileId: null, syncError: null });
    reset += 1;
  }

  const localOnly = fileTreeRepo.getFilesByStatus('local_only').filter((f) => !f.isFolder);
  for (const file of localOnly) {
    const absPath = absPathFromStored(settings, file.localRelPath);
    if (!absPath || !fs.existsSync(absPath)) continue;
    queueRepo.requeuePathIfFailed(file.localRelPath);
    if (queueRepo.hasActiveQueueEntry(file.localRelPath)) continue;
    await uploadLocalOnlyFile(absPath, file.localRelPath, file, remoteCache);
  }

  const synced = fileTreeRepo.getFilesByStatus('synced').filter((f) => !f.isFolder && f.fileId);
  for (const file of synced) {
    const absPath = absPathFromStored(settings, file.localRelPath);
    if (!absPath || !fs.existsSync(absPath)) continue;
    const parentPath = remoteParentFromStored(settings, file.localRelPath);
    const onServer = await remoteCache.hasFileId(parentPath, file.fileId!);
    if (onServer === false) {
      fileTreeRepo.upsertFile(db, { ...file, syncStatus: 'local_only', fileId: null, syncError: null });
      reset += 1;
      if (!queueRepo.hasActiveQueueEntry(file.localRelPath)) {
        await validateAndQueueFile(
          path.dirname(absPath),
          path.basename(absPath),
          file.localRelPath,
          remoteCache,
        );
      }
    }
  }

  if (reset > 0) {
    logger.info('sync', `Reset ${reset} phantom synced entries — will re-upload`);
  }
}

async function scanLocalFiles(settings: ReturnType<typeof getSettings>, remoteCache: RemoteListingCache): Promise<void> {
  const db = getDatabase();
  const known = new Set(fileTreeRepo.getAllFiles().map((f) => normalizeRelPath(f.localRelPath)));
  const seen = new Set<string>();
  const hashIndex = new Map<string, string>();
  let scanned = 0;

  async function walk(dir: string, relDir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn('sync', `Cannot read local folder ${dir}: ${msg}`);
      return;
    }

    for (const entry of entries) {
      if (shouldIgnoreScanFile(entry.name)) continue;

      const relPath = relDir
        ? `${normalizeRelPath(relDir)}/${entry.name}`
        : entry.name;
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
        await walk(path.join(dir, entry.name), relPath);
      } else {
        scanned += 1;
        if (scanned % YIELD_EVERY_FILES === 0) {
          await yieldToEventLoop();
        }
        await validateAndQueueFile(dir, entry.name, relPath, remoteCache, hashIndex);
      }
    }
  }

  if (settings.syncRootPath) {
    await walk(settings.syncRootPath, '');
  }

  for (const mapping of getEnabledAdditionalFolders(settings)) {
    if (!mapping.localPath || !fs.existsSync(mapping.localPath)) continue;
    const rootStored = toAdditionalStoredRel(mapping.id, '');
    seen.add(normalizeRelPath(rootStored));
    logger.info('sync', `Walking additional folder: ${mapping.localPath}`);
    await walk(mapping.localPath, rootStored);
  }

  await detectRenamesFromScan(settings, hashIndex, known, seen);

  for (const filePath of known) {
    if (!seen.has(filePath)) {
      const existing = fileTreeRepo.getFileByRelPath(filePath);
      if (existing && existing.syncStatus === 'synced' && existing.isFolder) {
        continue;
      }
      const abs = absPathFromStored(settings, filePath);
      if (abs && fs.existsSync(abs)) continue;
      if (existing && (existing.syncStatus === 'synced' || existing.syncStatus === 'local_only') && !existing.isFolder) {
        logger.info('sync', `Local file deleted: ${filePath}`);
        fileTreeRepo.upsertFile(db, { ...existing, syncStatus: 'deleted' });
      }
    }
  }
}

function markSyncedFromRemote(
  relPath: string,
  name: string,
  stat: fs.Stats,
  remote: FileEntry,
  existing: SyncFileEntry | null,
  localHash: string | null,
): void {
  fileTreeRepo.upsertFile(getDatabase(), {
    fileId: remote.id,
    localRelPath: relPath,
    remotePath: remote.path,
    name,
    size: stat.size,
    mimeType: existing?.mimeType ?? remote.mimeType ?? null,
    isFolder: false,
    localMtimeMs: stat.mtimeMs,
    localHash,
    remoteHash: remote.contentHash,
    remoteUpdatedAt: remote.updatedAt,
    syncStatus: 'synced',
    syncTaskId: null,
    syncError: null,
  });
}

async function tryMarkSyncedFromRemote(
  relPath: string,
  name: string,
  stat: fs.Stats,
  existing: SyncFileEntry | null,
  remoteCache: RemoteListingCache,
): Promise<boolean> {
  const settings = getSettings();
  const parentPath = remoteParentFromStored(settings, relPath);
  const remoteMatch = await remoteCache.findByNameAndSize(parentPath, name, stat.size);
  if (!remoteMatch) return false;
  const localHash = existing?.localHash
    ?? (existing?.localMtimeMs === stat.mtimeMs
      ? null
      : await computeFileHash(absPathFromStored(settings, relPath)!).catch(() => null));
  markSyncedFromRemote(relPath, name, stat, remoteMatch, existing, localHash);
  return true;
}

async function queueFileForUpload(
  relPath: string,
  name: string,
  stat: fs.Stats,
  existing: SyncFileEntry | null,
  opts: { priority?: number; logMessage?: string },
): Promise<void> {
  const settings = getSettings();
  const normalizedRel = normalizeRelPath(relPath);
  const absPath = absPathFromStored(settings, normalizedRel);
  if (!absPath) return;
  const hash = existing?.localHash ?? await computeFileHash(absPath).catch(() => null);
  if (!hash) {
    logger.warn('sync', `Could not hash file for upload: ${normalizedRel}`);
    return;
  }

  fileTreeRepo.upsertFile(getDatabase(), {
    fileId: existing?.fileId ?? null,
    localRelPath: normalizedRel,
    remotePath: existing?.remotePath ?? remotePathFromStored(settings, normalizedRel),
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

  if (!queueRepo.hasActiveQueueEntry(normalizedRel)) {
    const queueId = queueRepo.addToQueue({
      fileId: existing?.fileId ?? null,
      localRelPath: normalizedRel,
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
      priority: opts.priority ?? 0,
    });
    if (queueId > 0 && opts.logMessage) {
      logger.info('sync', `${opts.logMessage}: ${normalizedRel}`);
    }
  }
}

async function uploadLocalOnlyFile(
  absPath: string,
  relPath: string,
  existing: SyncFileEntry,
  remoteCache: RemoteListingCache,
): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return;
  }
  if (stat.size === 0) return;

  const name = path.basename(relPath);
  if (await tryMarkSyncedFromRemote(relPath, name, stat, existing, remoteCache)) {
    return;
  }

  await queueFileForUpload(relPath, name, stat, existing, {
    priority: 10,
    logMessage: 'Uploading local-only file',
  });
}

async function enqueueAllLocalOnly(settings: ReturnType<typeof getSettings>, remoteCache: RemoteListingCache): Promise<void> {
  const localOnly = fileTreeRepo.getFilesByStatus('local_only').filter((f) => !f.isFolder);
  let queued = 0;
  let skippedMissing = 0;
  let skippedQueued = 0;

  for (const file of localOnly) {
    const normalizedRel = normalizeRelPath(file.localRelPath);
    const absPath = absPathFromStored(settings, normalizedRel);
    if (!absPath || !fs.existsSync(absPath)) {
      skippedMissing += 1;
      continue;
    }
    queueRepo.requeuePathIfFailed(normalizedRel);
    if (queueRepo.hasActiveQueueEntry(normalizedRel)) {
      skippedQueued += 1;
      continue;
    }

    const before = queueRepo.hasActiveQueueEntry(normalizedRel);
    await uploadLocalOnlyFile(absPath, normalizedRel, file, remoteCache);
    if (!before && queueRepo.hasActiveQueueEntry(normalizedRel)) {
      queued += 1;
    }
  }

  logger.info('sync', `Local-only: ${localOnly.length} file(s), queued ${queued}, already queued ${skippedQueued}, missing ${skippedMissing}`);
}

async function validateAndQueueFile(
  dir: string,
  name: string,
  relPath: string,
  remoteCache: RemoteListingCache,
  hashIndex?: Map<string, string>,
): Promise<void> {
  const absPath = path.join(dir, name);
  const existing = fileTreeRepo.getFileByRelPath(relPath);

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return;
  }

  if (stat.size === 0) return;
  if (queueRepo.hasActiveQueueEntry(relPath)) return;

  if (existing?.syncStatus === 'synced' && existing.fileId && existing.size === stat.size) {
    return;
  }

  if (await tryMarkSyncedFromRemote(relPath, name, stat, existing, remoteCache)) {
    return;
  }

  if (existing?.syncStatus === 'local_only') {
    await queueFileForUpload(relPath, name, stat, existing, {
      priority: 10,
      logMessage: 'Uploading local-only file',
    });
    return;
  }

  if (existing?.syncStatus === 'synced') {
    if (
      existing.fileId
      && existing.localHash
      && existing.localMtimeMs === stat.mtimeMs
      && existing.size === stat.size
    ) {
      return;
    }
    if (existing.localHash && existing.fileId) {
      const hash = await computeFileHash(absPath).catch(() => null);
      if (hash && existing.localHash === hash) {
        if (existing.localMtimeMs !== stat.mtimeMs || existing.size !== stat.size) {
          fileTreeRepo.upsertFile(getDatabase(), {
            ...existing,
            localMtimeMs: stat.mtimeMs,
            size: stat.size,
          });
        }
        return;
      }
    }
  }

  const hash = await computeFileHash(absPath).catch(() => null);
  if (!hash) return;

  if (hashIndex) {
    hashIndex.set(buildHashIndexKey(hash, stat.size), normalizeRelPath(relPath));
  }

  const dupEntry = fileTreeRepo.getFileByHash(hash, relPath);
  if (dupEntry && dupEntry.fileId && dupEntry.syncStatus === 'synced' && normalizeRelPath(dupEntry.localRelPath) !== normalizeRelPath(relPath)) {
    const oldAbs = absPathFromStored(getSettings(), dupEntry.localRelPath);
    if (oldAbs && !fs.existsSync(oldAbs)) {
      logger.info('sync', `Rename detected: ${dupEntry.localRelPath} → ${relPath}`);
      await applyPathChange(dupEntry, relPath);
      return;
    }
  }

  if (existing?.syncStatus === 'synced' && existing.localHash === hash && existing.fileId) {
    return;
  }

  await queueFileForUpload(relPath, name, stat, existing, {
    logMessage: 'New/modified file',
  });
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
