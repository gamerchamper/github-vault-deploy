const fs = require('fs');

const files = [
  'public/css/share.css',
  'public/css/explorer.css',
  'public/css/playlists.css',
  'public/css/media.css',
];

for (const f of files) {
  let s = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

  s = s.replace(/\n\s*-webkit-backdrop-filter:\s*;\s*\n\s*-webkit-backdrop-filter:\s*;\s*\n\s*backdrop-filter:\s*;\s*\n/g, '\n');
  s = s.replace(/-webkit-backdrop-filter:\s*;\s*backdrop-filter:\s*;/g,
    '-webkit-backdrop-filter: blur(30px); backdrop-filter: blur(30px);');
  s = s.replace(
    /background: rgba\(0,0,0,0\.45\); -webkit-backdrop-filter:\s*;\s*\n\s*-webkit-backdrop-filter:\s*;\s*\n\s*backdrop-filter:\s*;\s*z-index:/g,
    'background: rgba(0,0,0,0.45); -webkit-backdrop-filter: blur(4px);\n  backdrop-filter: blur(4px);\n  z-index:',
  );

  s = s.replace(
    /(background:\s*var\(--glass-bg\);\s*\n)(?!\s*-webkit-backdrop-filter)/g,
    '$1  -webkit-backdrop-filter: blur(20px);\n  backdrop-filter: blur(20px);\n',
  );

  s = s.replace(
    /(\.share-top-dock \{[\s\S]*?)-webkit-backdrop-filter: blur\(20px\);\s*\n\s*backdrop-filter: blur\(20px\);/,
    '$1-webkit-backdrop-filter: blur(16px);\n  backdrop-filter: blur(16px);',
  );
  s = s.replace(
    /(\.share-playlist-panel \{[\s\S]*?)-webkit-backdrop-filter: blur\(20px\);\s*\n\s*backdrop-filter: blur\(20px\);/,
    '$1-webkit-backdrop-filter: blur(16px);\n  backdrop-filter: blur(16px);',
  );

  s = s.replace(
    /(?<!-webkit-user-select:[^\n]*\n)(\s*)user-select:\s*([^;]+);/g,
    (m, indent, val) => `${indent}-webkit-user-select: ${val};\n${indent}user-select: ${val};`,
  );
  s = s.replace(/-webkit-user-select: ([^;]+);\s*\n\s*-webkit-user-select: \1;/g, '-webkit-user-select: $1;');

  fs.writeFileSync(f, s);
  console.log('repaired', f);
}
