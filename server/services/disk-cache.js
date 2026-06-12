const fs = require('fs');
const path = require('path');

const cacheDir = path.join(__dirname, '../../data/cache');
const indexPath = path.join(cacheDir, 'index.json');
const configPath = path.join(cacheDir, 'config.json');

function loadMaxBytes() {
  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const gb = parseFloat(cfg.maxGb);
      if (gb > 0) return Math.round(gb * 1024 * 1024 * 1024);
    } catch { /* fall through */ }
  }
  return Math.round((parseFloat(process.env.CACHE_DISK_GB) || 10) * 1024 * 1024 * 1024);
}

let maxBytes = loadMaxBytes();

function getMaxBytes() {
  return maxBytes;
}

function setMaxGb(gb) {
  const parsed = parseFloat(gb);
  if (!Number.isFinite(parsed) || parsed < 0.1 || parsed > 1024) {
    throw new Error('Cache size must be between 0.1 and 1024 GB');
  }
  maxBytes = Math.round(parsed * 1024 * 1024 * 1024);
  fs.writeFileSync(configPath, JSON.stringify({ maxGb: parsed }, null, 2));

  const index = loadIndex();
  while (totalSize(index.entries) > maxBytes && index.entries.length) {
    const candidates = [...index.entries];
    const chunkEntries = candidates.filter((e) => e.type === 'encrypted_chunk');
    const pool = chunkEntries.length ? chunkEntries : candidates;
    pool.sort((a, b) => a.last_accessed - b.last_accessed);
    const oldest = pool[0];
    evictEntry(oldest);
    index.entries = index.entries.filter((e) => e.id !== oldest.id);
  }
  saveIndex(index);
  return getStats();
}
const TOUCH_SAVE_DEBOUNCE_MS = 3000;

if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir, { recursive: true });

let memoryIndex = null;
let touchSaveTimer = null;

function loadIndexFromDisk() {
  if (!fs.existsSync(indexPath)) return { entries: [] };
  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch {
    return { entries: [] };
  }
}

function loadIndex() {
  if (!memoryIndex) memoryIndex = loadIndexFromDisk();
  return memoryIndex;
}

function saveIndex(index, { immediate = true } = {}) {
  memoryIndex = index;
  if (immediate) {
    fs.writeFileSync(indexPath, JSON.stringify(index));
  }
}

function scheduleTouchSave() {
  if (touchSaveTimer) return;
  touchSaveTimer = setTimeout(() => {
    touchSaveTimer = null;
    if (memoryIndex) fs.writeFileSync(indexPath, JSON.stringify(memoryIndex));
  }, TOUCH_SAVE_DEBOUNCE_MS);
}

function fileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function pathSize(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isDirectory()) return stat.size;

    let total = 0;
    for (const name of fs.readdirSync(filePath)) {
      total += pathSize(path.join(filePath, name));
    }
    return total;
  } catch {
    return 0;
  }
}

function removePath(filePath) {
  if (!fs.existsSync(filePath)) return;
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    fs.rmSync(filePath, { recursive: true, force: true });
  } else {
    fs.unlinkSync(filePath);
  }
}

function totalSize(entries) {
  return entries.reduce((sum, entry) => sum + entry.size, 0);
}

function entryId(userId, fileId, type) {
  return `${userId}:${fileId}:${type}`;
}

function evictEntry(entry) {
  for (const file of entry.files) {
    removePath(path.join(cacheDir, file));
  }
}

function ensureSpace(index, needed, excludeId) {
  while (totalSize(index.entries) + needed > maxBytes) {
    const candidates = index.entries.filter((e) => e.id !== excludeId);
    if (!candidates.length) break;
    const chunkEntries = candidates.filter((e) => e.type === 'encrypted_chunk');
    const pool = chunkEntries.length ? chunkEntries : candidates;
    pool.sort((a, b) => a.last_accessed - b.last_accessed);
    const oldest = pool[0];
    evictEntry(oldest);
    index.entries = index.entries.filter((e) => e.id !== oldest.id);
  }
}

