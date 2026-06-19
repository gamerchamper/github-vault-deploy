import path from 'path';

/** Canonical relative path stored in SQLite (forward slashes). */
export function normalizeRelPath(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\/+/, '');
}

export function toAbsPath(syncRoot: string, relPath: string): string {
  const parts = normalizeRelPath(relPath).split('/').filter(Boolean);
  return path.join(syncRoot, ...parts);
}

export function parentPathFromRel(localRelPath: string): string {
  const normalized = normalizeRelPath(localRelPath);
  const idx = normalized.lastIndexOf('/');
  if (idx < 0) return '/';
  return `/${normalized.slice(0, idx)}`;
}

export function toRemotePath(localRelPath: string): string {
  return `/${normalizeRelPath(localRelPath)}`;
}
