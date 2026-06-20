"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
const path_1 = __importDefault(require("path"));
const crypto_1 = __importDefault(require("crypto"));
const database_1 = require("./db/database");
const settings_repo_1 = require("./db/settings-repo");
const queueRepo = __importStar(require("./db/queue-repo"));
const sync_engine_1 = require("./core/sync-engine");
const file_watcher_1 = require("./core/file-watcher");
const upload_queue_1 = require("./core/upload-queue");
const logger_1 = require("./services/logger");
const agent_client_1 = require("./core/agent-client");
const runtime_1 = require("./core/runtime");
dotenv_1.default.config();
function parseAdditionalFoldersFromEnv(raw) {
    if (!raw?.trim())
        return [];
    const now = new Date().toISOString();
    try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            return parsed
                .filter((f) => f && typeof f.localPath === 'string')
                .map((f) => ({
                id: f.id || crypto_1.default.randomUUID(),
                name: f.name || path_1.default.basename(f.localPath),
                localPath: f.localPath,
                enabled: f.enabled !== false,
                addedAt: now,
            }));
        }
    }
    catch {
        // fall through to comma-separated paths
    }
    return raw.split(',')
        .map((p) => p.trim())
        .filter(Boolean)
        .map((localPath) => ({
        id: crypto_1.default.randomUUID(),
        name: path_1.default.basename(localPath),
        localPath,
        enabled: true,
        addedAt: now,
    }));
}
function applyEnvSettings() {
    const patch = {};
    if (process.env.VAULT_URL)
        patch.serverUrl = process.env.VAULT_URL.replace(/\/+$/, '');
    if (process.env.VAULT_API_KEY)
        patch.apiKey = process.env.VAULT_API_KEY;
    if (process.env.VAULT_SYNC_ROOT)
        patch.syncRootPath = process.env.VAULT_SYNC_ROOT;
    else if (!(0, settings_repo_1.getSettings)().syncRootPath)
        patch.syncRootPath = (0, runtime_1.getDefaultSyncRoot)();
    if (process.env.VAULT_SYNC_INTERVAL) {
        const n = parseInt(process.env.VAULT_SYNC_INTERVAL, 10);
        if (Number.isFinite(n) && n >= 5)
            patch.syncIntervalSeconds = n;
    }
    if (process.env.VAULT_SYNC_ENABLED !== undefined) {
        patch.syncEnabled = process.env.VAULT_SYNC_ENABLED !== '0' && process.env.VAULT_SYNC_ENABLED !== 'false';
    }
    if (process.env.VAULT_CONVERT_HLS !== undefined) {
        patch.convertHlsEnabled = process.env.VAULT_CONVERT_HLS !== '0' && process.env.VAULT_CONVERT_HLS !== 'false';
    }
    const extra = parseAdditionalFoldersFromEnv(process.env.VAULT_ADDITIONAL_FOLDERS);
    if (extra.length)
        patch.additionalSyncFolders = extra;
    if (Object.keys(patch).length)
        (0, settings_repo_1.updateSettings)(patch);
}
async function main() {
    const dataDir = (0, runtime_1.getDefaultDataDir)();
    (0, runtime_1.ensureDataDir)(dataDir);
    (0, database_1.openDatabase)(dataDir);
    const queueReset = queueRepo.prepareQueueAfterRestart();
    if (queueReset.deduped > 0 || queueReset.cancelled > 0 || queueReset.sessionsCleared > 0) {
        logger_1.logger.info('cli', `Queue cleanup: ${queueReset.deduped} duplicate(s), ${queueReset.cancelled} invalid, ${queueReset.sessionsCleared} stale session(s) cleared`);
    }
    applyEnvSettings();
    const settings = (0, settings_repo_1.getSettings)();
    if (!settings.serverUrl || !settings.apiKey) {
        console.error('Set VAULT_URL and VAULT_API_KEY in .env (or environment) before starting the CLI sync client.');
        process.exit(1);
    }
    (0, sync_engine_1.onSyncStateChange)((state) => {
        logger_1.logger.info('cli', `Sync state: ${state.status} (pending uploads: ${state.pendingUploads})`);
    });
    (0, runtime_1.restartWatchers)();
    (0, upload_queue_1.startProcessing)(2000);
    (0, upload_queue_1.kickQueue)();
    await (0, sync_engine_1.startSyncLoop)();
    const stopAgent = (0, agent_client_1.startAgentClient)({
        onRemoteConfig: () => (0, runtime_1.onRemoteConfigApplied)(),
    });
    logger_1.logger.info('cli', `Vault Sync CLI running (data: ${dataDir}, root: ${(0, settings_repo_1.getSettings)().syncRootPath})`);
    const shutdown = () => {
        logger_1.logger.info('cli', 'Shutting down...');
        stopAgent();
        (0, sync_engine_1.stopSyncLoop)();
        (0, file_watcher_1.stopWatcher)();
        (0, upload_queue_1.stopProcessing)();
        (0, database_1.closeDatabase)();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map