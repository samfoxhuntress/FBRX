import type { DatabaseSync, StatementSync, SQLInputValue } from 'node:sqlite';
import { loadSqlite } from './sqlite';

export type SqlParam = SQLInputValue;
export interface Migration {
  version: number;
  name: string;
  up: string;
}

/** Thin, synchronous wrapper around node:sqlite with statement caching, transactions and migrations. */
export class Db {
  readonly raw: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();
  private txDepth = 0;
  private closed = false;

  constructor(readonly file: string) {
    const { DatabaseSync } = loadSqlite();
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.raw.exec('PRAGMA synchronous = NORMAL');
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      if (this.cache.size > 500) this.cache.clear();
      this.cache.set(sql, s);
    }
    return s;
  }

  run(sql: string, ...params: SqlParam[]): { changes: number; lastInsertRowid: number } {
    const r = this.stmt(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  get<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: SqlParam[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  /** Runs `fn` atomically. Nested calls use savepoints. */
  tx<T>(fn: () => T): T {
    const sp = `sp${this.txDepth}`;
    this.raw.exec(this.txDepth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.txDepth++;
    try {
      const out = fn();
      this.txDepth--;
      this.raw.exec(this.txDepth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return out;
    } catch (err) {
      this.txDepth--;
      this.raw.exec(this.txDepth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw err;
    }
  }

  schemaVersion(): number {
    const row = this.get<{ user_version: number }>('PRAGMA user_version');
    return Number(row?.user_version ?? 0);
  }

  migrate(migrations: Migration[]): { from: number; to: number } {
    const from = this.schemaVersion();
    const pending = migrations.filter((m) => m.version > from).sort((a, b) => a.version - b.version);
    for (const m of pending) {
      this.tx(() => {
        this.raw.exec(m.up);
        this.raw.exec(`PRAGMA user_version = ${m.version}`);
      });
    }
    return { from, to: this.schemaVersion() };
  }

  /** Consistent point-in-time copy (works while the database is in use). */
  snapshotTo(path: string): void {
    this.raw.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  }

  integrityCheck(): string {
    const row = this.get<{ quick_check: string }>('PRAGMA quick_check');
    return row?.quick_check ?? 'unknown';
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cache.clear();
    try {
      this.raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* ignore */
    }
    this.raw.close();
  }

  get isOpen() {
    return !this.closed;
  }
}
