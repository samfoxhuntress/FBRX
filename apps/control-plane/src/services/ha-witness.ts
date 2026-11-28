import { HaWitness, newWitnessKey, openString, sealString, type Db } from '@fbrx/shared/node';

/**
 * FBRX Command as the third vote of the organization's FBRX Server pairs (high availability): each pair has a key,
 * made here and pasted on the pair's active server; the pair's servers ask for its lease with it. The keys' secrets are
 * sealed with Command's key; who holds each lease is kept, so a restart of Command does not hand a pair to its standby
 * while the active server still serves.
 */
export interface WitnessKeyView {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
  /** Who holds the pair now, as far as Command knows. */
  holding: boolean;
}

export class CommandWitness {
  readonly witness: HaWitness;

  constructor(
    private readonly db: Db,
    private readonly master: Uint8Array,
  ) {
    this.witness = new HaWitness({
      secretOf: (id) => {
        const r = db.get<{ secret: string }>('SELECT secret FROM ha_witness_keys WHERE id = ?', id);
        return r ? openString(master, r.secret, `ha-witness:${id}`) : null;
      },
      load: () => db.all<{ id: string; holder: string | null; term: number; lease_ms: number }>('SELECT * FROM ha_witness_leases').map((l) => ({ id: l.id, holder: l.holder, term: l.term, leaseMs: l.lease_ms })),
      save: (l) => db.run('INSERT INTO ha_witness_leases (id, holder, term, lease_ms) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET holder = excluded.holder, term = excluded.term, lease_ms = excluded.lease_ms', l.id, l.holder, l.term, l.leaseMs),
      // At most once a minute: renewals come several times a second.
      used: (id) => db.run("UPDATE ha_witness_keys SET last_used_at = ? WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)", new Date().toISOString(), id, new Date(Date.now() - 60_000).toISOString()),
    });
  }

  list(tenantId: string): WitnessKeyView[] {
    const holding = new Set(this.witness.holders().filter((h) => h.holder).map((h) => h.id));
    return this.db
      .all<{ id: string; label: string; created_at: string; last_used_at: string | null }>('SELECT id, label, created_at, last_used_at FROM ha_witness_keys WHERE tenant_id = ? ORDER BY created_at', tenantId)
      .map((k) => ({ id: k.id, label: k.label, createdAt: k.created_at, lastUsedAt: k.last_used_at, holding: holding.has(k.id) }));
  }

  /** A key for one pair, shown this once. */
  add(tenantId: string, label: string): { id: string; key: string } {
    if ((this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM ha_witness_keys WHERE tenant_id = ?', tenantId)?.n ?? 0) >= 50) throw new Error('At most 50 third-vote keys: remove one first');
    const k = newWitnessKey();
    this.db.run('INSERT INTO ha_witness_keys (id, tenant_id, label, secret, created_at) VALUES (?, ?, ?, ?, ?)', k.id, tenantId, label.trim().slice(0, 80) || 'A pair of FBRX Servers', sealString(this.master, k.secret, `ha-witness:${k.id}`), new Date().toISOString());
    return { id: k.id, key: k.key };
  }

  remove(tenantId: string, id: string): boolean {
    const gone = this.db.run('DELETE FROM ha_witness_keys WHERE id = ? AND tenant_id = ?', id, tenantId).changes > 0;
    if (gone) {
      this.db.run('DELETE FROM ha_witness_leases WHERE id = ?', id);
      this.witness.forget(id);
    }
    return gone;
  }
}
