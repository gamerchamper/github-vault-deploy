import path from 'path';
import fs from 'fs';
import { getDatabase } from '../db/database';
import * as fileTreeRepo from '../db/file-tree-repo';
import * as queueRepo from '../db/queue-repo';
import { getSettings } from '../db/settings-repo';
import { VaultApiClient } from './api-client';
import { computeFileHash } from '../services/hasher';
import { logger } from '../services/logger';
import { normalizeRelPath, parentPathFromRel, toRemotePath } from '../services/paths';
import { absPathFromStored } from '../services/sync-mappings';
import type { SyncFileEntry, SyncSettings } from '../shared/types';

const PENDING_REMOVAL_MS = 20_000;

interface PendingRemoval {
  entry: SyncFileEntry;
  isFolder: boolean;
  at: number;
}

const pendingRemovals = new Map<string, PendingRemoval>();

function hashKey(hash: string, size: number): string {
  return `${hash}:${size}`;
}

export function trackPendingRemoval(relPath: string, isFolder: boolean): void {
  const normalized = normalizeRelPath(relPath);
  const entry = fileTreeRepo.getFileByRelPath(normalized);
  if (!entry) return;
  if (entry.syncStatus === 'deleted' || entry.syncStatus === 'remote_only') return;

  const recordedAt = Date.now();
  pendingRemovals.set(normalized, { entry, isFolder, at: recordedAt });
  setTimeout(() => {
    const cur = pendingRemovals.get(normalized);
    if (cur && cur.at === recordedAt) pendingRemovals.delete(normalized);
  }, PENDING_REMOVAL_MS);
}

export async function tryResolvePendingRename(newRelPath: string, isFolder: boolean): Promise<boolean> {
  prunePendingRemovals();
  const normalizedNew = normalizeRelPath(newRelPath);
  const settings = getSettings();
  if (!settings.serverUrl || !settings.apiKey) return false;

  if (isFolder) {
    return tryResolveFolderRename(normalizedNew, settings);
  }

  const absPath = absPathFromStored(settings, normalizedNew);
  if (!absPath) return false;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(absPath);
  } catch {
    return false;
  }
  if (stat.size === 0) return false;

  const hash = await computeFileHash(absPath).catch(() => null);
  if (!hash) return false;

  for (const [oldPath, pending] of pendingRemovals) {
    if (pending.isFolder) continue;
    const oldEntry = pending.entry;
    const oldHash = oldEntry.localHash;
    if (!oldHash && oldEntry.fileId) {
      continue;
    }
    if (oldHash && oldHash === hash && oldEntry.size === stat.size) {
      pendingRemovals.delete(oldPath);
      await applyPathChange(oldEntry, normalizedNew);
      return true;
    }
  }

  const byHash = fileTreeRepo.getFileByHash(hash, normalizedNew);
  if (byHash?.fileId && byHash.syncStatus === 'synced' && normalizeRelPath(byHash.localRelPath) !== normalizedNew) {
    const oldAbs = absPathFromStored(settings, byHash.localRelPath);
    if (!oldAbs || !fs.existsSync(oldAbs)) {
      await applyPathChange(byHash, normalizedNew);
      return true;
    }
  }

  return false;
}

async function tryResolveFolderRename(newFolderRel: string, settings: SyncSettings): Promise<boolean> {
  const newAbs = absPathFromStored(settings, newFolderRel);
  if (!newAbs) return false;
  if (!fs.statSync(newAbs).isDirectory()) return false;

  for (const [oldPath, pending] of pendingRemovals) {
    if (!pending.isFolder || !pending.entry.fileId) continue;
    if (await folderContentsMatchRename(settings, oldPath, newFolderRel)) {
      pendingRemovals.delete(oldPath);
      await applyFolderPathChange(pending.entry, newFolderRel);
      return true;
    }
  }
  return false;
}

async function folderContentsMatchRename(settings: SyncSettings, oldPrefix: string, newPrefix: string): Promise<boolean> {
  const oldNorm = normalizeRelPath(oldPrefix);
  const newNorm = normalizeRelPath(newPrefix);
  const children = fileTreeRepo.getFilesUnderPrefix(`${oldNorm}/`).filter((f) => !f.isFolder && f.localHash);
  if (children.length === 0) return false;

  for (const child of children) {
    const suffix = child.localRelPath.slice(oldNorm.length + 1);
    const candidate = `${newNorm}/${suffix}`;
    const abs = absPathFromStored(settings, candidate);
    if (!abs || !fs.existsSync(abs)) return false;
    const stat = fs.statSync(abs);
    if (stat.size !== child.size) return false;
    if (child.localHash) {
      const hash = await computeFileHash(abs).catch(() => null);
      if (hash !== child.localHash) return false;
    }
  }
  return true;
}

