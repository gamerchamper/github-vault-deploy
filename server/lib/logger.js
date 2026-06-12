const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '../../data/logs');
const MAX_LOG_LINES = 50000;

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function logFile(kind) {
  ensureLogDir();
  const date = new Date().toISOString().slice(0, 10);
  return path.join(LOG_DIR, `${kind}-${date}.log`);
}

function rotate(kind) {
  const file = logFile(kind);
  if (!fs.existsSync(file)) return;
  const stat = fs.statSync(file);
  if (stat.size > 5 * 1024 * 1024) {
    const suffix = Date.now();
    fs.renameSync(file, file.replace('.log', `-${suffix}.log`));
  }
}

function write(kind, level, msg, meta = {}) {
  try {
    rotate(kind);
    const entry = JSON.stringify({
      t: new Date().toISOString(),
      l: level,
      m: msg,
      ...meta,
    });
    fs.appendFileSync(logFile(kind), entry + '\n', 'utf-8');
    if (level === 'ERROR' || level === 'WARN') {
      console.error(`[${level}] ${msg}`, Object.keys(meta).length ? meta : '');
    }
  } catch (err) {
    console.error(`Logger write failed: ${err.message}`);
  }
}

module.exports = {
  info(msg, meta) { write('upload', 'INFO', msg, meta); },
  warn(msg, meta) { write('upload', 'WARN', msg, meta); },
  error(msg, meta) { write('upload', 'ERROR', msg, meta); },
  debug(msg, meta) { write('debug', 'DEBUG', msg, meta); },
  request(req, meta = {}) {
    try {
      const safe = {
        method: req.method,
        path: req.path || req.url,
        userId: req.user?.id || req.session?.passport?.user || 'anon',
        ip: req.ip || req.connection?.remoteAddress,
        ...meta,
      };
      write('requests', 'INFO', `${safe.method} ${safe.path}`, safe);
    } catch {}
  },
};
