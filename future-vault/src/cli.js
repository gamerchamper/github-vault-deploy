#!/usr/bin/env node

const { program } = require('commander');
const { startAgent, stopAgent } = require('./agent');
const { startDesktopProcess } = require('./desktop');
const pkg = require('../package.json');

program
  .name('future-vault')
  .description('Future Vault local agent — Plex sync, cache, and DB repair')
  .version(pkg.version);

program
  .command('start')
  .description('Run the agent server (headless)')
  .option('--port <port>', 'Port to bind', parseInt)
  .action(async (opts) => {
    const { url, config } = await startAgent({ port: opts.port });
    console.log('');
    console.log('  ╔══════════════════════════════════════════════════╗');
    console.log('  ║           F U T U R E   V A U L T                ║');
    console.log('  ╠══════════════════════════════════════════════════╣');
    console.log(`  ║  Dashboard   ${url.padEnd(33)}║`);
    console.log(`  ║  API key     ${config.api_key.slice(0, 20)}…`.padEnd(51) + '║');
    console.log('  ╚══════════════════════════════════════════════════╝');
    console.log('');
  });

program
  .command('desktop')
  .description('Launch the native desktop app')
  .option('--port <port>', 'Agent port', parseInt, 7420)
  .action((opts) => {
    try {
      const child = startDesktopProcess({ port: opts.port });
      child.on('exit', (code, signal) => {
        if (signal) process.kill(process.pid, signal);
        process.exit(code || 0);
      });
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  });

if (require.main === module) {
  if (!process.argv.slice(2).length) {
    process.argv.push('desktop');
  }
  program.parse(process.argv);
}

process.on('SIGINT', () => {
  stopAgent().finally(() => process.exit(0));
});

module.exports = { program };
