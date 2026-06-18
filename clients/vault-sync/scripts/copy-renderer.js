/**
 * Copy renderer assets (HTML, CSS, JS) from src/renderer/ to dist/renderer/.
 * TypeScript only compiles .ts files; this ensures the static assets
 * are available in the output directory for packaging.
 */
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'src', 'renderer');
const dest = path.join(__dirname, '..', 'dist', 'renderer');

fs.mkdirSync(dest, { recursive: true });

const files = fs.readdirSync(src);
for (const name of files) {
  const srcPath = path.join(src, name);
  const destPath = path.join(dest, name);
  if (fs.statSync(srcPath).isFile()) {
    fs.copyFileSync(srcPath, destPath);
    console.log(`Copied renderer: ${name}`);
  }
}
