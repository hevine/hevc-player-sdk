import type { LogLevel, LoggerLike } from '../types';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

/**
 * 结构化日志
 * ------------------------------------------------------------------
 * 统一 JSON 风格上下文 + 时间戳 + requestId（会话级），便于排查。
 * 支持注入宿主 logger；默认走 console。不记录任何敏感数据。
 */
export class Logger implements LoggerLike {
  private readonly level: LogLevel;
  private readonly sink: LoggerLike | undefined;
  private readonly requestId: string;

  constructor(level: LogLevel = 'warn', sink?: LoggerLike) {
    this.level = level;
    this.sink = sink;
    this.requestId = `h265-${Math.random().toString(36).slice(2, 8)}`;
  }

  private emit(level: Exclude<LogLevel, 'silent'>, msg: string, ctx?: Record<string, unknown>): void {
    if (LEVEL_WEIGHT[level] > LEVEL_WEIGHT[this.level]) return;
    const enriched = { ...(ctx ?? {}), rid: this.requestId };
    if (this.sink) {
      this.sink[level]?.(msg, enriched);
      return;
    }
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${this.requestId}] ${msg}`;
    const payload = Object.keys(enriched).length > 1 ? enriched : undefined;
    switch (level) {
      case 'error':
        console.error(line, payload ?? '');
        break;
      case 'warn':
        console.warn(line, payload ?? '');
        break;
      case 'info':
        console.info(line, payload ?? '');
        break;
      case 'debug':
        console.debug(line, payload ?? '');
        break;
    }
  }

  trace(msg: string, ctx?: Record<string, unknown>): void {
    this.emit('debug', msg, ctx);
  }
  debug(msg: string, ctx?: Record<string, unknown>): void {
    this.emit('debug', msg, ctx);
  }
  info(msg: string, ctx?: Record<string, unknown>): void {
    this.emit('info', msg, ctx);
  }
  warn(msg: string, ctx?: Record<string, unknown>): void {
    this.emit('warn', msg, ctx);
  }
  error(msg: string, ctx?: Record<string, unknown>): void {
    this.emit('error', msg, ctx);
  }

  child(tag: string): Logger {
    const parent = this;
    const sink: LoggerLike = {
      trace: (m: string, c?: Record<string, unknown>) => parent.trace(`[${tag}] ${m}`, c),
      debug: (m: string, c?: Record<string, unknown>) => parent.debug(`[${tag}] ${m}`, c),
      info: (m: string, c?: Record<string, unknown>) => parent.info(`[${tag}] ${m}`, c),
      warn: (m: string, c?: Record<string, unknown>) => parent.warn(`[${tag}] ${m}`, c),
      error: (m: string, c?: Record<string, unknown>) => parent.error(`[${tag}] ${m}`, c),
    };
    return new Logger(this.level, sink);
  }
}
