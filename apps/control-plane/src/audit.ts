import { createHash } from 'node:crypto';
import { canonicalJson } from '@fbrx/shared';
import type { Db } from '@fbrx/shared/node';

export interface Actor {
  type: 'user' | 'apikey' | 'device' | 'system';
  id: string | null;
  label: string;
  tenantId: string | null;
  ip?: string | null;
}

export interface CpAuditEntry {
  seq: number;
  ts: string;
  tenantId: string | null;
  actorType: string;
  actorId: string | null;
  actorLabel: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  ip: string | null;
  details: unknown;
  hash: string;
}

const GENESIS = '0'.repeat(64);

/** Control-plane audit trail; hash-chained like the device log. */
export class CpAudit {
  private listeners = new Set<(e: CpAuditEntry) => void>();

  constructor(private readonly db: Db) {}

  onAppend(cb: (e: CpAuditEntry) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private static hash(prev: string, e: Omit<CpAuditEntry, 'hash'>): string {
    return createHash('sha256').update(prev).update(canonicalJson(e)).digest('hex');
  }

  record(actor: Actor, action: string, target: { type?: string; id?: string | null; tenantId?: string | null } = {}, details?: unknown): CpAuditEntry {
    const entry = this.db.tx(() => {
      const head = this.db.get<{ seq: number; hash: string }>('SELECT seq, hash FROM audit_log ORDER BY seq DESC LIMIT 1') ?? { seq: 0, hash: GENESIS };
      const base = {
        seq: Number(head.seq) + 1,
        ts: new Date().toISOString(),
        tenantId: target.tenantId !== undefined ? target.tenantId : actor.tenantId,
        actorType: actor.type,
        actorId: actor.id,
        actorLabel: actor.label,
        action,
        targetType: target.type ?? null,
        targetId: target.id ?? null,
        ip: actor.ip ?? null,
        details: details === undefined ? null : JSON.parse(JSON.stringify(details)),
      };
      const hash = CpAudit.hash(head.hash, base);
      this.db.run(
        'INSERT INTO audit_log (seq, ts, tenant_id, actor_type, actor_id, actor_label, action, target_type, target_id, ip, details, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
        base.seq,
        base.ts,
        base.tenantId,
        base.actorType,
        base.actorId,
        base.actorLabel,
        base.action,
        base.targetType,
        base.targetId,
        base.ip,
        base.details === null ? null : JSON.stringify(base.details),
        head.hash,
        hash,
      );
      return { ...base, hash };
    });
    for (const l of this.listeners) l(entry);
    return entry;
  }

  query(o: { tenantId?: string | null; limit?: number; beforeSeq?: number; action?: string; search?: string }): CpAuditEntry[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (o.tenantId) {
      where.push('tenant_id = ?');
      params.push(o.tenantId);
    }
    if (o.beforeSeq) {
      where.push('seq < ?');
      params.push(o.beforeSeq);
    }
    if (o.action) {
      where.push('action LIKE ?');
      params.push(`${o.action}%`);
    }
    if (o.search) {
      where.push('(actor_label LIKE ? OR target_id LIKE ? OR details LIKE ?)');
      params.push(`%${o.search}%`, `%${o.search}%`, `%${o.search}%`);
    }
    const limit = Math.min(Math.max(o.limit ?? 100, 1), 500);
    return this.db
      .all<any>(`SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY seq DESC LIMIT ${limit}`, ...params)
      .map((r) => ({
        seq: Number(r.seq),
        ts: r.ts,
        tenantId: r.tenant_id,
        actorType: r.actor_type,
        actorId: r.actor_id,
        actorLabel: r.actor_label,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        ip: r.ip,
        details: r.details ? JSON.parse(r.details) : null,
        hash: r.hash,
      }));
  }

  verify(): { ok: boolean; checked: number; brokenAtSeq: number | null } {
    let prev = GENESIS;
    let checked = 0;
    for (const raw of this.db.raw.prepare('SELECT * FROM audit_log ORDER BY seq ASC').iterate()) {
      const r = raw as any;
      const base = {
        seq: Number(r.seq),
        ts: r.ts,
        tenantId: r.tenant_id,
        actorType: r.actor_type,
        actorId: r.actor_id,
        actorLabel: r.actor_label,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        ip: r.ip,
        details: r.details ? JSON.parse(r.details) : null,
      };
      if (r.prev_hash !== prev || CpAudit.hash(prev, base) !== r.hash) return { ok: false, checked, brokenAtSeq: Number(r.seq) };
      prev = r.hash;
      checked++;
    }
    return { ok: true, checked, brokenAtSeq: null };
  }
}
