#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const agentDir = path.join(rootDir, 'future-vault');
const entry = path.join(agentDir, 'src', 'cli.js');
const args = process.argv.slice(2);

const child = spawn(process.execPath, [entry, ...args], {
  cwd: agentDir,
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code || 0);
});
