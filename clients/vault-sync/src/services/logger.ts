const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LOG_LEVELS;

class Logger {
  private level: LogLevel = 'info';
  private onLog: ((level: LogLevel, category: string, message: string, details?: unknown) => void) | null = null;

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  setHandler(handler: (level: LogLevel, category: string, message: string, details?: unknown) => void): void {
    this.onLog = handler;
  }

  private emit(level: LogLevel, category: string, message: string, details?: unknown): void {
    if (LOG_LEVELS[level] < LOG_LEVELS[this.level]) return;
    const sanitized = details ? this.sanitize(details) : undefined;
    const ts = new Date().toISOString();
    const prefix = `[${ts}] [${level.toUpperCase()}] [${category}]`;
    const line = sanitized ? `${prefix} ${message} ${JSON.stringify(sanitized)}` : `${prefix} ${message}`;
    if (level === 'error') console.error(line);
    else if (level === 'warn') console.warn(line);
    else console.log(line);
    if (this.onLog) this.onLog(level, category, message, sanitized);
  }

  private sanitize(obj: unknown): unknown {
    if (typeof obj !== 'object' || !obj) return obj;
    const seen = new WeakSet();
    const replacer = (key: string, val: unknown): unknown => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      const lower = key.toLowerCase();
      if (lower.includes('token') || lower.includes('secret') || lower.includes('key') || lower.includes('password')) {
        if (typeof val === 'string' && val.length > 8) return val.slice(0, 4) + '****' + val.slice(-4);
      }
      return val;
    };
    return JSON.parse(JSON.stringify(obj, replacer));
  }

  debug(category: string, message: string, details?: unknown): void { this.emit('debug', category, message, details); }
  info(category: string, message: string, details?: unknown): void { this.emit('info', category, message, details); }
  warn(category: string, message: string, details?: unknown): void { this.emit('warn', category, message, details); }
  error(category: string, message: string, details?: unknown): void { this.emit('error', category, message, details); }
}

export const logger = new Logger();
