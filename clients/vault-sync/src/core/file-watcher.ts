import chokidar from 'chokidar';
import type { FSWatcher } from 'chokidar';
import path from 'path';
import fs from 'fs';
import { logger } from '../services/logger';
import { getSettings } from '../db/settings-repo';

let watcher: FSWatcher | null = null;
let onChange: ((event: string, filePath: string) => void) | null = null;

const EXCLUDED_PATTERNS = [
  /(^|[\\/])\.[^\\/]/,        // hidden files / dotfiles
  /~$/,                        // backup files
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

export function startWatcher(syncRoot: string, cb: (event: string, filePath: string) => void): void {
  if (watcher) {
    watcher.close();
  }

  onChange = cb;
  logger.info('watcher', `Starting file watcher on ${syncRoot}`);

  watcher = chokidar.watch(syncRoot, {
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
    logger.error('watcher', `Watcher error: ${msg}`);
  });

  watcher.on('ready', () => {
    logger.info('watcher', 'File watcher ready');
  });
}

export function stopWatcher(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  for (const timer of pendingFiles.values()) {
    clearTimeout(timer);
  }
  pendingFiles.clear();
  logger.info('watcher', 'File watcher stopped');
}

function handleEvent(event: string, absPath: string, syncRoot: string): void {
  const relPath = path.relative(syncRoot, absPath);
  if (!relPath || relPath.startsWith('..')) return;

  const key = `${event}:${relPath}`;
  const existing = pendingFiles.get(key);
  if (existing) clearTimeout(existing);

  pendingFiles.set(key, setTimeout(() => {
    pendingFiles.delete(key);
    if (validateFile(absPath, event)) {
      logger.debug('watcher', `${event}: ${relPath}`);
      if (onChange) onChange(event, relPath);
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
