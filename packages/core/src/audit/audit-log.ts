import { createHash } from 'node:crypto';
import { canonicalJson, type AuditEntry, type AuditQuery, type AuditStats, type AuditVerifyResult } from '@fbrx/shared';
import type { Db } from '../storage/db';
import type { MetaStore } from '../storage/meta';
import type { EventBus } from '../events';

const GENESIS = '0'.repeat(64);

export interface AuditInput {
  category: string;
  action: string;
  actor: string;
  target?: string | null;
  outcome: AuditEntry['outcome'];
  details?: unknown;
}

interface Row {
  seq: number;
  ts: string;
  category: string;
  action: string;
  actor: string;
  target: string | null;
  outcome: AuditEntry['outcome'];
  details: string | null;
  prev_hash: string;
  hash: string;
}

/**
 * Append-only, hash-chained audit log. Each entry commits to the previous entry's hash, so any edit or
 * deletion inside the retained window is detectable with `verify()`. The chain head is reported to the
 * control plane in every heartbeat, anchoring it off-device.
 */
export class AuditLog {
  private head: { seq: number; hash: string } | null = null;

  constructor(
    private readonly db: Db,
    private readonly meta: MetaStore,
    private readonly events?: EventBus,
  ) {}

  private loadHead() {
    if (this.head) return this.head;
    const row = this.db.get<{ seq: number; hash: string }>('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1');
    const anchor = this.meta.get<{ seq: number; hash: string }>('audit.anchor');
    this.head = row ?? anchor ?? { seq: 0, hash: GENESIS };
    return this.head;
  }

  static computeHash(prevHash: string, e: Omit<AuditEntry, 'hash' | 'prevHash'>): string {
    return createHash('sha256')
      .update(prevHash)
      .update(
        canonicalJson({
          seq: e.seq,
          ts: e.ts,
          category: e.category,
          action: e.action,
          actor: e.actor,
          target: e.target,
          outcome: e.outcome,
          details: e.details ?? null,
        }),
      )
      .digest('hex');
  }

  append(input: AuditInput): AuditEntry {
    const entry = this.db.tx(() => {
      const head = this.loadHead();
      const base = {
        seq: head.seq + 1,
        ts: new Date().toISOString(),
        category: input.category,
        action: input.action,
        actor: input.actor,
        target: input.target ?? null,
        outcome: input.outcome,
        details: input.details === undefined ? null : JSON.parse(JSON.stringify(input.details)),
      };
      const hash = AuditLog.computeHash(head.hash, base);
      this.db.run(
        'INSERT INTO audit_log (seq, ts, category, action, actor, target, outcome, details, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?)',
        base.seq,
        base.ts,
        base.category,
        base.action,
        base.actor,
        base.target,
        base.outcome,
        base.details === null ? null : JSON.stringify(base.details),
        head.hash,
        hash,
      );
      this.head = { seq: base.seq, hash };
      return { ...base, prevHash: head.hash, hash } satisfies AuditEntry;
    });
    this.events?.emit('audit.appended', entry);
    return entry;
  }

  headInfo(): { seq: number; hash: string } {
    return { ...this.loadHead() };
  }

  query(q: AuditQuery = {}): AuditEntry[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (q.beforeSeq) {
      where.push('seq < ?');
      params.push(q.beforeSeq);
    }
    if (q.category) {
      where.push('category = ?');
      params.push(q.category);
    }
    if (q.outcome) {
      where.push('outcome = ?');
      params.push(q.outcome);
    }
    if (q.search) {
      where.push('(action LIKE ? OR target LIKE ? OR actor LIKE ? OR details LIKE ?)');
      const s = `%${q.search}%`;
      params.push(s, s, s, s);
    }
    const limit = Math.min(Math.max(q.limit ?? 100, 1), 1000);
    const rows = this.db.all<Row>(
      `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ${limit}`,
      ...params,
    );
    return rows.map(toEntry);
  }

  verify(): AuditVerifyResult {
    const anchor = this.meta.get<{ seq: number; hash: string }>('audit.anchor');
    let prev = anchor?.hash ?? GENESIS;
    let expectedSeq = (anchor?.seq ?? 0) + 1;
    let checked = 0;
    const stmt = this.db.raw.prepare('SELECT * FROM audit_log ORDER BY seq ASC');
    for (const raw of stmt.iterate()) {
      const row = raw as unknown as Row;
      const e = toEntry(row);
      if (row.seq !== expectedSeq) {
        return { ok: false, checked, brokenAtSeq: row.seq, message: `Gap in audit chain: expected #${expectedSeq}, found #${row.seq}` };
      }
      if (row.prev_hash !== prev) {
        return { ok: false, checked, brokenAtSeq: row.seq, message: `Entry #${row.seq} does not link to its predecessor` };
      }
      const recomputed = AuditLog.computeHash(prev, e);
      if (recomputed !== row.hash) {
        return { ok: false, checked, brokenAtSeq: row.seq, message: `Entry #${row.seq} was modified after it was written` };
      }
      prev = row.hash;
      expectedSeq++;
      checked++;
    }
    return { ok: true, checked, brokenAtSeq: null, message: `Verified ${checked} entries` };
  }

  /** Removes entries older than `days`, recording an anchor so the remaining chain still verifies. */
  prune(days: number): number {
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
    return this.db.tx(() => {
      const last = this.db.get<{ seq: number; hash: string }>(
        'SELECT seq, hash FROM audit_log WHERE ts < ? ORDER BY seq DESC LIMIT 1',
        cutoff,
      );
      if (!last) return 0;
      const { changes } = this.db.run('DELETE FROM audit_log WHERE seq <= ?', last.seq);
      this.meta.set('audit.anchor', { seq: last.seq, hash: last.hash });
      return changes;
    });
  }

  stats(): AuditStats {
    const since = new Date(Date.now() - 86400_000).toISOString();
    const total = Number(this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log')?.n ?? 0);
    const last24h = Number(this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM audit_log WHERE ts >= ?', since)?.n ?? 0);
    const denied24h = Number(
      this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE ts >= ? AND outcome = 'denied'", since)?.n ?? 0,
    );
    const failures24h = Number(
      this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_log WHERE ts >= ? AND outcome = 'failure'", since)?.n ?? 0,
    );
    const byCategory: Record<string, number> = {};
    for (const r of this.db.all<{ category: string; n: number }>(
      'SELECT category, COUNT(*) AS n FROM audit_log WHERE ts >= ? GROUP BY category',
      since,
    )) {
      byCategory[r.category] = Number(r.n);
    }
    return { total, last24h, denied24h, failures24h, byCategory };
  }

  count(category: string, action: string | null, sinceIso: string, outcome?: AuditEntry['outcome']): number {
    const params: string[] = [category, sinceIso];
    let sql = 'SELECT COUNT(*) AS n FROM audit_log WHERE category = ? AND ts >= ?';
    if (action) {
      sql += ' AND action = ?';
      params.push(action);
    }
    if (outcome) {
      sql += ' AND outcome = ?';
      params.push(outcome);
    }
    return Number(this.db.get<{ n: number }>(sql, ...params)?.n ?? 0);
  }
}

function toEntry(r: Row): AuditEntry {
  return {
    seq: Number(r.seq),
    ts: r.ts,
    category: r.category,
    action: r.action,
    actor: r.actor,
    target: r.target,
    outcome: r.outcome,
    details: r.details ? JSON.parse(r.details) : null,
    prevHash: r.prev_hash,
    hash: r.hash,
  };
}
