#!/usr/bin/env node
/**
 * Validate GitHub Vault Plex agent bundle + runtime registration.
 *
 * Usage:
 *   npm run plex:test-agent
 *   PLEX_TOKEN=... npm run plex:test-agent -- --apply
 */
require('dotenv').config();

const plexPatches = require('../server/services/plex-patches');
const plexClient = require('../server/services/plex-client');

function parseArgs(argv) {
  const opts = { apply: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') opts.apply = true;
    else if (arg === '--token') opts.token = argv[++i];
    else if (arg === '--url') opts.plexUrl = argv[++i];
    else if (arg === '--help' || arg === '-h') opts.help = true;
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log('Usage: npm run plex:test-agent [-- --apply] [--token TOKEN] [--url http://127.0.0.1:32400]');
    process.exit(0);
  }

  const audit = plexPatches.auditPlexLayout();
  const report = {
    bundle: {
      patch: audit.patch_agent,
      appdata: audit.appdata_agent,
      portable: audit.portable_agent,
    },
    runtime: audit.runtime,
    bundled_duplicates: audit.bundled_agent_copies,
  };

  let plexStatus = null;
  const token = opts.token || process.env.PLEX_TOKEN;
  const plexUrl = opts.plexUrl || process.env.PLEX_SERVER_URL || plexClient.DEFAULT_PLEX_URL;

  if (token) {
    try {
      plexStatus = await plexClient.getAgentRegistrationStatus(plexUrl, token);
      report.plex = plexStatus;
      const agentNames = {
        'com.githubvault.plex.agent': 'GitHub Vault',
        'com.plexapp.agents.none': 'Personal Media',
      };
      report.plex.libraries = plexStatus.libraries.map((section) => ({
        ...section,
        agent_label: agentNames[section.agent] || section.agent,
        vault_library: /github[\s_-]?vault/i.test(section.title || '')
          || (section.locations || []).some((loc) => /github[\s_-]?vault/i.test(loc)),
      }));
      if (opts.apply && plexStatus.libraries.length) {
        const target = plexStatus.vault_libraries[0] || plexStatus.libraries.find((section) => (
          /github[\s_-]?vault/i.test(section.title || '')
        ));
        if (target) {
          report.applied = await plexClient.applyGitHubVaultAgent(plexUrl, token, target);
        } else {
          report.apply_error = 'No GitHub Vault library found to update';
        }
      }
    } catch (err) {
      report.plex_error = err.message;
    }
  } else {
    report.plex_skipped = 'Set PLEX_TOKEN to verify library agent assignment via API';
  }

  console.log(JSON.stringify(report, null, 2));

  const issues = [];
  if (audit.bundled_agent_copies.length) {
    issues.push(`Remove bundled duplicate: ${audit.bundled_agent_copies.join(', ')}`);
  }
  if (!audit.patch_agent.ok) issues.push('Patch bundle invalid');
  if (!audit.appdata_agent.ok) issues.push('AppData agent invalid — run npm run plex:install-agent');
  if (!audit.runtime.ok) issues.push(...audit.runtime.issues);

  if (plexStatus && !plexStatus.agent_applied) {
    issues.push('GitHub Vault library is not using com.githubvault.plex.agent — run with --apply or npm run plex:install-agent');
  }

  if (issues.length) {
    console.error('\nIssues:');
    issues.forEach((issue) => console.error(`- ${issue}`));
    process.exit(1);
  }

  console.log('\nAgent bundle + runtime OK.');
  if (audit.runtime.plugin.loaded) {
    console.log('Plex registered com.githubvault.plex.agent — set it under Library → Manage → Edit → Advanced → Agent.');
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
