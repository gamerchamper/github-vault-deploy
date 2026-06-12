#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const clientDir = path.join(rootDir, 'clients', 'vault-upload');
const clientEntry = path.join(clientDir, 'src', 'index.js');
const args = process.argv.slice(2);

const child = spawn(process.execPath, [clientEntry, ...args], {
  cwd: clientDir,
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code || 0);
});
