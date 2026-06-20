"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.startAgentClient = startAgentClient;
const os_1 = __importDefault(require("os"));
const settings_repo_1 = require("../db/settings-repo");
const api_client_1 = require("./api-client");
const logger_1 = require("../services/logger");
const agent_config_1 = require("./agent-config");
const HEARTBEAT_MS = 30_000;
const PACKAGE_VERSION = '1.0.0';
function startAgentClient(hooks = {}) {
    let stopped = false;
    let timer = null;
    const tick = async () => {
        if (stopped)
            return;
        const settings = (0, settings_repo_1.getSettings)();
        if (!settings.serverUrl || !settings.apiKey)
            return;
        const agentId = (0, agent_config_1.ensureAgentId)();
        const api = new api_client_1.VaultApiClient({ serverUrl: settings.serverUrl, apiKey: settings.apiKey });
        const body = {
            agentId,
            name: (0, agent_config_1.getAgentDisplayName)(),
            hostname: os_1.default.hostname(),
            platform: (0, agent_config_1.getAgentPlatform)(),
            clientType: 'vault-sync',
            version: PACKAGE_VERSION,
            appliedConfigVersion: settings.appliedConfigVersion || 0,
            reportedConfig: (0, agent_config_1.buildReportedConfig)(settings),
        };
        try {
            const register = await api.agentRegister(body);
            if (!register.ok) {
                logger_1.logger.warn('agent', `Register failed: ${register.error.message}`);
            }
            const heartbeat = await api.agentHeartbeat(body);
            if (!heartbeat.ok) {
                logger_1.logger.warn('agent', `Heartbeat failed: ${heartbeat.error.message}`);
                return;
            }
            const { configVersion, config } = heartbeat.value;
            if (config && configVersion > (settings.appliedConfigVersion || 0)) {
                (0, agent_config_1.applyRemoteAgentConfig)(config);
                (0, settings_repo_1.updateSettings)({ appliedConfigVersion: configVersion });
                await hooks.onRemoteConfig?.(config, configVersion);
            }
        }
        catch (err) {
            logger_1.logger.warn('agent', `Agent loop error: ${err instanceof Error ? err.message : String(err)}`);
        }
    };
    tick().catch(() => { });
    timer = setInterval(() => { tick().catch(() => { }); }, HEARTBEAT_MS);
    return () => {
        stopped = true;
        if (timer)
            clearInterval(timer);
    };
}
//# sourceMappingURL=agent-client.js.map