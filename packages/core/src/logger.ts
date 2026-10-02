import { appendFile, appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { LogLine } from '@fbrx/shared';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

export interface LogSinkOptions {
  dir?: string;
  console?: boolean;
  level?: Level;
  retentionDays?: number;
}

/**
 * Shared sink: ring buffer for the UI, daily rotating files for support, optional console. File writes are batched
 * and asynchronous (a synchronous write per line stalls the app on slow or busy disks); warnings and errors are
 * written straight away so they survive a crash.
 */
export class LogSink {
  private readonly ring: LogLine[] = [];
  private readonly max = 3000;
  private readonly minLevel: number;
  private currentFile: string | null = null;
  private currentDay = '';
  private buffer: string[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: LogSinkOptions = {}) {
    this.minLevel = LEVELS[opts.level ?? 'info'];
    if (opts.dir) {
      mkdirSync(opts.dir, { recursive: true });
      this.prune();
    }
  }

  write(line: LogLine): void {
    if (LEVELS[line.level] < this.minLevel) return;
    this.ring.push(line);
    if (this.ring.length > this.max) this.ring.splice(0, this.ring.length - this.max);
    const text = `${line.ts} ${line.level.toUpperCase().padEnd(5)} [${line.scope}] ${line.message}${
      line.data !== undefined ? ` ${safeStringify(line.data)}` : ''
    }`;
    if (this.opts.console) {
      (line.level === 'error' ? console.error : line.level === 'warn' ? console.warn : console.log)(text);
    }
    if (this.opts.dir) {
      const day = line.ts.slice(0, 10);
      if (day !== this.currentDay) {
        this.flush();
        if (this.currentDay) this.prune();
        this.currentDay = day;
        this.currentFile = join(this.opts.dir, `fbrx-${day}.log`);
      }
      this.buffer.push(`${text}\n`);
      if (LEVELS[line.level] >= LEVELS.warn || this.buffer.length > 500) this.flush();
      else if (!this.timer) {
        this.timer = setTimeout(() => this.flushAsync(), 500);
        this.timer.unref?.();
      }
    }
  }

  /** Writes buffered lines now (on warnings and errors, at shutdown). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.buffer.length || !this.currentFile) return;
    const chunk = this.buffer.join('');
    this.buffer = [];
    try {
      appendFileSync(this.currentFile, chunk);
    } catch {
      /* disk full or permissions: keep running, the ring buffer still works */
    }
  }

  private flushAsync(): void {
    this.timer = null;
    if (!this.buffer.length || !this.currentFile) return;
    const chunk = this.buffer.join('');
    this.buffer = [];
    appendFile(this.currentFile, chunk, () => undefined);
  }

  tail(lines = 200, level?: Level): LogLine[] {
    const min = level ? LEVELS[level] : 0;
    return this.ring.filter((l) => LEVELS[l.level] >= min).slice(-lines);
  }

  private prune(): void {
    const keep = this.opts.retentionDays ?? 14;
    const cutoff = Date.now() - keep * 86400_000;
    try {
      for (const f of readdirSync(this.opts.dir!)) {
        const m = /^fbrx-(\d{4}-\d{2}-\d{2})\.log$/.exec(f);
        if (m && new Date(m[1]).getTime() < cutoff) rmSync(join(this.opts.dir!, f), { force: true });
      }
    } catch {
      /* ignore */
    }
  }
}

export class Logger {
  constructor(
    private readonly sink: LogSink,
    readonly scope: string,
  ) {}

  child(scope: string): Logger {
    return new Logger(this.sink, `${this.scope}:${scope}`);
  }

  debug(message: string, data?: unknown) {
    this.log('debug', message, data);
  }
  info(message: string, data?: unknown) {
    this.log('info', message, data);
  }
  warn(message: string, data?: unknown) {
    this.log('warn', message, data);
  }
  error(message: string, data?: unknown) {
    this.log('error', message, data);
  }

  private log(level: Level, message: string, data?: unknown) {
    this.sink.write({ ts: new Date().toISOString(), level, scope: this.scope, message, data: normalize(data) });
  }
}

function normalize(data: unknown): unknown {
  if (data instanceof Error) return { error: data.message, stack: data.stack?.split('\n').slice(0, 6).join('\n') };
  return data;
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
