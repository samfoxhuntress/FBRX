import { randomBytes } from 'node:crypto';
import type { HaCopyView } from '@fbrx/shared';
import type { Db } from '@fbrx/shared/node';

/**
 * High availability's copy: what the active server keeps, copied to the standby as it changes.
 *
 * On the active server each copied table has triggers that write every change (the whole row, or the key of a row
 * deleted) into a journal in the same database, in the order they happened. The journal goes to the standby in
 * batches; the standby applies each batch in one transaction, in order, and keeps where it is (and in which run of the
 * journal) in the same transaction, so its copy is always whole. When the standby is in another run (just paired, or
 * after a takeover), or behind what the journal still has, it gets everything again first (a full copy), applied at
 * once when the last part has come.
 *
 * The standby has no triggers (what it applies is not journaled); a server that is not paired has none either.
 */

export interface CopyTable {
  name: string;
  /** Only the rows whose column has one of these values (the settings that belong to the pair, not to one server). */
  only?: { column: string; values: readonly string[] };
}

export interface CopySource {
  /** What the page calls it. */
  name: string;
  label: string;
  db: Db;
  tables: CopyTable[];
}

/** A change: its number in the journal, the table, upsert or delete, and the row (or its key). */
export interface CopyEntry {
  s: number;
  t: string;
  o: 'u' | 'd';
  r: Record<string, unknown>;
}

export interface CopyBatch {
  name: string;
  /** The run of the journal (a new one each time this server becomes active). */
  epoch: string;
  /** The last change the standby should already have (-1: tell me where you are). */
  after: number;
  entries?: CopyEntry[];
  /** A full copy, in parts: all of them are applied at once with the last. */
  snapshot?: { id: string; part: number; parts: number; upTo: number; rows: Record<string, Array<Record<string, unknown>>> };
  /** When the active server sent it (its copy is current as of then). */
  at: string;
}

export interface CopyAck {
  name: string;
  epoch: string | null;
  seq: number;
  need?: 'snapshot';
}

interface TableInfo {
  name: string;
  cols: string[];
  /** Its key columns (empty: the rowid). */
  pk: string[];
  blob: Set<string>;
  only?: CopyTable['only'];
}

/** The partner's place in a source's journal, as the active server knows it. */
interface Outbound {
  epoch: string;
  partner: { epoch: string | null; seq: number } | null;
  /** Since when a full copy has been due (null: none due). */
  snapshotSince: number | null;
  lastSentAt: number;
  lastAckAt: number | null;
}

/** Each source's journal (two sources may share a database: the settings table holds several roles' state). */
const journalOf = (s: CopySource) => `ha_journal_${s.name}`;
const STATE = 'ha_copy_state';
const BATCH = 2000;
/** A journal longer than this (the standby gone for long) is dropped: the standby gets a full copy instead. */
const MAX_JOURNAL = 100_000;
/** A full copy goes in parts of about this many bytes. */
const PART_BYTES = 1_000_000;
/** With nothing new, the standby still hears that its copy is current this often. */
const IDLE_MARK_MS = 1000;

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;
const lit = (v: string) => `'${v.replace(/'/g, "''")}'`;
const mono = () => performance.now();

export class HaCopy {
  private mode: 'off' | 'active' | 'standby' = 'off';
  private readonly out = new Map<string, Outbound>();
  private readonly parts = new Map<string, { id: string; got: Map<number, CopyBatch['snapshot']> }>();
  private infos = new Map<string, TableInfo[]>();

  constructor(
    private readonly sources: CopySource[],
    private readonly log: (level: 'info' | 'warn', msg: string) => void,
  ) {
    for (const s of sources) s.db.exec(`CREATE TABLE IF NOT EXISTS ${STATE} (name TEXT PRIMARY KEY, epoch TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL)`);
  }

