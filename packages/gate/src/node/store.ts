import { Db, type Migration } from '@fbrx/shared/node';
import { GateConfigSchema, type GateConfig } from '../model';
import type { GateCommit, GateCommitStatus } from '../types';

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'gate',
    up: `
      CREATE TABLE gate_candidate (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        config TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        updated_by TEXT NOT NULL
      );
      CREATE TABLE gate_commits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        by TEXT NOT NULL,
        comment TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        confirm_by TEXT,
        error TEXT,
        changes INTEGER NOT NULL DEFAULT 0,
        config TEXT NOT NULL,
        previous_id INTEGER
      );
      CREATE TABLE gate_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
];

interface CommitRow {
  id: number;
  at: string;
  by: string;
  comment: string;
  status: string;
  confirm_by: string | null;
  error: string | null;
  changes: number;
  config: string;
  previous_id: number | null;
}

/** The gate's own small database: the candidate, every commit with its configuration, and a few settings. */
export class GateStore {
  readonly db: Db;

  constructor(file: string) {
    this.db = new Db(file);
    this.db.migrate(MIGRATIONS);
  }

  close() {
    this.db.close();
  }

  candidate(): GateConfig | null {
    const r = this.db.get<{ config: string }>('SELECT config FROM gate_candidate WHERE id = 1');
    return r ? (JSON.parse(r.config) as GateConfig) : null;
  }

  setCandidate(c: GateConfig, by: string) {
    this.db.run(
      'INSERT INTO gate_candidate (id, config, updated_at, updated_by) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET config = excluded.config, updated_at = excluded.updated_at, updated_by = excluded.updated_by',
      JSON.stringify(c),
      new Date().toISOString(),
      by,
    );
  }

  meta<T>(key: string): T | null {
    const r = this.db.get<{ value: string }>('SELECT value FROM gate_meta WHERE key = ?', key);
    return r ? (JSON.parse(r.value) as T) : null;
  }

  setMeta(key: string, value: unknown) {
    if (value === null) this.db.run('DELETE FROM gate_meta WHERE key = ?', key);
    else this.db.run('INSERT INTO gate_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  }

  addCommit(c: { by: string; comment: string; status: GateCommitStatus; confirmBy: string | null; error: string | null; changes: number; config: GateConfig; previousId: number | null }): number {
    return this.db.run(
      'INSERT INTO gate_commits (at, by, comment, status, confirm_by, error, changes, config, previous_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      new Date().toISOString(),
      c.by,
      c.comment,
      c.status,
      c.confirmBy,
      c.error,
      c.changes,
      JSON.stringify(c.config),
      c.previousId,
    ).lastInsertRowid;
  }

  setStatus(id: number, status: GateCommitStatus, error: string | null = null) {
    this.db.run('UPDATE gate_commits SET status = ?, error = COALESCE(?, error) WHERE id = ?', status, error, id);
  }

  private row(id: number): CommitRow | undefined {
    return this.db.get<CommitRow>('SELECT * FROM gate_commits WHERE id = ?', id);
  }

  commit(id: number): (GateCommit & { config: GateConfig; previousId: number | null }) | null {
    const r = this.row(id);
    return r ? { ...this.view(r), config: GateConfigSchema.parse(JSON.parse(r.config)), previousId: r.previous_id } : null;
  }

  commits(limit = 50): GateCommit[] {
    return this.db.all<CommitRow>('SELECT * FROM gate_commits ORDER BY id DESC LIMIT ?', limit).map((r) => this.view(r));
  }

  private view(r: CommitRow): GateCommit {
    return { id: r.id, at: r.at, by: r.by, comment: r.comment, status: r.status as GateCommitStatus, confirmBy: r.confirm_by, error: r.error, changes: r.changes };
  }
}
