"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSettings = getSettings;
exports.updateSettings = updateSettings;
const database_1 = require("./database");
const DEFAULTS = {
    syncEnabled: true,
    syncIntervalSeconds: 30,
    uploadConcurrency: 2,
    excludedPatterns: ['*.tmp', '*.part', '*.crdownload', '~$*', '.DS_Store', 'Thumbs.db', 'desktop.ini'],
    autoStart: false,
    notificationsEnabled: true,
    lastSyncCursor: null,
    additionalSyncFolders: [],
    agentId: '',
    appliedConfigVersion: 0,
};
function getSettings() {
    const db = (0, database_1.getDatabase)();
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const map = {};
    for (const row of rows)
        map[row.key] = row.value;
    return {
        syncEnabled: map.syncEnabled !== '0',
        syncIntervalSeconds: parseInt(map.syncIntervalSeconds || String(DEFAULTS.syncIntervalSeconds), 10),
        uploadConcurrency: parseInt(map.uploadConcurrency || String(DEFAULTS.uploadConcurrency), 10),
        syncRootPath: map.syncRootPath || '',
        serverUrl: map.serverUrl || '',
        apiKey: map.apiKey || '',
        excludedPatterns: parseJsonArray(map.excludedPatterns, DEFAULTS.excludedPatterns),
        autoStart: map.autoStart === '1',
        notificationsEnabled: map.notificationsEnabled !== '0',
        lastSyncCursor: map.lastSyncCursor || null,
        additionalSyncFolders: parseAdditionalFolders(map.additionalSyncFolders),
        agentId: map.agentId || '',
        appliedConfigVersion: parseInt(map.appliedConfigVersion || '0', 10) || 0,
    };
}
function updateSettings(patch) {
    const db = (0, database_1.getDatabase)();
    const upsert = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
    if (patch.syncEnabled !== undefined)
        upsert.run('syncEnabled', patch.syncEnabled ? '1' : '0');
    if (patch.syncIntervalSeconds !== undefined)
        upsert.run('syncIntervalSeconds', String(patch.syncIntervalSeconds));
    if (patch.uploadConcurrency !== undefined)
        upsert.run('uploadConcurrency', String(patch.uploadConcurrency));
    if (patch.syncRootPath !== undefined)
        upsert.run('syncRootPath', patch.syncRootPath);
    if (patch.serverUrl !== undefined)
        upsert.run('serverUrl', patch.serverUrl);
    if (patch.apiKey !== undefined)
        upsert.run('apiKey', patch.apiKey);
    if (patch.excludedPatterns !== undefined)
        upsert.run('excludedPatterns', JSON.stringify(patch.excludedPatterns));
    if (patch.autoStart !== undefined)
        upsert.run('autoStart', patch.autoStart ? '1' : '0');
    if (patch.notificationsEnabled !== undefined)
        upsert.run('notificationsEnabled', patch.notificationsEnabled ? '1' : '0');
    if (patch.lastSyncCursor !== undefined)
        upsert.run('lastSyncCursor', patch.lastSyncCursor || '');
    if (patch.additionalSyncFolders !== undefined) {
        upsert.run('additionalSyncFolders', JSON.stringify(patch.additionalSyncFolders));
    }
    if (patch.agentId !== undefined)
        upsert.run('agentId', patch.agentId);
    if (patch.appliedConfigVersion !== undefined)
        upsert.run('appliedConfigVersion', String(patch.appliedConfigVersion));
    return getSettings();
}
function parseAdditionalFolders(raw) {
    if (!raw)
        return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed))
            return [];
        return parsed.filter((f) => f && typeof f.id === 'string' && typeof f.localPath === 'string');
    }
    catch {
        return [];
    }
}
function parseJsonArray(raw, fallback) {
    if (!raw)
        return fallback;
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : fallback;
    }
    catch {
        return fallback;
    }
}
//# sourceMappingURL=settings-repo.js.map