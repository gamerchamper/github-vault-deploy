import path from 'path';
import crypto from 'crypto';
import { normalizeRelPath, parentPathFromRel } from './paths';
import type { AdditionalSyncFolder, SyncSettings } from '../shared/types';

export const SYNC_CONTAINER_NAME = 'Sync Folder';
const STORED_MARKER = '@sync/';

export function remotePrefixForFolderName(folderName: string): string {
  const safe = folderName.replace(/[/\\]/g, '').trim() || 'Folder';
  return `/${SYNC_CONTAINER_NAME}/${safe}`;
}

export function createAdditionalFolder(localPath: string): AdditionalSyncFolder {
  const normalized = path.normalize(localPath);
  const name = path.basename(normalized) || 'Folder';
  return {
    id: crypto.randomUUID(),
    localPath: normalized,
    name,
    enabled: true,
    addedAt: new Date().toISOString(),
  };
}

export function getEnabledAdditionalFolders(settings: SyncSettings): AdditionalSyncFolder[] {
  return (settings.additionalSyncFolders || []).filter((f) => f.enabled && f.localPath);
}

export function isAdditionalStoredRel(storedRel: string): boolean {
  return normalizeRelPath(storedRel).startsWith(STORED_MARKER);
}

export function toAdditionalStoredRel(mappingId: string, relWithin: string): string {
  const inner = normalizeRelPath(relWithin);
  return inner ? `${STORED_MARKER}${mappingId}/${inner}` : `${STORED_MARKER}${mappingId}`;
}

