#!/usr/bin/env node
/**
 * Patch Plex library DB so vault .strm items use remote HTTP URLs + stream metadata.
 * Run after Plex restarts (startup scan resets paths back to local .strm files).
 */
require('dotenv').config();

const sidecarDbRepair = require('../server/services/plex-sidecar-db-repair');

function main() {
  const paths = sidecarDbRepair.discoverVaultLibraryPaths();
  if (!paths.length) {
    console.error('No GitHub Vault library folders with .strm files found.');
    console.error('Set PLEX_VAULT_LIBRARY_PATH or sync content into Plex Media Server/GitHub Vault');
    process.exit(1);
  }

  let exitCode = 0;
  for (const libraryPath of paths) {
    const before = sidecarDbRepair.auditVaultLibraryPlayback(libraryPath);
    console.log(`\n${libraryPath}`);
    console.log('  before:', before);

    if (before.needs_repair === 0) {
      console.log('  already ready');
      continue;
    }

    const repair = sidecarDbRepair.repairVaultLibraryFromSidecars(libraryPath);
    const after = sidecarDbRepair.auditVaultLibraryPlayback(libraryPath);
    console.log(`  repaired: ${repair.repaired}/${repair.total_strm}`);
    console.log('  after:', after);

    if (after.needs_repair > 0) exitCode = 1;
  }

  process.exit(exitCode);
}

main();
