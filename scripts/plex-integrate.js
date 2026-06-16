#!/usr/bin/env node
/**
 * CLI: full Plex integration (plugin deploy + bundled patches + library create + sync)
 *
 * Usage:
 *   PLEX_TOKEN=... npm run plex:integrate
 *   node scripts/plex-integrate.js --token ... --user-id 1
 */
require('dotenv').config();

const db = require('../server/db/database');
const plexInstall = require('../server/services/plex-install');

function parseArgs(argv) {
  const opts = { userId: 1, patchBundled: true, runInitialSync: true };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--token') opts.token = argv[++i];
    else if (arg === '--url') opts.plexUrl = argv[++i];
    else if (arg === '--user-id') opts.userId = parseInt(argv[++i], 10);
    else if (arg === '--no-patch') opts.patchBundled = false;
    else if (arg === '--no-sync') opts.runInitialSync = false;
    else if (arg === '--help' || arg === '-h') opts.help = true;
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    console.log(`Usage: npm run plex:integrate -- [--token TOKEN] [--url http://127.0.0.1:32400] [--user-id 1] [--no-patch] [--no-sync]`);
    process.exit(0);
  }

  const token = opts.token || process.env.PLEX_TOKEN;
  if (!token) {
    console.error('Plex token required: --token or PLEX_TOKEN env');
    process.exit(1);
  }

  const user = db.prepare('SELECT id FROM users ORDER BY id ASC LIMIT 1').get();
  const userId = opts.userId || user?.id;
  if (!userId) {
    console.error('No vault user found — sign in once via GitHub first');
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

  const result = await plexInstall.integratePlex(userId, fakeReq, {
    plexUrl: opts.plexUrl || process.env.PLEX_SERVER_URL,
    plexToken: token,
    patchBundled: opts.patchBundled,
    runInitialSync: opts.runInitialSync,
  });

  console.log(JSON.stringify(result, null, 2));
  console.log('\nRestart Plex Media Server to load patched plugins.');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
