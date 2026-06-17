#!/usr/bin/env node

const { startAgent, stopAgent } = require('./agent');

const portArg = process.argv.find((arg) => arg.startsWith('--port='));
const port = portArg ? parseInt(portArg.slice('--port='.length), 10) : undefined;

startAgent({ port }).catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});

function shutdown() {
  stopAgent().finally(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