  private tables(s: CopySource): TableInfo[] {
    let t = this.infos.get(s.name);
    if (!t) {
      t = s.tables
        .map((ct) => {
          const cols = s.db.all<{ name: string; type: string; pk: number }>(`PRAGMA table_info(${q(ct.name)})`);
          return { name: ct.name, cols: cols.map((c) => c.name), pk: cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name), blob: new Set(cols.filter((c) => /BLOB/i.test(c.type)).map((c) => c.name)), only: ct.only };
        })
        .filter((x) => x.cols.length > 0);
      this.infos.set(s.name, t);
    }
    return t;
  }

  // ------------------------------------------------------------------------------------------- on and off

  /** This server serves: its changes are journaled from now on, in a new run (the standby gets a full copy first). */
  becomeActive(): void {
    for (const s of this.sources) {
      this.infos.delete(s.name);
      this.dropTriggers(s);
      s.db.exec(`CREATE TABLE IF NOT EXISTS ${journalOf(s)} (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, tbl TEXT NOT NULL, op TEXT NOT NULL, row TEXT NOT NULL); DELETE FROM ${journalOf(s)};`);
      this.installTriggers(s);
      this.out.set(s.name, { epoch: randomBytes(8).toString('base64url'), partner: null, snapshotSince: null, lastSentAt: -Infinity, lastAckAt: null });
    }
    this.mode = 'active';
  }

  /** The standby: no journal (what it applies is the active one's). */
  becomeStandby(): void {
    for (const s of this.sources) {
      this.dropTriggers(s);
      s.db.exec(`DROP TABLE IF EXISTS ${journalOf(s)}`);
    }
    this.out.clear();
    this.mode = 'standby';
  }

  /** Not paired: nothing journaled, nothing kept of where a copy was. */
  off(): void {
    this.becomeStandby();
    for (const s of this.sources) s.db.run(`DELETE FROM ${STATE}`);
    this.mode = 'off';
  }

  private dropTriggers(s: CopySource) {
    for (const t of s.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND substr(name, 1, ?) = ?", `ha_copy_${s.name}_`.length, `ha_copy_${s.name}_`)) s.db.exec(`DROP TRIGGER IF EXISTS ${q(t.name)}`);
  }

  private installTriggers(s: CopySource) {
    const JOURNAL = journalOf(s);
    for (const t of this.tables(s)) {
      const row = (v: 'NEW' | 'OLD', cols: string[]) => `json_object(${cols.map((c) => `${lit(c)}, ${t.blob.has(c) ? `hex(${v}.${q(c)})` : `${v}.${q(c)}`}`).join(', ')})`;
      const all = t.pk.length ? t.cols : ['rowid', ...t.cols];
      const key = t.pk.length ? t.pk : ['rowid'];
      const when = (v: 'NEW' | 'OLD') => (t.only ? `WHEN ${v}.${q(t.only.column)} IN (${t.only.values.map(lit).join(', ')})` : '');
      const put = (op: 'u' | 'd', json: string) => `INSERT INTO ${JOURNAL} (at, tbl, op, row) VALUES (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ${lit(t.name)}, '${op}', ${json});`;
      const n = (k: string) => q(`ha_copy_${s.name}_${t.name}_${k}`);
      s.db.exec(`CREATE TRIGGER ${n('i')} AFTER INSERT ON ${q(t.name)} ${when('NEW')} BEGIN ${put('u', row('NEW', all))} END;`);
      // A changed key: the old row goes, the new one comes.
      const moved = key.map((k) => `OLD.${q(k)} IS NOT NEW.${q(k)}`).join(' OR ');
      s.db.exec(
        `CREATE TRIGGER ${n('u')} AFTER UPDATE ON ${q(t.name)} ${t.only ? `WHEN OLD.${q(t.only.column)} IN (${t.only.values.map(lit).join(', ')}) OR NEW.${q(t.only.column)} IN (${t.only.values.map(lit).join(', ')})` : ''} BEGIN ` +
          `INSERT INTO ${JOURNAL} (at, tbl, op, row) SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ${lit(t.name)}, 'd', ${row('OLD', key)} WHERE ${moved}; ${put('u', row('NEW', all))} END;`,
      );
      s.db.exec(`CREATE TRIGGER ${n('d')} AFTER DELETE ON ${q(t.name)} ${when('OLD')} BEGIN ${put('d', row('OLD', key))} END;`);
    }
  }

  // ------------------------------------------------------------------------------------------- the active side

  /** The next batches to send: a part of a full copy, or what changed (or, with nothing new, a mark now and then). */
  outgoing(force = false): CopyBatch[] {
    if (this.mode !== 'active') return [];
    const now = mono();
    const at = new Date().toISOString();
    const out: CopyBatch[] = [];
    for (const s of this.sources) {
      const o = this.out.get(s.name)!;
      if (!o.partner) {
        out.push({ name: s.name, epoch: o.epoch, after: -1, at });
        continue;
      }
      if (o.snapshotSince !== null) continue;
      const entries = this.journal(s, o.partner.seq);
      if (entries.length || force || now - o.lastSentAt >= IDLE_MARK_MS) out.push({ name: s.name, epoch: o.epoch, after: o.partner.seq, entries, at });
    }
    for (const b of out) this.out.get(b.name)!.lastSentAt = now;
    return out;
  }

  /** The full copies due, each in parts (built at once, so each is consistent). */
  snapshots(): CopyBatch[][] {
    if (this.mode !== 'active') return [];
    const at = new Date().toISOString();
    const out: CopyBatch[][] = [];
    for (const s of this.sources) {
      const o = this.out.get(s.name)!;
      if (o.snapshotSince === null) continue;
      const id = randomBytes(6).toString('base64url');
      const parts: Array<Record<string, Array<Record<string, unknown>>>> = [{}];
      let size = 0;
      let upTo = 0;
      s.db.tx(() => {
        upTo = s.db.get<{ m: number | null }>(`SELECT MAX(seq) AS m FROM ${journalOf(s)}`)?.m ?? 0;
        for (const t of this.tables(s)) {
          parts.at(-1)![t.name] ??= [];
          const all = t.pk.length ? t.cols : ['rowid', ...t.cols];
          const where = t.only ? ` WHERE ${q(t.only.column)} IN (${t.only.values.map(lit).join(', ')})` : '';
          for (const r of s.db.all<Record<string, unknown>>(`SELECT ${all.map((c) => (t.blob.has(c) ? `hex(${q(c)}) AS ${q(c)}` : q(c))).join(', ')} FROM ${q(t.name)}${where}`)) {
            const n = JSON.stringify(r).length;
            if (size + n > PART_BYTES && size > 0) {
              parts.push({ [t.name]: [] });
              size = 0;
            }
            parts.at(-1)![t.name]!.push(r);
            size += n;
          }
        }
      });
      // Tables with no rows are still in the copy (the standby empties them).
      for (const t of this.tables(s)) parts[0]![t.name] ??= [];
      out.push(parts.map((rows, part) => ({ name: s.name, epoch: o.epoch, after: upTo, snapshot: { id, part, parts: parts.length, upTo, rows }, at })));
    }
    return out;
  }

  private journal(s: CopySource, after: number): CopyEntry[] {
    return s.db.all<{ seq: number; tbl: string; op: 'u' | 'd'; row: string }>(`SELECT seq, tbl, op, row FROM ${journalOf(s)} WHERE seq > ? ORDER BY seq LIMIT ${BATCH}`, after).map((e) => ({ s: e.seq, t: e.tbl, o: e.op, r: JSON.parse(e.row) as Record<string, unknown> }));
  }

  /** What the standby said: where it is now. */
  acked(acks: CopyAck[]): void {
    if (this.mode !== 'active') return;
    for (const a of acks) {
      const o = this.out.get(a.name);
      const s = this.sources.find((x) => x.name === a.name);
      if (!o || !s) continue;
      o.lastAckAt = mono();
      if (a.need === 'snapshot' || a.epoch !== o.epoch) {
        o.partner = { epoch: a.epoch, seq: a.seq };
        o.snapshotSince ??= mono();
        continue;
      }
      o.partner = { epoch: a.epoch, seq: a.seq };
      o.snapshotSince = null;
      // What it has is no longer needed here.
      s.db.run(`DELETE FROM ${journalOf(s)} WHERE seq <= ?`, a.seq);
    }
    // A journal the standby will never catch up on: a full copy instead.
    for (const s of this.sources) {
      const o = this.out.get(s.name)!;
      const n = s.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${journalOf(s)}`)?.n ?? 0;
      if (n > MAX_JOURNAL) {
        s.db.run(`DELETE FROM ${journalOf(s)}`);
        o.snapshotSince ??= mono();
      }
    }
  }

  /** Whether the standby has everything (nothing waiting, no full copy due). */
  caughtUp(): boolean {
    if (this.mode !== 'active') return true;
    return this.sources.every((s) => {
      const o = this.out.get(s.name)!;
      if (!o.partner || o.snapshotSince !== null || o.partner.epoch !== o.epoch) return false;
      return !s.db.get(`SELECT 1 FROM ${journalOf(s)} WHERE seq > ? LIMIT 1`, o.partner.seq);
    });
  }

  /** How far behind the standby is, per source (on the active server), or how current its copy is (on the standby). */
  views(): HaCopyView[] {
    if (this.mode === 'off') return [];
    if (this.mode === 'standby') {
      return this.sources.map((s) => {
        const st = s.db.get<{ seq: number; at: string }>(`SELECT seq, at FROM ${STATE} WHERE name = ?`, s.name);
        return { name: s.name, label: s.label, state: st ? 'caught-up' : 'waiting', behind: 0, behindMs: null, currentAt: st?.at ?? null };
      });
    }
    const now = Date.now();
    return this.sources.map((s) => {
      const o = this.out.get(s.name)!;
      if (!o.partner) return { name: s.name, label: s.label, state: 'waiting', behind: 0, behindMs: null, currentAt: null };
      if (o.snapshotSince !== null) return { name: s.name, label: s.label, state: 'full-copy', behind: 0, behindMs: Math.round(mono() - o.snapshotSince), currentAt: null };
      const w = s.db.get<{ n: number; first: string | null }>(`SELECT COUNT(*) AS n, MIN(at) AS first FROM ${journalOf(s)} WHERE seq > ?`, o.partner.seq);
      const behind = w?.n ?? 0;
      return { name: s.name, label: s.label, state: behind ? 'copying' : 'caught-up', behind, behindMs: behind && w?.first ? Math.max(0, now - Date.parse(w.first)) : 0, currentAt: null };
    });
  }

  /** On the standby: how old its copy is (the oldest "current as of" of its sources), for a takeover's steps. */
  copyAsOf(): string | null {
    let oldest: string | null = null;
    for (const s of this.sources) {
      const st = s.db.get<{ at: string }>(`SELECT at FROM ${STATE} WHERE name = ?`, s.name);
      if (!st) return null;
      if (!oldest || st.at < oldest) oldest = st.at;
    }
    return oldest;
  }

  // ------------------------------------------------------------------------------------------- the standby side

  /** Batches from the active server, applied in order; each answer says where this copy is now. */
  receive(batches: CopyBatch[]): CopyAck[] {
    return batches.map((b) => {
      const s = this.sources.find((x) => x.name === b.name);
      if (!s) return { name: b.name, epoch: null, seq: 0, need: 'snapshot' as const };
      const st = s.db.get<{ epoch: string; seq: number }>(`SELECT epoch, seq FROM ${STATE} WHERE name = ?`, s.name) ?? null;
      const here = (need?: 'snapshot'): CopyAck => {
        const now = s.db.get<{ epoch: string; seq: number }>(`SELECT epoch, seq FROM ${STATE} WHERE name = ?`, s.name);
        return { name: s.name, epoch: now?.epoch ?? null, seq: now?.seq ?? 0, ...(need ? { need } : {}) };
      };
      if (b.snapshot) return this.snapshotPart(s, b) ?? here();
      if (!st || st.epoch !== b.epoch) return here('snapshot');
      if (b.after < 0) return here();
      // A gap: changes it never got.
      if (b.after > st.seq) return here('snapshot');
      const fresh = (b.entries ?? []).filter((e) => e.s > st.seq);
      s.db.tx(() => {
        for (const e of fresh) this.apply(s, e);
        const seq = fresh.length ? fresh.at(-1)!.s : st.seq;
        s.db.run(`UPDATE ${STATE} SET seq = ?, at = ? WHERE name = ?`, seq, b.at, s.name);
      });
      return here();
    });
  }

  private snapshotPart(s: CopySource, b: CopyBatch): CopyAck | null {
    const p = b.snapshot!;
    let held = this.parts.get(s.name);
    if (!held || held.id !== p.id) {
      held = { id: p.id, got: new Map() };
      this.parts.set(s.name, held);
    }
    held.got.set(p.part, p);
    if (held.got.size < p.parts) return { name: s.name, epoch: null, seq: 0 };
    this.parts.delete(s.name);
    const tables = this.tables(s);
    s.db.tx(() => {
      s.db.exec('PRAGMA defer_foreign_keys = ON');
      // Everything it had goes; what the active server has comes.
      for (const t of [...tables].reverse()) s.db.run(`DELETE FROM ${q(t.name)}${t.only ? ` WHERE ${q(t.only.column)} IN (${t.only.values.map(lit).join(', ')})` : ''}`);
      for (let i = 0; i < p.parts; i++) {
        for (const [name, rows] of Object.entries(held.got.get(i)!.rows)) {
          const t = tables.find((x) => x.name === name);
          if (!t) continue;
          for (const r of rows) this.upsert(s, t, r);
        }
      }
      s.db.run(`INSERT INTO ${STATE} (name, epoch, seq, at) VALUES (?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET epoch = excluded.epoch, seq = excluded.seq, at = excluded.at`, s.name, b.epoch, p.upTo, b.at);
    });
    this.log('info', `High availability: a full copy of ${s.label.toLowerCase()} came from the active server`);
    return { name: s.name, epoch: b.epoch, seq: p.upTo };
  }

  private apply(s: CopySource, e: CopyEntry) {
    const t = this.tables(s).find((x) => x.name === e.t);
    if (!t) return;
    if (e.o === 'u') this.upsert(s, t, e.r);
    else {
      const key = t.pk.length ? t.pk : ['rowid'];
      s.db.run(`DELETE FROM ${q(t.name)} WHERE ${key.map((k) => `${q(k)} = ?`).join(' AND ')}`, ...key.map((k) => e.r[k] as never));
    }
  }

  private upsert(s: CopySource, t: TableInfo, r: Record<string, unknown>) {
    const cols = (t.pk.length ? t.cols : ['rowid', ...t.cols]).filter((c) => c in r);
    const val = (c: string) => {
      const v = r[c];
      if (v === null || v === undefined) return null;
      if (t.blob.has(c)) return Buffer.from(String(v), 'hex');
      return typeof v === 'object' ? JSON.stringify(v) : (v as string | number);
    };
    const ins = `INSERT INTO ${q(t.name)} (${cols.map(q).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
    if (!t.pk.length) s.db.run(`${ins.replace('INSERT INTO', 'INSERT OR REPLACE INTO')}`, ...cols.map(val));
    else {
      const rest = cols.filter((c) => !t.pk.includes(c));
      s.db.run(`${ins} ON CONFLICT (${t.pk.map(q).join(', ')}) DO ${rest.length ? `UPDATE SET ${rest.map((c) => `${q(c)} = excluded.${q(c)}`).join(', ')}` : 'NOTHING'}`, ...cols.map(val));
    }
  }
}
