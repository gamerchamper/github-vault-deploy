/**
 * Generate public/favicon.ico (Vista-style ICO with embedded PNG).
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="7" fill="#5b8cf7"/>
  <path d="M16 7L9 10.5l7 3.5 7-3.5L16 7z" fill="none" stroke="#ffffff" stroke-width="1.4" stroke-linejoin="round"/>
  <path d="M9 21.5l7 3.5 7-3.5" fill="none" stroke="#ffffff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M9 16l7 3.5 7-3.5" fill="none" stroke="#ffffff" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;

function pngToIco(images) {
  const count = images.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const entries = [];
  let offset = 6 + (16 * count);
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry[0] = size === 256 ? 0 : size;
    entry[1] = size === 256 ? 0 : size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

async function main() {
  const out = path.join(__dirname, '../public/favicon.ico');
  const sizes = [16, 32, 48];
  const images = [];
  for (const size of sizes) {
    const png = await sharp(Buffer.from(SVG)).resize(size, size).png().toBuffer();
    images.push({ size, png });
  }
  fs.writeFileSync(out, pngToIco(images));
  console.log(`Wrote ${out} (${images.length} sizes)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
