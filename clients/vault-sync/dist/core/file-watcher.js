"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startAllWatchers = startAllWatchers;
exports.startWatcher = startWatcher;
exports.stopWatcher = stopWatcher;
const chokidar_1 = __importDefault(require("chokidar"));
const path_1 = __importDefault(require("path"));
const fs_1 = __importDefault(require("fs"));
const logger_1 = require("../services/logger");
const settings_repo_1 = require("../db/settings-repo");
let watchers = [];
let onChange = null;
let resolveStoredRel = null;
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
const pendingFiles = new Map();
function startAllWatchers(roots, toStoredRel, cb) {
    stopWatcher();
    onChange = cb;
    resolveStoredRel = toStoredRel;
    const uniqueRoots = [...new Set(roots.map((r) => path_1.default.normalize(r)).filter(Boolean))];
    for (const syncRoot of uniqueRoots) {
        logger_1.logger.info('watcher', `Starting file watcher on ${syncRoot}`);
        const watcher = chokidar_1.default.watch(syncRoot, {
            ignored: [
                ...EXCLUDED_PATTERNS,
                ...((0, settings_repo_1.getSettings)().excludedPatterns || []).filter(Boolean),
            ],
            persistent: true,
            ignoreInitial: true,
            awaitWriteFinish: {
                stabilityThreshold: STABILITY_MS,
                pollInterval: 200,
            },
            depth: 50,
        });
        watcher.on('add', (absPath) => handleEvent('add', absPath, syncRoot));
        watcher.on('change', (absPath) => handleEvent('change', absPath, syncRoot));
        watcher.on('unlink', (absPath) => handleEvent('unlink', absPath, syncRoot));
        watcher.on('addDir', (absPath) => handleEvent('addDir', absPath, syncRoot));
        watcher.on('unlinkDir', (absPath) => handleEvent('unlinkDir', absPath, syncRoot));
        watcher.on('error', (err) => {
            const msg = err instanceof Error ? err.message : String(err);
            logger_1.logger.error('watcher', `Watcher error (${syncRoot}): ${msg}`);
        });
        watcher.on('ready', () => {
            logger_1.logger.info('watcher', `File watcher ready: ${syncRoot}`);
        });
        watchers.push(watcher);
    }
}
/** @deprecated Use startAllWatchers */
function startWatcher(syncRoot, cb) {
    startAllWatchers([syncRoot], (abs) => {
        const rel = path_1.default.relative(syncRoot, abs);
        if (!rel || rel.startsWith('..'))
            return null;
        return rel.replace(/\\/g, '/');
    }, cb);
}
function stopWatcher() {
    for (const watcher of watchers) {
        watcher.close();
    }
    watchers = [];
    for (const timer of pendingFiles.values()) {
        clearTimeout(timer);
    }
    pendingFiles.clear();
    logger_1.logger.info('watcher', 'File watcher stopped');
}
function handleEvent(event, absPath, syncRoot) {
    const storedRel = resolveStoredRel?.(absPath)
        ?? path_1.default.relative(syncRoot, absPath).replace(/\\/g, '/');
    if (!storedRel || storedRel.startsWith('..'))
        return;
    const key = `${event}:${storedRel}`;
    const existing = pendingFiles.get(key);
    if (existing)
        clearTimeout(existing);
    pendingFiles.set(key, setTimeout(() => {
        pendingFiles.delete(key);
        if (validateFile(absPath, event)) {
            logger_1.logger.debug('watcher', `${event}: ${storedRel}`);
            if (onChange)
                onChange(event, storedRel);
        }
    }, STABILITY_MS));
}
function validateFile(absPath, event) {
    if (event === 'unlink' || event === 'unlinkDir') {
        return true;
    }
    try {
        if (!fs_1.default.existsSync(absPath))
            return false;
        const stat = fs_1.default.statSync(absPath);
        if (stat.size === 0 && event === 'add')
            return false;
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=file-watcher.js.map