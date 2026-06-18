"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeFileHash = computeFileHash;
exports.computeBufferHash = computeBufferHash;
exports.shortenHash = shortenHash;
const crypto_1 = __importDefault(require("crypto"));
const fs_1 = __importDefault(require("fs"));
function computeFileHash(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto_1.default.createHash('sha256');
        const stream = fs_1.default.createReadStream(filePath);
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}
function computeBufferHash(buffer) {
    return crypto_1.default.createHash('sha256').update(buffer).digest('hex');
}
function shortenHash(hash, length = 12) {
    return hash.slice(0, length);
}
//# sourceMappingURL=hasher.js.map