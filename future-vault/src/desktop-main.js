const fs = require('fs');
const path = require('path');
const { launchDesktop } = require('./desktop');

async function main() {
  if (process.versions.electron && process.resourcesPath) {
    const bundled = path.join(process.resourcesPath, 'github-vault');
    if (fs.existsSync(path.join(bundled, 'server', 'services', 'plex-sidecar-db-repair.js'))) {
      process.env.GITHUB_VAULT_ROOT = bundled;
    } else {
      process.env.GITHUB_VAULT_ROOT = path.resolve(__dirname, '../..');
    }
  }

  const portArg = process.argv.find((arg) => arg.startsWith('--port='));

  await launchDesktop({
    port: portArg ? parseInt(portArg.slice('--port='.length), 10) : 7420,
  });
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
