#!/usr/bin/env node
/**
 * Audit GitHub Vault Plex plugin layout (repo portable tree + AppData).
 */
require('dotenv').config();

const plexPatches = require('../server/services/plex-patches');

function main() {
  const audit = plexPatches.auditPlexLayout();
  console.log(JSON.stringify(audit, null, 2));

  const issues = [];
  if (audit.bundled_agent_copies.length) {
    issues.push(`Remove bundled agent copies: ${audit.bundled_agent_copies.join(', ')}`);
  }
  if (!audit.appdata_agent.ok) {
    issues.push(`AppData agent invalid/missing: ${audit.appdata.path}`);
  }
  if (audit.portable_agent && !audit.portable_agent.ok) {
    issues.push(`Portable repo agent invalid: ${audit.portable_agent.path}`);
  }
  if (!audit.patch_agent.ok) {
    issues.push('integrate/plex/patches/GitHubVaultAgent.bundle is incomplete');
  }

  if (!audit.runtime.ok) {
    issues.push(...audit.runtime.issues);
  }

  if (issues.length) {
    console.error('\nIssues:');
    issues.forEach((issue) => console.error(`- ${issue}`));
    process.exit(1);
  }

  console.log('\nPlex plugin layout OK. Restart Plex Media Server after npm run plex:install-agent.');
}

main();
