import fs from 'fs';
import { getDatabase } from '../db/database';
import * as fileTreeRepo from '../db/file-tree-repo';
import { getSettings } from '../db/settings-repo';
import { VaultApiClient } from './api-client';
import { RemoteListingCache } from './remote-listing-cache';
import { logger } from '../services/logger';
import { normalizeRelPath } from '../services/paths';
import {
  absPathFromStored,
  isAdditionalStoredRel,
  mappingIdFromStored,
  remotePrefixForFolderName,
  findMapping,
  relWithinSegments,
  SYNC_CONTAINER_NAME,
} from '../services/sync-mappings';

interface RemoteFolder {
  id: string;
  name: string;
  path: string;
}

function parseFolderPayload(folder: unknown): RemoteFolder | null {
  if (!folder || typeof folder !== 'object') return null;
  const f = folder as Record<string, unknown>;
  const id = f.id as string | undefined;
  const name = f.name as string | undefined;
  const remotePath = f.path as string | undefined;
  if (!id || !name || !remotePath) return null;
  return { id, name, path: remotePath };
}

function upsertSyncedFolder(folderRel: string, remote: RemoteFolder): void {
  fileTreeRepo.upsertFile(getDatabase(), {
    fileId: remote.id,
    localRelPath: folderRel,
    remotePath: remote.path,
    name: remote.name,
    size: 0,
    mimeType: null,
    isFolder: true,
    localMtimeMs: null,
    localHash: null,
    remoteHash: null,
    remoteUpdatedAt: new Date().toISOString(),
    syncStatus: 'synced',
    syncTaskId: null,
    syncError: null,
  });
}

