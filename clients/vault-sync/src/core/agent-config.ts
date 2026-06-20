import crypto from 'crypto';
import os from 'os';
import path from 'path';
import type { AdditionalSyncFolder, SyncSettings } from '../shared/types';
import { getSettings, updateSettings } from '../db/settings-repo';
import { logger } from '../services/logger';

export interface RemoteAgentConfig {
  syncEnabled?: boolean;
  syncIntervalSeconds?: number;
  syncRootPath?: string;
  excludedPatterns?: string[];
  additionalSyncFolders?: Array<{
    id?: string;
    name?: string;
    localPath: string;
    enabled?: boolean;
  }>;
}

export function ensureAgentId(): string {
  const settings = getSettings();
  if (settings.agentId) return settings.agentId;
  const agentId = crypto.randomUUID();
  updateSettings({ agentId });
  return agentId;
}

export function buildReportedConfig(settings: SyncSettings): RemoteAgentConfig {
  return {
    syncEnabled: settings.syncEnabled,
    syncIntervalSeconds: settings.syncIntervalSeconds,
    syncRootPath: settings.syncRootPath,
    excludedPatterns: settings.excludedPatterns,
    additionalSyncFolders: (settings.additionalSyncFolders || []).map((f) => ({
      id: f.id,
      name: f.name,
      localPath: f.localPath,
      enabled: f.enabled,
    })),
  };
}

export function applyRemoteAgentConfig(config: RemoteAgentConfig): SyncSettings {
  const current = getSettings();
  const patch: Partial<SyncSettings> = {};

  if (config.syncEnabled !== undefined) patch.syncEnabled = !!config.syncEnabled;
  if (config.syncIntervalSeconds !== undefined) patch.syncIntervalSeconds = config.syncIntervalSeconds;
  if (config.syncRootPath !== undefined) patch.syncRootPath = config.syncRootPath;
  if (config.excludedPatterns !== undefined) patch.excludedPatterns = config.excludedPatterns;

  if (config.additionalSyncFolders !== undefined) {
    const now = new Date().toISOString();
    const existing = new Map((current.additionalSyncFolders || []).map((f) => [f.id, f]));
    patch.additionalSyncFolders = config.additionalSyncFolders.map((f) => {
      const prior = f.id ? existing.get(f.id) : undefined;
      const folder: AdditionalSyncFolder = {
        id: f.id || crypto.randomUUID(),
        name: (f.name || path.basename(f.localPath)).trim() || path.basename(f.localPath),
        localPath: f.localPath,
        enabled: f.enabled !== false,
        addedAt: prior?.addedAt || now,
      };
      return folder;
    });
  }

  const next = updateSettings(patch);
  logger.info('agent', 'Applied remote agent config from server');
  return next;
}

export function getAgentDisplayName(): string {
  return process.env.VAULT_AGENT_NAME || os.hostname() || 'Vault Sync';
}

export function getAgentPlatform(): string {
  return `${process.platform} ${process.arch}`;
}
