const fs = require('fs');

function readAtomHeader(buf, offset) {
  if (offset + 8 > buf.length) return null;
  let size = buf.readUInt32BE(offset);
  const type = buf.toString('ascii', offset + 4, offset + 8);
  let headerSize = 8;

  if (size === 1 && offset + 16 <= buf.length) {
    size = Number(buf.readBigUInt64BE(offset + 8));
    headerSize = 16;
  } else if (size === 0) {
    size = buf.length - offset;
  }

  if (size < headerSize || offset + size > buf.length) return null;
  return { type, size, offset, headerSize, dataOffset: offset + headerSize };
}

function findAtom(buf, type, start = 0, end = buf.length) {
  let offset = start;
  while (offset + 8 <= end) {
    const atom = readAtomHeader(buf, offset);
    if (!atom) break;
    if (atom.type === type) return atom;
    offset += atom.size;
  }
  return null;
}

function findAtomInChildren(buf, type, parent) {
  const start = parent.dataOffset;
  const end = parent.offset + parent.size;
  let offset = start;
  while (offset + 8 <= end) {
    const atom = readAtomHeader(buf, offset);
    if (!atom) break;
    if (atom.type === type) return atom;
    offset += atom.size;
  }
  return null;
}

function findMoovInBuffer(buf) {
  const moov = findAtom(buf, 'moov');
  if (moov) return moov;

  const moof = findAtom(buf, 'moof');
  if (moof) return moof;

  return null;
}

function extractMoovFromTail(spillPath, fileSize, tailReadSize = 16 * 1024 * 1024) {
  const readSize = Math.min(tailReadSize, fileSize);
  const start = fileSize - readSize;
  const buf = Buffer.alloc(readSize);
  const fd = fs.openSync(spillPath, 'r');
  try {
    fs.readSync(fd, buf, 0, readSize, start);
  } finally {
    fs.closeSync(fd);
  }

  const moov = findMoovInBuffer(buf);
  if (!moov) return null;

  const absoluteOffset = start + moov.offset;
  const moovBuf = Buffer.alloc(moov.size);
  const fd2 = fs.openSync(spillPath, 'r');
  try {
    fs.readSync(fd2, moovBuf, 0, moov.size, absoluteOffset);
  } finally {
    fs.closeSync(fd2);
  }

  return { buffer: moovBuf, offset: absoluteOffset, size: moov.size };
}

function extractMoovFromHead(spillPath, headReadSize = 8 * 1024 * 1024) {
  const buf = Buffer.alloc(headReadSize);
  const fd = fs.openSync(spillPath, 'r');
  try {
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const moov = findMoovInBuffer(buf.slice(0, n));
    if (!moov) return null;
    const moovBuf = Buffer.alloc(moov.size);
    fs.readSync(fd, moovBuf, 0, moov.size, moov.offset);
    return { buffer: moovBuf, offset: moov.offset, size: moov.size };
  } finally {
    fs.closeSync(fd);
  }
}

function extractFtyp(spillPath) {
  const buf = Buffer.alloc(256);
  const fd = fs.openSync(spillPath, 'r');
  try {
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const ftyp = findAtom(buf.slice(0, n), 'ftyp');
    if (!ftyp) return null;
    const out = Buffer.alloc(ftyp.size);
    fs.readSync(fd, out, 0, ftyp.size, 0);
    return out;
  } finally {
    fs.closeSync(fd);
  }
}

/** Shrink the mdat atom header so it matches truncated progressive-download MP4 data. */
function patchTruncatedMdat(buffer, truncateAt) {
  if (!buffer || truncateAt <= 0) return false;

  let offset = 0;
  while (offset + 8 <= buffer.length && offset < truncateAt) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    let headerSize = 8;

    if (size === 1 && offset + 16 <= buffer.length) {
      size = Number(buffer.readBigUInt64BE(offset + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = truncateAt - offset;
    }

    if (size < headerSize) return false;

    if (type === 'mdat') {
      const newSize = truncateAt - offset;
      if (newSize < headerSize) return false;
      if (headerSize === 16) {
        buffer.writeBigUInt64BE(BigInt(newSize), offset + 8);
      } else {
        buffer.writeUInt32BE(newSize, offset);
      }
      return true;
    }

    if (offset + size > truncateAt) break;
    offset += size;
  }

  return false;
}

module.exports = {
  readAtomHeader,
  findAtom,
  findMoovInBuffer,
  extractMoovFromHead,
  extractMoovFromTail,
  extractFtyp,
  patchTruncatedMdat,
};
