#!/usr/bin/env node
/**
 * Install GitHub Vault Plex agent locally (Plug-ins + bundled patches + library agent).
 *
 * Usage:
 *   PLEX_TOKEN=... npm run plex:install-agent
 *   node scripts/plex-install-agent.js --token ... --url http://127.0.0.1:32400
 */
require('dotenv').config();

const db = require('../server/db/database');
const plexInstall = require('../server/services/plex-install');

function parseArgs(argv) {
  const opts = { patchBundled: true, applyAgent: true };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--token') opts.token = argv[++i];
    else if (arg === '--url') opts.plexUrl = argv[++i];
    else if (arg === '--library-path') opts.plexLibraryPath = argv[++i];
    else if (arg === '--user-id') opts.userId = parseInt(argv[++i], 10);
    else if (arg === '--no-patch') opts.patchBundled = false;
    else if (arg === '--no-agent') opts.applyAgent = false;
    else if (arg === '--help' || arg === '-h') opts.help = true;
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log('Usage: npm run plex:install-agent -- [--token TOKEN] [--url http://127.0.0.1:32400] [--library-path PATH]');
    process.exit(0);
  }

  const user = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
  const userId = Number.isFinite(opts.userId) ? opts.userId : user?.id;
  if (!userId) {
    console.error('No vault user found — sign in once via GitHub first, or pass --user-id');
    process.exit(1);
  }

  const fakeReq = {
    protocol: 'http',
    get(name) {
      if (name === 'host') return process.env.APP_HOST || 'localhost:3000';
      return undefined;
    },
    headers: { 'x-forwarded-proto': process.env.APP_URL?.startsWith('https') ? 'https' : 'http' },
  };

  const result = await plexInstall.installAgentLocally(userId, fakeReq, {
    plexUrl: opts.plexUrl || process.env.PLEX_SERVER_URL,
    plexToken: opts.token || process.env.PLEX_TOKEN,
    plexLibraryPath: opts.plexLibraryPath || process.env.PLEX_LIBRARY_PATH,
    patchBundled: opts.patchBundled,
    applyAgent: opts.applyAgent,
  });

  console.log(JSON.stringify(result, null, 2));
  if (result.restart_plex) {
    console.log('\nRestart Plex Media Server, then confirm Agent dropdown shows "GitHub Vault".');
  }
  if (result.agent_apply_error) {
    console.warn(`\nLibrary agent not applied yet: ${result.agent_apply_error}`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
