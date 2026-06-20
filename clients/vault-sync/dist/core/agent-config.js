"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ensureAgentId = ensureAgentId;
exports.buildReportedConfig = buildReportedConfig;
exports.applyRemoteAgentConfig = applyRemoteAgentConfig;
exports.getAgentDisplayName = getAgentDisplayName;
exports.getAgentPlatform = getAgentPlatform;
const crypto_1 = __importDefault(require("crypto"));
const os_1 = __importDefault(require("os"));
const path_1 = __importDefault(require("path"));
const settings_repo_1 = require("../db/settings-repo");
const logger_1 = require("../services/logger");
function ensureAgentId() {
    const settings = (0, settings_repo_1.getSettings)();
    if (settings.agentId)
        return settings.agentId;
    const agentId = crypto_1.default.randomUUID();
    (0, settings_repo_1.updateSettings)({ agentId });
    return agentId;
}
function buildReportedConfig(settings) {
    return {
        syncEnabled: settings.syncEnabled,
        syncIntervalSeconds: settings.syncIntervalSeconds,
        syncRootPath: settings.syncRootPath,
        excludedPatterns: settings.excludedPatterns,
        convertHlsEnabled: settings.convertHlsEnabled,
        additionalSyncFolders: (settings.additionalSyncFolders || []).map((f) => ({
            id: f.id,
            name: f.name,
            localPath: f.localPath,
            enabled: f.enabled,
        })),
    };
}
function applyRemoteAgentConfig(config) {
    const current = (0, settings_repo_1.getSettings)();
    const patch = {};
    if (config.syncEnabled !== undefined)
        patch.syncEnabled = !!config.syncEnabled;
    if (config.syncIntervalSeconds !== undefined)
        patch.syncIntervalSeconds = config.syncIntervalSeconds;
    if (config.syncRootPath !== undefined)
        patch.syncRootPath = config.syncRootPath;
    if (config.excludedPatterns !== undefined)
        patch.excludedPatterns = config.excludedPatterns;
    if (config.convertHlsEnabled !== undefined)
        patch.convertHlsEnabled = !!config.convertHlsEnabled;
    if (config.additionalSyncFolders !== undefined) {
        const now = new Date().toISOString();
        const existing = new Map((current.additionalSyncFolders || []).map((f) => [f.id, f]));
        patch.additionalSyncFolders = config.additionalSyncFolders.map((f) => {
            const prior = f.id ? existing.get(f.id) : undefined;
            const folder = {
                id: f.id || crypto_1.default.randomUUID(),
                name: (f.name || path_1.default.basename(f.localPath)).trim() || path_1.default.basename(f.localPath),
                localPath: f.localPath,
                enabled: f.enabled !== false,
                addedAt: prior?.addedAt || now,
            };
            return folder;
        });
    }
    const next = (0, settings_repo_1.updateSettings)(patch);
    logger_1.logger.info('agent', 'Applied remote agent config from server');
    return next;
}
function getAgentDisplayName() {
    return process.env.VAULT_AGENT_NAME || os_1.default.hostname() || 'Vault Sync';
}
function getAgentPlatform() {
    return `${process.platform} ${process.arch}`;
}
//# sourceMappingURL=agent-config.js.map