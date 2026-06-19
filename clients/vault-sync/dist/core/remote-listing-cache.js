"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RemoteListingCache = void 0;
class RemoteListingCache {
    api;
    cache = new Map();
    constructor(api) {
        this.api = api;
    }
    async listFolder(parentPath) {
        if (this.cache.has(parentPath))
            return this.cache.get(parentPath);
        const files = [];
        let offset = 0;
        for (;;) {
            const result = await this.api.listFiles(parentPath, 500, offset);
            if (!result.ok) {
                this.cache.set(parentPath, null);
                return null;
            }
            files.push(...result.value.files);
            if (!result.value.hasMore || result.value.nextOffset === undefined)
                break;
            offset = result.value.nextOffset;
        }
        this.cache.set(parentPath, files);
        return files;
    }
    async findByNameAndSize(parentPath, name, size) {
        const files = await this.listFolder(parentPath);
        if (!files)
            return null;
        return files.find((file) => {
            if (file.isFolder || file.is_folder)
                return false;
            return file.name === name && file.size === size;
        }) ?? null;
    }
    async hasFileId(parentPath, fileId) {
        const files = await this.listFolder(parentPath);
        if (files === null)
            return null;
        return files.some((file) => file.id === fileId);
    }
}
exports.RemoteListingCache = RemoteListingCache;
//# sourceMappingURL=remote-listing-cache.js.map