export function parseAdditionalStoredRel(storedRel: string): { mappingId: string; relWithin: string } | null {
  const normalized = normalizeRelPath(storedRel);
  if (!normalized.startsWith(STORED_MARKER)) return null;
  const rest = normalized.slice(STORED_MARKER.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return { mappingId: rest, relWithin: '' };
  return {
    mappingId: rest.slice(0, slash),
    relWithin: rest.slice(slash + 1),
  };
}

export function findMapping(settings: SyncSettings, mappingId: string): AdditionalSyncFolder | undefined {
  return (settings.additionalSyncFolders || []).find((f) => f.id === mappingId);
}

export function absPathFromStored(settings: SyncSettings, storedRel: string): string | null {
  const normalized = normalizeRelPath(storedRel);
  if (!isAdditionalStoredRel(normalized)) {
    if (!settings.syncRootPath) return null;
    const parts = normalized.split('/').filter(Boolean);
    return path.join(settings.syncRootPath, ...parts);
  }

  const parsed = parseAdditionalStoredRel(normalized);
  if (!parsed) return null;
  const mapping = findMapping(settings, parsed.mappingId);
  if (!mapping) return null;
  const parts = parsed.relWithin.split('/').filter(Boolean);
  return parts.length ? path.join(mapping.localPath, ...parts) : mapping.localPath;
}

export function remotePathFromStored(settings: SyncSettings, storedRel: string): string {
  const normalized = normalizeRelPath(storedRel);
  if (!isAdditionalStoredRel(normalized)) {
    return normalized ? `/${normalized}` : '/';
  }

  const parsed = parseAdditionalStoredRel(normalized);
  if (!parsed) return '/';
  const mapping = findMapping(settings, parsed.mappingId);
  if (!mapping) return '/';

  const prefix = remotePrefixForFolderName(mapping.name);
  if (!parsed.relWithin) return prefix;
  return `${prefix}/${normalizeRelPath(parsed.relWithin)}`;
}

export function remoteParentFromStored(settings: SyncSettings, storedRel: string): string {
  const remote = remotePathFromStored(settings, storedRel);
  const idx = remote.lastIndexOf('/');
  if (idx <= 0) return '/';
  return remote.slice(0, idx) || '/';
}

export function displayRelPath(settings: SyncSettings, storedRel: string): string {
  const normalized = normalizeRelPath(storedRel);
  if (!isAdditionalStoredRel(normalized)) return normalized;
  const parsed = parseAdditionalStoredRel(normalized);
  if (!parsed) return normalized;
  const mapping = findMapping(settings, parsed.mappingId);
  const label = mapping?.name || 'Sync';
  return parsed.relWithin ? `${label}/${parsed.relWithin}` : label;
}

export function resolveAbsPathToStored(settings: SyncSettings, absPath: string): string | null {
  const normAbs = path.normalize(absPath);

  const extras = getEnabledAdditionalFolders(settings)
    .slice()
    .sort((a, b) => b.localPath.length - a.localPath.length);
  for (const mapping of extras) {
    const root = path.normalize(mapping.localPath);
    if (normAbs === root || normAbs.startsWith(root + path.sep)) {
      const relWithin = normAbs === root
        ? ''
        : path.relative(root, normAbs).replace(/\\/g, '/');
      return toAdditionalStoredRel(mapping.id, relWithin);
    }
  }

  if (!settings.syncRootPath) return null;
  const main = path.normalize(settings.syncRootPath);
  if (normAbs === main || normAbs.startsWith(main + path.sep)) {
    const rel = normAbs === main ? '' : path.relative(main, normAbs).replace(/\\/g, '/');
    return normalizeRelPath(rel);
  }

  return null;
}

export function relWithinSegments(storedRel: string): string[] {
  const normalized = normalizeRelPath(storedRel);
  if (isAdditionalStoredRel(normalized)) {
    const parsed = parseAdditionalStoredRel(normalized);
    return parsed?.relWithin ? parsed.relWithin.split('/').filter(Boolean) : [];
  }
  return normalized.split('/').filter(Boolean);
}

export function storedRelAfterSegments(
  mappingId: string | null,
  segments: string[],
): string {
  const joined = segments.join('/');
  if (mappingId) return toAdditionalStoredRel(mappingId, joined);
  return joined;
}

export function mappingIdFromStored(storedRel: string): string | null {
  if (!isAdditionalStoredRel(storedRel)) return null;
  return parseAdditionalStoredRel(storedRel)?.mappingId ?? null;
}

/** Parent stored path for folder hierarchy inside a mapping or main root. */
export function parentStoredRel(storedRel: string): string {
  const normalized = normalizeRelPath(storedRel);
  if (!normalized) return '';
  const idx = normalized.lastIndexOf('/');
  if (idx < 0) return '';
  return normalized.slice(0, idx);
}

export function pathsConflict(settings: SyncSettings, localPath: string): string | null {
  const norm = path.normalize(localPath);
  const main = settings.syncRootPath ? path.normalize(settings.syncRootPath) : '';
  if (main && (norm === main || norm.startsWith(main + path.sep) || main.startsWith(norm + path.sep))) {
    return 'This folder overlaps the main sync folder.';
  }
  for (const existing of settings.additionalSyncFolders || []) {
    const root = path.normalize(existing.localPath);
    if (norm === root) return 'This folder is already being synced.';
    if (norm.startsWith(root + path.sep) || root.startsWith(norm + path.sep)) {
      return 'This folder overlaps another synced folder.';
    }
  }
  return null;
}

export function listRemoteWalkRoots(settings: SyncSettings): string[] {
  const roots = ['/'];
  for (const mapping of getEnabledAdditionalFolders(settings)) {
    roots.push(remotePrefixForFolderName(mapping.name));
  }
  return roots;
}

export function remotePathToStored(settings: SyncSettings, remotePath: string): string | null {
  const normalized = remotePath.replace(/\\/g, '/');
  const syncContainer = `/${SYNC_CONTAINER_NAME}`;

  if (normalized === syncContainer || normalized.startsWith(`${syncContainer}/`)) {
    for (const mapping of getEnabledAdditionalFolders(settings)) {
      const prefix = remotePrefixForFolderName(mapping.name);
      if (normalized === prefix) {
        return toAdditionalStoredRel(mapping.id, '');
      }
      if (normalized.startsWith(`${prefix}/`)) {
        const relWithin = normalized.slice(prefix.length + 1);
        return toAdditionalStoredRel(mapping.id, relWithin);
      }
    }
    return null;
  }

  if (normalized === '/') return '';
  if (normalized.startsWith('/')) {
    return normalizeRelPath(normalized.slice(1));
  }
  return null;
}

export { parentPathFromRel };