function register({ userId, fileId, type, files, name }) {
  const index = loadIndex();
  const id = entryId(userId, fileId, type);

  const existing = index.entries.find((e) => e.id === id);
  if (existing) {
    evictEntry(existing);
    index.entries = index.entries.filter((e) => e.id !== id);
  }

  const size = files.reduce((sum, file) => sum + fileSize(path.join(cacheDir, file)), 0);
  ensureSpace(index, size, id);

  index.entries.push({
    id,
    type,
    files,
    size,
    last_accessed: Date.now(),
    user_id: userId,
    file_id: fileId,
    name: name || null,
  });
  saveIndex(index);
  return id;
}

function touch(userId, fileId, type) {
  const index = loadIndex();
  const id = entryId(userId, fileId, type);
  const entry = index.entries.find((e) => e.id === id);
  if (!entry) return;
  entry.last_accessed = Date.now();
  scheduleTouchSave();
}

function removeByFile(userId, fileId) {
  const index = loadIndex();
  const toRemove = index.entries.filter(
    (e) => String(e.user_id) === String(userId) && e.file_id === fileId
  );
  for (const entry of toRemove) evictEntry(entry);
  index.entries = index.entries.filter(
    (e) => !(String(e.user_id) === String(userId) && e.file_id === fileId)
  );
  saveIndex(index);
}

function removeType(userId, fileId, type) {
  const index = loadIndex();
  const id = entryId(userId, fileId, type);
  const entry = index.entries.find((e) => e.id === id);
  if (!entry) return;
  evictEntry(entry);
  index.entries = index.entries.filter((e) => e.id !== id);
  saveIndex(index);
}

function scan() {
  const index = { entries: [] };
  if (!fs.existsSync(cacheDir)) return index;

  const files = fs.readdirSync(cacheDir);
  const seen = new Set();

  for (const file of files) {
    if (file === 'index.json') continue;

    if (file.endsWith('.faststart.mp4')) {
      const base = file.replace('.faststart.mp4', '');
      const metaFile = `${base}.faststart.json`;
      if (!files.includes(metaFile)) continue;

      const parts = base.split('_');
      const userId = parts[0];
      const fileId = parts.slice(1).join('_');
      const key = entryId(userId, fileId, 'faststart');
      if (seen.has(key)) continue;
      seen.add(key);

      let name = null;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(cacheDir, metaFile), 'utf8'));
        name = meta.name || null;
      } catch { /* ignore */ }

      index.entries.push({
        id: key,
        type: 'faststart',
        files: [file, metaFile],
        size: fileSize(path.join(cacheDir, file)) + fileSize(path.join(cacheDir, metaFile)),
        last_accessed: fs.statSync(path.join(cacheDir, file)).mtimeMs,
        user_id: userId,
        file_id: fileId,
        name,
      });
      continue;
    }

    if (file.endsWith('.enc.bin')) {
      const base = file.replace('.enc.bin', '');
      const parts = base.split('_chunk_');
      if (parts.length !== 2) continue;
      const userId = parts[0];
      const fileId = parts[1];
      const key = entryId(userId, fileId, 'encrypted_chunk');
      if (seen.has(key)) continue;
      seen.add(key);

      index.entries.push({
        id: key,
        type: 'encrypted_chunk',
        files: [file],
        size: fileSize(path.join(cacheDir, file)),
        last_accessed: fs.statSync(path.join(cacheDir, file)).mtimeMs,
        user_id: userId,
        file_id: fileId,
        name: `chunk:${fileId}`,
      });
      continue;
    }

    if (file.endsWith('.thumb.jpg')) {
      const base = file.replace('.thumb.jpg', '');
      const parts = base.split('_');
      const userId = parts[0];
      const fileId = parts.slice(1).join('_');
      const key = entryId(userId, fileId, 'thumbnail');
      if (seen.has(key)) continue;
      seen.add(key);

      index.entries.push({
        id: key,
        type: 'thumbnail',
        files: [file],
        size: fileSize(path.join(cacheDir, file)),
        last_accessed: fs.statSync(path.join(cacheDir, file)).mtimeMs,
        user_id: userId,
        file_id: fileId,
        name: null,
      });
      continue;
    }

    if (file.endsWith('.manifest.json') && !file.endsWith('.faststart.json')) {
      const base = file.replace('.manifest.json', '');
      const parts = base.split('_');
      const userId = parts[0];
      const fileId = parts.slice(1).join('_');
      const key = entryId(userId, fileId, 'manifest');
      if (seen.has(key)) continue;
      seen.add(key);

      index.entries.push({
        id: key,
        type: 'manifest',
        files: [file],
        size: fileSize(path.join(cacheDir, file)),
        last_accessed: fs.statSync(path.join(cacheDir, file)).mtimeMs,
        user_id: userId,
        file_id: fileId,
        name: null,
      });
      continue;
    }

    if (file.startsWith('_lookup_') && file.endsWith('.bin')) {
      const fileId = file.replace('_lookup_', '').replace('.bin', '');
      const key = entryId('_lookup', fileId, 'lookup');
      if (seen.has(key)) continue;
      seen.add(key);

      index.entries.push({
        id: key,
        type: 'lookup',
        files: [file],
        size: fileSize(path.join(cacheDir, file)),
        last_accessed: fs.statSync(path.join(cacheDir, file)).mtimeMs,
        user_id: '_lookup',
        file_id: fileId,
        name: 'cover-art lookup',
      });
      continue;
    }

    if (file.endsWith('.bin') && !file.endsWith('_stream.bin')) {
      const base = file.replace('.bin', '');
      const metaFile = `${base}.json`;
      if (!files.includes(metaFile)) continue;

      const parts = base.split('_');
      const userId = parts[0];
      const fileId = parts.slice(1).join('_');
      const key = entryId(userId, fileId, 'decrypted');
      if (seen.has(key)) continue;
      seen.add(key);

      let name = null;
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(cacheDir, metaFile), 'utf8'));
        name = meta.name || null;
      } catch { /* ignore */ }

      index.entries.push({
        id: key,
        type: 'decrypted',
        files: [file, metaFile],
        size: fileSize(path.join(cacheDir, file)) + fileSize(path.join(cacheDir, metaFile)),
        last_accessed: fs.statSync(path.join(cacheDir, file)).mtimeMs,
        user_id: userId,
        file_id: fileId,
        name,
      });
    }
  }

  while (totalSize(index.entries) > maxBytes && index.entries.length) {
    index.entries.sort((a, b) => a.last_accessed - b.last_accessed);
    evictEntry(index.entries[0]);
    index.entries.shift();
  }

  saveIndex(index);
  return index;
}

