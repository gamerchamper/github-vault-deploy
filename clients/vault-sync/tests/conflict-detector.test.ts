import { describe, it, expect } from 'vitest';
import { detectConflicts, makeConflictCopyPath } from '../src/core/conflict-detector';

describe('conflict-detector', () => {
  it('detects upload when local changed and remote unchanged', () => {
    const local = { fileId: 'abc', localRelPath: 'file.txt', remotePath: '/file.txt', name: 'file.txt', size: 100, mimeType: null, isFolder: false, localMtimeMs: 2000, localHash: 'local-hash', remoteHash: 'old-remote', remoteUpdatedAt: null, syncStatus: 'synced' as const, syncTaskId: null, syncError: null };
    const remote = { ...local, remoteHash: 'old-remote', localHash: 'old-remote' };
    const result = detectConflicts(local, remote);
    expect(result.action).toBe('upload');
    expect(result.conflict).toBeNull();
  });

  it('detects conflict when both changed', () => {
    const local = { fileId: 'abc', localRelPath: 'file.txt', remotePath: '/file.txt', name: 'file.txt', size: 100, mimeType: null, isFolder: false, localMtimeMs: 2000, localHash: 'local-v2', remoteHash: 'old-remote', remoteUpdatedAt: null, syncStatus: 'synced' as const, syncTaskId: null, syncError: null };
    const remote = { ...local, remoteHash: 'remote-v2', localHash: 'old-remote' };
    const result = detectConflicts(local, remote);
    expect(result.action).toBe('conflict');
    expect(result.conflict).not.toBeNull();
    expect(result.conflict!.conflictReason).toBe('both_changed');
  });

  it('downloads when remote changed and local unchanged', () => {
    const local = { fileId: 'abc', localRelPath: 'file.txt', remotePath: '/file.txt', name: 'file.txt', size: 100, mimeType: null, isFolder: false, localMtimeMs: 2000, localHash: 'hash', remoteHash: 'hash', remoteUpdatedAt: null, syncStatus: 'synced' as const, syncTaskId: null, syncError: null };
    const remote = { ...local, remoteHash: 'new-hash', localHash: 'hash' };
    const result = detectConflicts(local, remote);
    expect(result.action).toBe('download');
  });

  it('uploads when local only (no remote entry)', () => {
    const local = { fileId: null, localRelPath: 'file.txt', remotePath: null, name: 'file.txt', size: 100, mimeType: null, isFolder: false, localMtimeMs: 2000, localHash: 'hash', remoteHash: null, remoteUpdatedAt: null, syncStatus: 'local_only' as const, syncTaskId: null, syncError: null };
    const result = detectConflicts(local, null);
    expect(result.action).toBe('upload');
  });

  it('generates conflict copy path with timestamp', () => {
    const path = makeConflictCopyPath('folder/file.txt');
    expect(path).toMatch(/folder\/file \(conflict \d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\)\.txt/);
  });

  it('generates conflict copy path for extensionless files', () => {
    const path = makeConflictCopyPath('folder/Makefile');
    expect(path).toMatch(/folder\/Makefile \(conflict \d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\)/);
  });
});
