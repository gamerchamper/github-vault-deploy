declare const LOG_LEVELS: {
    readonly debug: 0;
    readonly info: 1;
    readonly warn: 2;
    readonly error: 3;
};
type LogLevel = keyof typeof LOG_LEVELS;
declare class Logger {
    private level;
    private onLog;
    setLevel(level: LogLevel): void;
    setHandler(handler: (level: LogLevel, category: string, message: string, details?: unknown) => void): void;
    private emit;
    private sanitize;
    debug(category: string, message: string, details?: unknown): void;
    info(category: string, message: string, details?: unknown): void;
    warn(category: string, message: string, details?: unknown): void;
    error(category: string, message: string, details?: unknown): void;
}
export declare const logger: Logger;
export {};
//# sourceMappingURL=logger.d.ts.map