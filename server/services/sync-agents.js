const crypto = require('crypto');
const db = require('../db/database');

const ONLINE_THRESHOLD_MS = 2 * 60 * 1000;

function sanitizeAgentId(id) {
  const value = String(id || '').trim();
  if (!value || value.length > 80) return null;
  return value;
}

function parseDesiredConfig(raw) {
  if (!raw || typeof raw !== 'object') return {};
  const config = {};
  if (raw.syncEnabled !== undefined) config.syncEnabled = !!raw.syncEnabled;
  if (raw.syncIntervalSeconds !== undefined) {
    const n = parseInt(raw.syncIntervalSeconds, 10);
    if (Number.isFinite(n) && n >= 5 && n <= 3600) config.syncIntervalSeconds = n;
  }
  if (raw.syncRootPath !== undefined) config.syncRootPath = String(raw.syncRootPath || '');
  if (Array.isArray(raw.excludedPatterns)) {
    config.excludedPatterns = raw.excludedPatterns.map((p) => String(p)).filter(Boolean).slice(0, 50);
  }
  if (raw.convertHlsEnabled !== undefined) config.convertHlsEnabled = !!raw.convertHlsEnabled;
  if (Array.isArray(raw.additionalSyncFolders)) {
    config.additionalSyncFolders = raw.additionalSyncFolders
      .filter((f) => f && typeof f.localPath === 'string' && f.localPath.trim())
      .map((f) => ({
        id: String(f.id || crypto.randomUUID()),
        name: String(f.name || '').trim() || require('path').basename(f.localPath),
        localPath: String(f.localPath).trim(),
        enabled: f.enabled !== false,
      }))
      .slice(0, 20);
  }
  return config;
}

function rowToAgent(row) {
  if (!row) return null;
  const lastSeen = row.last_seen_at ? new Date(row.last_seen_at).getTime() : 0;
  const online = lastSeen > 0 && (Date.now() - lastSeen) < ONLINE_THRESHOLD_MS;
  let desiredConfig = null;
  if (row.desired_config_json) {
    try { desiredConfig = JSON.parse(row.desired_config_json); } catch { desiredConfig = null; }
  }
  let reportedConfig = null;
  if (row.reported_config_json) {
    try { reportedConfig = JSON.parse(row.reported_config_json); } catch { reportedConfig = null; }
  }
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    platform: row.platform,
    client_type: row.client_type,
    version: row.version,
    api_key_id: row.api_key_id,
    last_seen_at: row.last_seen_at,
    config_version: row.config_version || 0,
    applied_config_version: row.applied_config_version || 0,
    desired_config: desiredConfig,
    reported_config: reportedConfig,
    status: online ? 'online' : (lastSeen ? 'offline' : 'never'),
    created_at: row.created_at,
  };
}

function getAgentForUser(userId, agentId) {
  const row = db.prepare(`
    SELECT * FROM sync_agents WHERE id = ? AND user_id = ?
  `).get(agentId, userId);
  return rowToAgent(row);
}

function registerOrUpdate(userId, apiKeyId, body = {}) {
  const agentId = sanitizeAgentId(body.agentId);
  if (!agentId) throw new Error('agentId is required');

  const name = String(body.name || body.hostname || 'Sync client').trim().slice(0, 120) || 'Sync client';
  const hostname = String(body.hostname || '').trim().slice(0, 200) || null;
  const platform = String(body.platform || '').trim().slice(0, 80) || null;
  const clientType = String(body.clientType || 'vault-sync').trim().slice(0, 40) || 'vault-sync';
  const version = String(body.version || '').trim().slice(0, 40) || null;
  const appliedVersion = parseInt(body.appliedConfigVersion, 10) || 0;

  const existing = db.prepare('SELECT id FROM sync_agents WHERE id = ? AND user_id = ?').get(agentId, userId);
  if (existing) {
    db.prepare(`
      UPDATE sync_agents
      SET name = ?, hostname = ?, platform = ?, client_type = ?, version = ?,
          api_key_id = COALESCE(?, api_key_id), last_seen_at = CURRENT_TIMESTAMP,
          applied_config_version = CASE WHEN ? > applied_config_version THEN ? ELSE applied_config_version END
      WHERE id = ? AND user_id = ?
    `).run(name, hostname, platform, clientType, version, apiKeyId || null, appliedVersion, appliedVersion, agentId, userId);
  } else {
    db.prepare(`
      INSERT INTO sync_agents (
        id, user_id, api_key_id, name, hostname, platform, client_type, version,
        last_seen_at, config_version, applied_config_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 0, ?)
    `).run(agentId, userId, apiKeyId || null, name, hostname, platform, clientType, version, appliedVersion);
  }

  return getAgentForUser(userId, agentId);
}

