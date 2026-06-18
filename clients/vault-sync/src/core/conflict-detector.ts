import type { SyncFileEntry, ConflictEntry } from '../shared/types';
import { logger } from '../services/logger';

export function detectConflicts(
  localEntry: SyncFileEntry | null,
  remoteEntry: SyncFileEntry | null,
): { conflict: ConflictEntry | null; action: 'upload' | 'download' | 'skip' | 'conflict' } {
  if (!localEntry && remoteEntry) {
    return { conflict: null, action: 'download' };
  }

  if (localEntry && !remoteEntry) {
    return { conflict: null, action: 'upload' };
  }

  if (!localEntry || !remoteEntry) {
    return { conflict: null, action: 'skip' };
  }

  if (localEntry.syncStatus === 'synced') {
    if (localEntry.localHash !== localEntry.remoteHash && remoteEntry.remoteHash !== localEntry.remoteHash) {
      const conflict: ConflictEntry = {
        id: 0,
        fileId: remoteEntry.fileId,
        localRelPath: localEntry.localRelPath,
        localHash: localEntry.localHash,
        remoteHash: remoteEntry.remoteHash,
        localMtimeMs: localEntry.localMtimeMs,
        remoteUpdatedAt: remoteEntry.remoteUpdatedAt,
        conflictReason: 'both_changed',
        resolution: 'unresolved',
        resolvedAt: null,
        createdAt: new Date().toISOString(),
      };
      logger.warn('conflict', `Both changed: ${localEntry.localRelPath}`);
      return { conflict, action: 'conflict' };
    }

    if (localEntry.localHash !== localEntry.remoteHash && remoteEntry.remoteHash === localEntry.remoteHash) {
      return { conflict: null, action: 'upload' };
    }

    if (localEntry.localHash === localEntry.remoteHash && remoteEntry.remoteHash !== localEntry.remoteHash) {
      return { conflict: null, action: 'download' };
    }
  }

  return { conflict: null, action: 'skip' };
}

export function makeConflictCopyPath(filePath: string): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dotIdx = filePath.lastIndexOf('.');
  if (dotIdx <= filePath.lastIndexOf('/') && dotIdx <= filePath.lastIndexOf('\\')) {
    return `${filePath} (conflict ${ts})`;
  }
  const name = filePath.slice(0, dotIdx);
  const ext = filePath.slice(dotIdx);
  return `${name} (conflict ${ts})${ext}`;
}
