import type { Db } from './db';

/** Typed key/value access to the `meta` table. */
export class MetaStore {
  constructor(private readonly db: Db) {}

  get<T = string>(key: string): T | null {
    const row = this.db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key);
    if (!row) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return row.value as unknown as T;
    }
  }

  set(key: string, value: unknown): void {
    this.db.run(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      JSON.stringify(value),
    );
  }

  delete(key: string): void {
    this.db.run('DELETE FROM meta WHERE key = ?', key);
  }

  deletePrefix(prefix: string): void {
    this.db.run("DELETE FROM meta WHERE key LIKE ? ESCAPE '\\'", `${prefix.replace(/[%_\\]/g, '\\$&')}%`);
  }
}