function upsertLocalOnlyFolder(folderRel: string, name: string): void {
  fileTreeRepo.upsertFile(getDatabase(), {
    fileId: null,
    localRelPath: folderRel,
    remotePath: null,
    name,
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
}

async function resolveRemoteFolder(
  remoteCache: RemoteListingCache,
  parentRemote: string,
  name: string,
): Promise<RemoteFolder | null> {
  const match = await remoteCache.findFolderByName(parentRemote, name);
  if (!match) return null;
  return { id: match.id, name: match.name, path: match.path };
}

async function createRemoteFolder(
  api: VaultApiClient,
  remoteCache: RemoteListingCache,
  parentRemote: string,
  name: string,
  folderRel: string,
): Promise<RemoteFolder | null> {
  const result = await api.createFolder(name, parentRemote);
  if (result.ok) {
    const folder = parseFolderPayload(result.value.folder);
    if (folder) {
      remoteCache.invalidate(parentRemote);
      return folder;
    }
    logger.warn('sync', `Failed to create folder "${folderRel}": Invalid folder response`);
    return null;
  }

  const msg = result.error.message;
  if (/already exists/i.test(msg)) {
    remoteCache.invalidate(parentRemote);
    const existing = await resolveRemoteFolder(remoteCache, parentRemote, name);
    if (existing) return existing;
  }

  logger.warn('sync', `Failed to create folder "${folderRel}": ${msg}`);
  return null;
}

async function ensureRemotePath(
  api: VaultApiClient,
  remoteCache: RemoteListingCache,
  remotePath: string,
): Promise<boolean> {
  const normalized = remotePath.replace(/\\/g, '/');
  if (normalized === '/' || !normalized) return true;

  const segments = normalized.replace(/^\//, '').split('/').filter(Boolean);
  let current = '/';
  for (const seg of segments) {
    let remote = await resolveRemoteFolder(remoteCache, current, seg);
    if (!remote) {
      remote = await createRemoteFolder(api, remoteCache, current, seg, normalized);
    }
    if (!remote) return false;
    current = remote.path;
  }
  return true;
}

/** Ensure the server has /Sync Folder before syncing additional PC folders. */
export async function ensureSyncContainerOnServer(api?: VaultApiClient): Promise<boolean> {
  const settings = getSettings();
  if (!settings.serverUrl || !settings.apiKey) return false;
  const client = api ?? new VaultApiClient({ serverUrl: settings.serverUrl, apiKey: settings.apiKey });
  const cache = new RemoteListingCache(client);
  return ensureRemotePath(client, cache, `/${SYNC_CONTAINER_NAME}`);
}

/** Ensure a local folder path exists on the server (creates parents as needed). */
export async function syncLocalFolder(
  relPath: string,
  remoteCache?: RemoteListingCache,
): Promise<boolean> {
  const settings = getSettings();
  if (!settings.serverUrl || !settings.apiKey) return false;

  const normalized = normalizeRelPath(relPath);
  if (!normalized && !isAdditionalStoredRel(relPath)) return false;

  const absPath = absPathFromStored(settings, normalized);
  if (!absPath) return false;
  try {
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isDirectory()) return false;
  } catch {
    return false;
  }

  const api = new VaultApiClient({ serverUrl: settings.serverUrl, apiKey: settings.apiKey });
  const cache = remoteCache ?? new RemoteListingCache(api);

  const mappingId = mappingIdFromStored(normalized);
  const segments = relWithinSegments(normalized);

  if (mappingId) {
    const mapping = findMapping(settings, mappingId);
    if (!mapping) return false;
    await ensureRemotePath(api, cache, `/${SYNC_CONTAINER_NAME}`);
    await ensureRemotePath(api, cache, remotePrefixForFolderName(mapping.name));
  }

  let builtRel = mappingId ? `@sync/${mappingId}` : '';
  let builtRemote = mappingId
    ? remotePrefixForFolderName(findMapping(settings, mappingId!)!.name)
    : '/';
  let allOk = true;

  for (const seg of segments) {
    builtRel = builtRel ? `${builtRel}/${seg}` : (mappingId ? `@sync/${mappingId}/${seg}` : seg);
    const parentRemote = builtRemote;
    const existing = fileTreeRepo.getFileByRelPath(builtRel);

    if (existing?.fileId && existing.syncStatus === 'synced') {
      builtRemote = existing.remotePath || `${parentRemote}/${seg}`.replace(/\/+/g, '/');
      continue;
    }

    let remote = await resolveRemoteFolder(cache, parentRemote, seg);
    if (!remote) {
      remote = await createRemoteFolder(api, cache, parentRemote, seg, builtRel);
    }

    if (remote) {
      upsertSyncedFolder(builtRel, remote);
      builtRemote = remote.path;
      logger.info('sync', `Folder on server: ${builtRel}`);
    } else {
      upsertLocalOnlyFolder(builtRel, seg);
      allOk = false;
    }
  }

  if (mappingId && segments.length === 0) {
    const mapping = findMapping(settings, mappingId);
    if (mapping) {
      const stored = `@sync/${mappingId}`;
      let remote = await resolveRemoteFolder(cache, `/${SYNC_CONTAINER_NAME}`, mapping.name);
      if (!remote) {
        remote = await createRemoteFolder(api, cache, `/${SYNC_CONTAINER_NAME}`, mapping.name, stored);
      }
      if (remote) upsertSyncedFolder(stored, remote);
      else allOk = false;
    }
  }

  return allOk;
}

/** Sync all local-only folders (parents before children). */
export async function syncLocalOnlyFolders(remoteCache?: RemoteListingCache): Promise<number> {
  const settings = getSettings();
  if (!settings.serverUrl || !settings.apiKey) return 0;

  const api = new VaultApiClient({ serverUrl: settings.serverUrl, apiKey: settings.apiKey });
  const cache = remoteCache ?? new RemoteListingCache(api);

  const folders = fileTreeRepo.getFilesByStatus('local_only')
    .filter((f) => f.isFolder)
    .sort((a, b) => normalizeRelPath(a.localRelPath).split('/').length - normalizeRelPath(b.localRelPath).split('/').length);

  let synced = 0;
  for (const folder of folders) {
    const absPath = absPathFromStored(settings, folder.localRelPath);
    if (!absPath || !fs.existsSync(absPath)) continue;
    const ok = await syncLocalFolder(folder.localRelPath, cache);
    if (ok) synced += 1;
  }

  if (synced > 0) {
    logger.info('sync', `Synced ${synced} local folder(s) to server`);
  }
  return synced;
}

export async function registerAdditionalFolderRoots(): Promise<void> {
  const settings = getSettings();
  const db = getDatabase();
  for (const mapping of settings.additionalSyncFolders || []) {
    if (!mapping.enabled || !mapping.localPath) continue;
    const stored = `@sync/${mapping.id}`;
    const existing = fileTreeRepo.getFileByRelPath(stored);
    if (!existing) {
      fileTreeRepo.upsertFile(db, {
        fileId: null,
        localRelPath: stored,
        remotePath: remotePrefixForFolderName(mapping.name),
        name: mapping.name,
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
    }
  }
}
