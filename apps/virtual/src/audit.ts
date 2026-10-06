import type { VirtualAuditEntry } from '@fbrx/shared';
import type { Db } from '@fbrx/shared/node';

/** Who did what on this server: every change, sign-in and failure, newest first. */
export class Audit {
  constructor(private readonly db: Db) {}

  record(actor: string, action: string, target: string | null, outcome: 'success' | 'failure' = 'success', details: unknown = null): void {
    this.db.run('INSERT INTO audit (at, actor, action, target, outcome, details) VALUES (?,?,?,?,?,?)', new Date().toISOString(), actor, action, target, outcome, details === null || details === undefined ? null : typeof details === 'string' ? details : JSON.stringify(details));
  }

  list(limit = 200, before?: number): VirtualAuditEntry[] {
    const rows = before
      ? this.db.all<Record<string, unknown>>('SELECT * FROM audit WHERE id < ? ORDER BY id DESC LIMIT ?', before, limit)
      : this.db.all<Record<string, unknown>>('SELECT * FROM audit ORDER BY id DESC LIMIT ?', limit);
    return rows.map((r) => ({ id: String(r.id), at: String(r.at), actor: String(r.actor), action: String(r.action), target: (r.target as string) ?? null, outcome: r.outcome === 'failure' ? 'failure' : 'success', details: (r.details as string) ?? null }));
  }

  prune(days = 365): void {
    this.db.run('DELETE FROM audit WHERE at < ?', new Date(Date.now() - days * 86400_000).toISOString());
  }
}