function reconcile() {
  const index = loadIndex();
  index.entries = index.entries.filter((entry) =>
    entry.files.every((file) => fs.existsSync(path.join(cacheDir, file)))
  );
  saveIndex(index);
}

function prepareSpace(needed, excludeId = null) {
  const index = loadIndex();
  ensureSpace(index, needed, excludeId);
  saveIndex(index);
}

function clearAll(userId) {
  const index = loadIndex();
  const toRemove = index.entries.filter((e) => String(e.user_id) === String(userId));
  let freed = 0;

  for (const entry of toRemove) {
    freed += entry.size;
    evictEntry(entry);
  }

  index.entries = index.entries.filter((e) => String(e.user_id) !== String(userId));
  saveIndex(index);

  const prefix = `${userId}_`;
  if (fs.existsSync(cacheDir)) {
    for (const file of fs.readdirSync(cacheDir)) {
      if (!file.startsWith(prefix)) continue;
      const filePath = path.join(cacheDir, file);
      freed += pathSize(filePath);
      removePath(filePath);
    }
  }

  return { freed, entries: toRemove.length };
}

function getStats(userId = null) {
  const index = loadIndex();
  let entries = index.entries;
  if (userId != null) {
    entries = entries.filter((e) => String(e.user_id) === String(userId));
  }

  const used = totalSize(entries);
  return {
    used,
    max: maxBytes,
    maxGb: Math.round((maxBytes / (1024 * 1024 * 1024)) * 100) / 100,
    percent: maxBytes > 0 ? Math.round((used / maxBytes) * 1000) / 10 : 0,
    entries: entries.length,
    items: entries
      .sort((a, b) => b.last_accessed - a.last_accessed)
      .slice(0, 20)
      .map((e) => ({
        name: e.name,
        type: e.type,
        size: e.size,
        last_accessed: e.last_accessed,
      })),
  };
}

if (!fs.existsSync(indexPath)) {
  scan();
} else {
  reconcile();
  if (!loadIndex().entries.length) scan();
}

module.exports = {
  cacheDir,
  getMaxBytes,
  setMaxGb,
  register,
  touch,
  removeByFile,
  removeType,
  prepareSpace,
  clearAll,
  getStats,
  scan,
  entryId,
};
