"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeRelPath = normalizeRelPath;
exports.toAbsPath = toAbsPath;
exports.parentPathFromRel = parentPathFromRel;
exports.toRemotePath = toRemotePath;
const path_1 = __importDefault(require("path"));
/** Canonical relative path stored in SQLite (forward slashes). */
function normalizeRelPath(relPath) {
    return relPath.replace(/\\/g, '/').replace(/^\/+/, '');
}
function toAbsPath(syncRoot, relPath) {
    const parts = normalizeRelPath(relPath).split('/').filter(Boolean);
    return path_1.default.join(syncRoot, ...parts);
}
function parentPathFromRel(localRelPath) {
    const normalized = normalizeRelPath(localRelPath);
    const idx = normalized.lastIndexOf('/');
    if (idx < 0)
        return '/';
    return `/${normalized.slice(0, idx)}`;
}
function toRemotePath(localRelPath) {
    return `/${normalizeRelPath(localRelPath)}`;
}
//# sourceMappingURL=paths.js.map