/**
 * Clean electron-builder caches that can corrupt on Windows due to symlink issues.
 *
 * The winCodeSign cache contains macOS .dylib files inside .7z archives.
 * 7-Zip extraction fails on Windows when the user lacks symlink creation
 * privileges. Clearing this cache forces a clean re-download.
 *
 * Usage: node scripts/clean-cache.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const cacheRoot = process.env.ELECTRON_BUILDER_CACHE
  || path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache');

const dirs = ['winCodeSign', 'nsis', 'nsis-resources'];

for (const name of dirs) {
  const dir = path.join(cacheRoot, name);
  if (fs.existsSync(dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`Cleared: ${dir}`);
    } catch (err) {
      console.error(`Failed to clear ${dir}: ${err.message}`);
    }
  } else {
    console.log(`Not present: ${dir}`);
  }
}

console.log('\nCache cleanup complete. Next build will re-download clean packages.');
console.log('If you still get symlink errors, try running terminal as Administrator');
console.log('or enable Windows Developer Mode (Settings → Update → For developers).');
