import os from 'os';
import { getSettings, updateSettings } from '../db/settings-repo';
import { VaultApiClient } from './api-client';
import { logger } from '../services/logger';
import {
  applyRemoteAgentConfig,
  buildReportedConfig,
  ensureAgentId,
  getAgentDisplayName,
  getAgentPlatform,
  type RemoteAgentConfig,
} from './agent-config';

const HEARTBEAT_MS = 30_000;
const PACKAGE_VERSION = '1.0.0';

export interface AgentClientHooks {
  onRemoteConfig?: (config: RemoteAgentConfig, version: number) => void | Promise<void>;
}

export function startAgentClient(hooks: AgentClientHooks = {}): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async () => {
    if (stopped) return;
    const settings = getSettings();
    if (!settings.serverUrl || !settings.apiKey) return;

    const agentId = ensureAgentId();
    const api = new VaultApiClient({ serverUrl: settings.serverUrl, apiKey: settings.apiKey });
    const body = {
      agentId,
      name: getAgentDisplayName(),
      hostname: os.hostname(),
      platform: getAgentPlatform(),
      clientType: 'vault-sync',
      version: PACKAGE_VERSION,
      appliedConfigVersion: settings.appliedConfigVersion || 0,
      reportedConfig: buildReportedConfig(settings),
    };

    try {
      const register = await api.agentRegister(body);
      if (!register.ok) {
        logger.warn('agent', `Register failed: ${register.error.message}`);
      }

      const heartbeat = await api.agentHeartbeat(body);
      if (!heartbeat.ok) {
        logger.warn('agent', `Heartbeat failed: ${heartbeat.error.message}`);
        return;
      }

      const { configVersion, config } = heartbeat.value;
      if (config && configVersion > (settings.appliedConfigVersion || 0)) {
        applyRemoteAgentConfig(config);
        updateSettings({ appliedConfigVersion: configVersion });
        await hooks.onRemoteConfig?.(config, configVersion);
      }
    } catch (err) {
      logger.warn('agent', `Agent loop error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  tick().catch(() => {});
  timer = setInterval(() => { tick().catch(() => {}); }, HEARTBEAT_MS);

  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };
}