function heartbeat(userId, apiKeyId, body = {}) {
  const agentId = sanitizeAgentId(body.agentId);
  if (!agentId) throw new Error('agentId is required');

  let agent = db.prepare('SELECT * FROM sync_agents WHERE id = ? AND user_id = ?').get(agentId, userId);
  if (!agent) {
    registerOrUpdate(userId, apiKeyId, body);
    agent = db.prepare('SELECT * FROM sync_agents WHERE id = ? AND user_id = ?').get(agentId, userId);
  }

  const appliedVersion = parseInt(body.appliedConfigVersion, 10);
  const reportedConfig = body.reportedConfig && typeof body.reportedConfig === 'object'
    ? JSON.stringify(body.reportedConfig)
    : null;

  db.prepare(`
    UPDATE sync_agents
    SET last_seen_at = CURRENT_TIMESTAMP,
        api_key_id = COALESCE(?, api_key_id),
        applied_config_version = CASE WHEN ? IS NOT NULL AND ? >= 0 THEN ? ELSE applied_config_version END,
        reported_config_json = COALESCE(?, reported_config_json),
        version = COALESCE(?, version),
        hostname = COALESCE(?, hostname),
        platform = COALESCE(?, platform)
    WHERE id = ? AND user_id = ?
  `).run(
    apiKeyId || null,
    appliedVersion,
    appliedVersion,
    appliedVersion,
    reportedConfig,
    body.version ? String(body.version).slice(0, 40) : null,
    body.hostname ? String(body.hostname).slice(0, 200) : null,
    body.platform ? String(body.platform).slice(0, 80) : null,
    agentId,
    userId,
  );

  agent = db.prepare('SELECT * FROM sync_agents WHERE id = ? AND user_id = ?').get(agentId, userId);
  const parsed = rowToAgent(agent);
  const clientVersion = Number.isFinite(appliedVersion) ? appliedVersion : (parsed.applied_config_version || 0);
  const serverVersion = parsed.config_version || 0;

  if (serverVersion > clientVersion && parsed.desired_config) {
    return {
      ok: true,
      configVersion: serverVersion,
      config: parsed.desired_config,
    };
  }

  return { ok: true, configVersion: serverVersion, config: null };
}

function listAgents(userId) {
  const rows = db.prepare(`
    SELECT * FROM sync_agents
    WHERE user_id = ?
    ORDER BY (last_seen_at IS NULL), last_seen_at DESC, created_at DESC
  `).all(userId);
  return rows.map(rowToAgent);
}

function setDesiredConfig(userId, agentId, body = {}) {
  const agent = db.prepare('SELECT * FROM sync_agents WHERE id = ? AND user_id = ?').get(agentId, userId);
  if (!agent) throw new Error('Agent not found');

  const config = parseDesiredConfig(body.config || body);
  const nextVersion = (agent.config_version || 0) + 1;
  db.prepare(`
    UPDATE sync_agents
    SET desired_config_json = ?, config_version = ?
    WHERE id = ? AND user_id = ?
  `).run(JSON.stringify(config), nextVersion, agentId, userId);

  return getAgentForUser(userId, agentId);
}

function removeAgent(userId, agentId) {
  const result = db.prepare('DELETE FROM sync_agents WHERE id = ? AND user_id = ?').run(agentId, userId);
  return result.changes > 0;
}

module.exports = {
  registerOrUpdate,
  heartbeat,
  listAgents,
  setDesiredConfig,
  removeAgent,
  getAgentForUser,
};
