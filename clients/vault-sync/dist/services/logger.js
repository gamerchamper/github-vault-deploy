"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.logger = void 0;
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
class Logger {
    level = 'info';
    onLog = null;
    setLevel(level) {
        this.level = level;
    }
    setHandler(handler) {
        this.onLog = handler;
    }
    emit(level, category, message, details) {
        if (LOG_LEVELS[level] < LOG_LEVELS[this.level])
            return;
        const sanitized = details ? this.sanitize(details) : undefined;
        const ts = new Date().toISOString();
        const prefix = `[${ts}] [${level.toUpperCase()}] [${category}]`;
        const line = sanitized ? `${prefix} ${message} ${JSON.stringify(sanitized)}` : `${prefix} ${message}`;
        if (level === 'error')
            console.error(line);
        else if (level === 'warn')
            console.warn(line);
        else
            console.log(line);
        if (this.onLog)
            this.onLog(level, category, message, sanitized);
    }
    sanitize(obj) {
        if (typeof obj !== 'object' || !obj)
            return obj;
        const seen = new WeakSet();
        const replacer = (key, val) => {
            if (typeof val === 'object' && val !== null) {
                if (seen.has(val))
                    return '[Circular]';
                seen.add(val);
            }
            const lower = key.toLowerCase();
            if (lower.includes('token') || lower.includes('secret') || lower.includes('key') || lower.includes('password')) {
                if (typeof val === 'string' && val.length > 8)
                    return val.slice(0, 4) + '****' + val.slice(-4);
            }
            return val;
        };
        return JSON.parse(JSON.stringify(obj, replacer));
    }
    debug(category, message, details) { this.emit('debug', category, message, details); }
    info(category, message, details) { this.emit('info', category, message, details); }
    warn(category, message, details) { this.emit('warn', category, message, details); }
    error(category, message, details) { this.emit('error', category, message, details); }
}
exports.logger = new Logger();
//# sourceMappingURL=logger.js.map