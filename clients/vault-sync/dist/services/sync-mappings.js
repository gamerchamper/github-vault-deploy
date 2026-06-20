"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.parentPathFromRel = exports.SYNC_CONTAINER_NAME = void 0;
exports.remotePrefixForFolderName = remotePrefixForFolderName;
exports.createAdditionalFolder = createAdditionalFolder;
exports.getEnabledAdditionalFolders = getEnabledAdditionalFolders;
exports.isAdditionalStoredRel = isAdditionalStoredRel;
exports.toAdditionalStoredRel = toAdditionalStoredRel;
exports.parseAdditionalStoredRel = parseAdditionalStoredRel;
exports.findMapping = findMapping;
exports.absPathFromStored = absPathFromStored;
exports.remotePathFromStored = remotePathFromStored;
exports.remoteParentFromStored = remoteParentFromStored;
exports.displayRelPath = displayRelPath;
exports.resolveAbsPathToStored = resolveAbsPathToStored;
exports.relWithinSegments = relWithinSegments;
exports.storedRelAfterSegments = storedRelAfterSegments;
exports.mappingIdFromStored = mappingIdFromStored;
exports.parentStoredRel = parentStoredRel;
exports.pathsConflict = pathsConflict;
exports.listRemoteWalkRoots = listRemoteWalkRoots;
exports.remotePathToStored = remotePathToStored;
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const paths_1 = require("./paths");
Object.defineProperty(exports, "parentPathFromRel", { enumerable: true, get: function () { return paths_1.parentPathFromRel; } });
exports.SYNC_CONTAINER_NAME = 'Sync Folder';
const STORED_MARKER = '@sync/';
function remotePrefixForFolderName(folderName) {
    const safe = folderName.replace(/[/\\]/g, '').trim() || 'Folder';
    return `/${exports.SYNC_CONTAINER_NAME}/${safe}`;
}
function createAdditionalFolder(localPath) {
    const normalized = path_1.default.normalize(localPath);
    const name = path_1.default.basename(normalized) || 'Folder';
    return {
        id: crypto_1.default.randomUUID(),
        localPath: normalized,
        name,
        enabled: true,
        addedAt: new Date().toISOString(),
    };
}
function getEnabledAdditionalFolders(settings) {
    return (settings.additionalSyncFolders || []).filter((f) => f.enabled && f.localPath);
}
function isAdditionalStoredRel(storedRel) {
    return (0, paths_1.normalizeRelPath)(storedRel).startsWith(STORED_MARKER);
}
function toAdditionalStoredRel(mappingId, relWithin) {
    const inner = (0, paths_1.normalizeRelPath)(relWithin);
    return inner ? `${STORED_MARKER}${mappingId}/${inner}` : `${STORED_MARKER}${mappingId}`;
}
function parseAdditionalStoredRel(storedRel) {
    const normalized = (0, paths_1.normalizeRelPath)(storedRel);
    if (!normalized.startsWith(STORED_MARKER))
        return null;
    const rest = normalized.slice(STORED_MARKER.length);
    const slash = rest.indexOf('/');
    if (slash < 0)
        return { mappingId: rest, relWithin: '' };
    return {
        mappingId: rest.slice(0, slash),
        relWithin: rest.slice(slash + 1),
    };
}
function findMapping(settings, mappingId) {
    return (settings.additionalSyncFolders || []).find((f) => f.id === mappingId);
}
function absPathFromStored(settings, storedRel) {
    const normalized = (0, paths_1.normalizeRelPath)(storedRel);
    if (!isAdditionalStoredRel(normalized)) {
        if (!settings.syncRootPath)
            return null;
        const parts = normalized.split('/').filter(Boolean);
        return path_1.default.join(settings.syncRootPath, ...parts);
    }
    const parsed = parseAdditionalStoredRel(normalized);
    if (!parsed)
        return null;
    const mapping = findMapping(settings, parsed.mappingId);
    if (!mapping)
        return null;
    const parts = parsed.relWithin.split('/').filter(Boolean);
    return parts.length ? path_1.default.join(mapping.localPath, ...parts) : mapping.localPath;
}
function remotePathFromStored(settings, storedRel) {
    const normalized = (0, paths_1.normalizeRelPath)(storedRel);
    if (!isAdditionalStoredRel(normalized)) {
        return normalized ? `/${normalized}` : '/';
    }
    const parsed = parseAdditionalStoredRel(normalized);
    if (!parsed)
        return '/';
    const mapping = findMapping(settings, parsed.mappingId);
    if (!mapping)
        return '/';
    const prefix = remotePrefixForFolderName(mapping.name);
    if (!parsed.relWithin)
        return prefix;
    return `${prefix}/${(0, paths_1.normalizeRelPath)(parsed.relWithin)}`;
}
function remoteParentFromStored(settings, storedRel) {
    const remote = remotePathFromStored(settings, storedRel);
    const idx = remote.lastIndexOf('/');
    if (idx <= 0)
        return '/';
    return remote.slice(0, idx) || '/';
}
function displayRelPath(settings, storedRel) {
    const normalized = (0, paths_1.normalizeRelPath)(storedRel);
    if (!isAdditionalStoredRel(normalized))
        return normalized;
    const parsed = parseAdditionalStoredRel(normalized);
    if (!parsed)
        return normalized;
    const mapping = findMapping(settings, parsed.mappingId);
    const label = mapping?.name || 'Sync';
    return parsed.relWithin ? `${label}/${parsed.relWithin}` : label;
}
function resolveAbsPathToStored(settings, absPath) {
    const normAbs = path_1.default.normalize(absPath);
    const extras = getEnabledAdditionalFolders(settings)
        .slice()
        .sort((a, b) => b.localPath.length - a.localPath.length);
    for (const mapping of extras) {
        const root = path_1.default.normalize(mapping.localPath);
        if (normAbs === root || normAbs.startsWith(root + path_1.default.sep)) {
            const relWithin = normAbs === root
                ? ''
                : path_1.default.relative(root, normAbs).replace(/\\/g, '/');
            return toAdditionalStoredRel(mapping.id, relWithin);
        }
    }
    if (!settings.syncRootPath)
        return null;
    const main = path_1.default.normalize(settings.syncRootPath);
    if (normAbs === main || normAbs.startsWith(main + path_1.default.sep)) {
        const rel = normAbs === main ? '' : path_1.default.relative(main, normAbs).replace(/\\/g, '/');
        return (0, paths_1.normalizeRelPath)(rel);
    }
    return null;
}
function relWithinSegments(storedRel) {
    const normalized = (0, paths_1.normalizeRelPath)(storedRel);
    if (isAdditionalStoredRel(normalized)) {
        const parsed = parseAdditionalStoredRel(normalized);
        return parsed?.relWithin ? parsed.relWithin.split('/').filter(Boolean) : [];
    }
    return normalized.split('/').filter(Boolean);
}
function storedRelAfterSegments(mappingId, segments) {
    const joined = segments.join('/');
    if (mappingId)
        return toAdditionalStoredRel(mappingId, joined);
    return joined;
}
function mappingIdFromStored(storedRel) {
    if (!isAdditionalStoredRel(storedRel))
        return null;
    return parseAdditionalStoredRel(storedRel)?.mappingId ?? null;
}
/** Parent stored path for folder hierarchy inside a mapping or main root. */
function parentStoredRel(storedRel) {
    const normalized = (0, paths_1.normalizeRelPath)(storedRel);
    if (!normalized)
        return '';
    const idx = normalized.lastIndexOf('/');
    if (idx < 0)
        return '';
    return normalized.slice(0, idx);
}
function pathsConflict(settings, localPath) {
    const norm = path_1.default.normalize(localPath);
    const main = settings.syncRootPath ? path_1.default.normalize(settings.syncRootPath) : '';
    if (main && (norm === main || norm.startsWith(main + path_1.default.sep) || main.startsWith(norm + path_1.default.sep))) {
        return 'This folder overlaps the main sync folder.';
    }
    for (const existing of settings.additionalSyncFolders || []) {
        const root = path_1.default.normalize(existing.localPath);
        if (norm === root)
            return 'This folder is already being synced.';
        if (norm.startsWith(root + path_1.default.sep) || root.startsWith(norm + path_1.default.sep)) {
            return 'This folder overlaps another synced folder.';
        }
    }
    return null;
}
function listRemoteWalkRoots(settings) {
    const roots = ['/'];
    for (const mapping of getEnabledAdditionalFolders(settings)) {
        roots.push(remotePrefixForFolderName(mapping.name));
    }
    return roots;
}
function remotePathToStored(settings, remotePath) {
    const normalized = remotePath.replace(/\\/g, '/');
    const syncContainer = `/${exports.SYNC_CONTAINER_NAME}`;
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
    if (normalized === '/')
        return '';
    if (normalized.startsWith('/')) {
        return (0, paths_1.normalizeRelPath)(normalized.slice(1));
    }
    return null;
}
//# sourceMappingURL=sync-mappings.js.map