import chokidar from 'chokidar';
import type { FSWatcher } from 'chokidar';
import path from 'path';
import fs from 'fs';
import { logger } from '../services/logger';
import { getSettings } from '../db/settings-repo';

let watchers: FSWatcher[] = [];
let onChange: ((event: string, storedRelPath: string) => void) | null = null;
let resolveStoredRel: ((absPath: string) => string | null) | null = null;

const EXCLUDED_PATTERNS = [
  /(^|[\\/])\.[^\\/]/,
  /~$/,
  /\.tmp$/i,
  /\.part$/i,
  /\.crdownload$/i,
  /\.swp$/,
  /Thumbs\.db$/i,
  /desktop\.ini$/i,
  /\.DS_Store$/i,
  /node_modules/,
  /\.vault-/,
];

const STABILITY_MS = 3000;
const pendingFiles = new Map<string, NodeJS.Timeout>();

export function startAllWatchers(
  roots: string[],
  toStoredRel: (absPath: string) => string | null,
  cb: (event: string, storedRelPath: string) => void,
): void {
  stopWatcher();
  onChange = cb;
  resolveStoredRel = toStoredRel;

  const uniqueRoots = [...new Set(roots.map((r) => path.normalize(r)).filter(Boolean))];
  for (const syncRoot of uniqueRoots) {
    logger.info('watcher', `Starting file watcher on ${syncRoot}`);
    const watcher = chokidar.watch(syncRoot, {
      ignored: [
        ...EXCLUDED_PATTERNS,
        ...(getSettings().excludedPatterns || []).filter(Boolean),
      ],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: STABILITY_MS,
        pollInterval: 200,
      },
      depth: 50,
    });

    watcher.on('add', (absPath: string) => handleEvent('add', absPath, syncRoot));
    watcher.on('change', (absPath: string) => handleEvent('change', absPath, syncRoot));
    watcher.on('unlink', (absPath: string) => handleEvent('unlink', absPath, syncRoot));
    watcher.on('addDir', (absPath: string) => handleEvent('addDir', absPath, syncRoot));
    watcher.on('unlinkDir', (absPath: string) => handleEvent('unlinkDir', absPath, syncRoot));
    watcher.on('error', (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('watcher', `Watcher error (${syncRoot}): ${msg}`);
    });
    watcher.on('ready', () => {
      logger.info('watcher', `File watcher ready: ${syncRoot}`);
    });

    watchers.push(watcher);
  }
}

/** @deprecated Use startAllWatchers */
export function startWatcher(syncRoot: string, cb: (event: string, filePath: string) => void): void {
  startAllWatchers([syncRoot], (abs) => {
    const rel = path.relative(syncRoot, abs);
    if (!rel || rel.startsWith('..')) return null;
    return rel.replace(/\\/g, '/');
  }, cb);
}

export function stopWatcher(): void {
  for (const watcher of watchers) {
    watcher.close();
  }
  watchers = [];
  for (const timer of pendingFiles.values()) {
    clearTimeout(timer);
  }
  pendingFiles.clear();
  logger.info('watcher', 'File watcher stopped');
}

function handleEvent(event: string, absPath: string, syncRoot: string): void {
  const storedRel = resolveStoredRel?.(absPath)
    ?? path.relative(syncRoot, absPath).replace(/\\/g, '/');
  if (!storedRel || storedRel.startsWith('..')) return;

  const key = `${event}:${storedRel}`;
  const existing = pendingFiles.get(key);
  if (existing) clearTimeout(existing);

  pendingFiles.set(key, setTimeout(() => {
    pendingFiles.delete(key);
    if (validateFile(absPath, event)) {
      logger.debug('watcher', `${event}: ${storedRel}`);
      if (onChange) onChange(event, storedRel);
    }
  }, STABILITY_MS));
}

function validateFile(absPath: string, event: string): boolean {
  if (event === 'unlink' || event === 'unlinkDir') {
    return true;
  }

  try {
    if (!fs.existsSync(absPath)) return false;
    const stat = fs.statSync(absPath);
    if (stat.size === 0 && event === 'add') return false;
    return true;
  } catch {
    return false;
  }
}