export async function applyPathChange(oldEntry: SyncFileEntry, newRelPath: string): Promise<void> {
  const normalizedNew = normalizeRelPath(newRelPath);
  const normalizedOld = normalizeRelPath(oldEntry.localRelPath);
  if (normalizedOld === normalizedNew) return;

  const newName = path.basename(normalizedNew);
  const settings = getSettings();

  if (oldEntry.fileId && settings.serverUrl && settings.apiKey) {
    const api = new VaultApiClient({ serverUrl: settings.serverUrl, apiKey: settings.apiKey });
    const oldParent = parentPathFromRel(normalizedOld);
    const newParent = parentPathFromRel(normalizedNew);

    if (oldParent !== newParent) {
      const moveResult = await api.moveFile([oldEntry.fileId], newParent);
      if (!moveResult.ok) {
        logger.error('sync', `Remote move failed for ${normalizedOld}: ${moveResult.error.message}`);
        return;
      }
    }

    if (oldEntry.name !== newName) {
      const renameResult = await api.renameFile(oldEntry.fileId, newName);
      if (!renameResult.ok) {
        logger.error('sync', `Remote rename failed for ${normalizedOld}: ${renameResult.error.message}`);
        return;
      }
    }
  }

  finalizeLocalPathUpdate(oldEntry, normalizedNew, newName);
  logger.info('sync', `Renamed: ${normalizedOld} → ${normalizedNew}`);
}

export async function applyFolderPathChange(oldFolder: SyncFileEntry, newFolderRel: string): Promise<void> {
  const normalizedOld = normalizeRelPath(oldFolder.localRelPath);
  const normalizedNew = normalizeRelPath(newFolderRel);
  if (normalizedOld === normalizedNew) return;

  const newName = path.basename(normalizedNew);
  const settings = getSettings();

  if (oldFolder.fileId && settings.serverUrl && settings.apiKey) {
    const api = new VaultApiClient({ serverUrl: settings.serverUrl, apiKey: settings.apiKey });
    const oldParent = parentPathFromRel(normalizedOld);
    const newParent = parentPathFromRel(normalizedNew);

    if (oldParent !== newParent) {
      const moveResult = await api.moveFile([oldFolder.fileId], newParent);
      if (!moveResult.ok) {
        logger.error('sync', `Remote folder move failed: ${moveResult.error.message}`);
        return;
      }
    }

    if (oldFolder.name !== newName) {
      const renameResult = await api.renameFile(oldFolder.fileId, newName);
      if (!renameResult.ok) {
        logger.error('sync', `Remote folder rename failed: ${renameResult.error.message}`);
        return;
      }
    }
  }

  fileTreeRepo.relocatePathPrefix(normalizedOld, normalizedNew);
  queueRepo.relocateQueuePathPrefix(normalizedOld, normalizedNew);
  logger.info('sync', `Folder renamed: ${normalizedOld} → ${normalizedNew}`);
}

function finalizeLocalPathUpdate(oldEntry: SyncFileEntry, newRelPath: string, newName: string): void {
  const normalizedOld = normalizeRelPath(oldEntry.localRelPath);
  fileTreeRepo.deleteFileEntry(normalizedOld);
  queueRepo.relocateQueuePath(normalizedOld, newRelPath);
  fileTreeRepo.upsertFile(getDatabase(), {
    ...oldEntry,
    localRelPath: newRelPath,
    remotePath: toRemotePath(newRelPath),
    name: newName,
    syncStatus: oldEntry.fileId ? 'synced' : oldEntry.syncStatus,
    syncError: null,
  });
}

function prunePendingRemovals(): void {
  const now = Date.now();
  for (const [key, pending] of pendingRemovals) {
    if (now - pending.at > PENDING_REMOVAL_MS) pendingRemovals.delete(key);
  }
}

export async function detectRenamesFromScan(
  settings: SyncSettings,
  hashIndex: Map<string, string>,
  known: Set<string>,
  seen: Set<string>,
): Promise<number> {
  let renamed = 0;

  for (const oldPath of known) {
    if (seen.has(oldPath)) continue;
    const existing = fileTreeRepo.getFileByRelPath(oldPath);
    if (!existing || existing.isFolder) continue;
    if (!existing.localHash || !existing.fileId) continue;
    const abs = absPathFromStored(settings, oldPath);
    if (abs && fs.existsSync(abs)) continue;

    const key = hashKey(existing.localHash, existing.size);
    const newPath = hashIndex.get(key);
    if (!newPath || newPath === oldPath || !seen.has(newPath)) continue;

    await applyPathChange(existing, newPath);
    renamed += 1;
  }

  for (const oldPath of known) {
    if (seen.has(oldPath)) continue;
    const existing = fileTreeRepo.getFileByRelPath(oldPath);
    if (!existing?.isFolder || !existing.fileId) continue;
    const oldAbs = absPathFromStored(settings, oldPath);
    if (oldAbs && fs.existsSync(oldAbs)) continue;

    for (const candidate of seen) {
      const candidateAbs = absPathFromStored(settings, candidate);
      if (!candidateAbs || !fs.statSync(candidateAbs).isDirectory()) continue;
      if (await folderContentsMatchRename(settings, oldPath, candidate)) {
        await applyFolderPathChange(existing, candidate);
        renamed += 1;
        break;
      }
    }
  }

  if (renamed > 0) {
    logger.info('sync', `Detected ${renamed} rename(s) during scan`);
  }
  return renamed;
}

export function buildHashIndexKey(hash: string, size: number): string {
  return hashKey(hash, size);
}
