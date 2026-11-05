import { z } from 'zod';
import { CALENDAR_REPEATS, CALENDAR_SHOW_AS, PROJECT_STATUSES, SYNC_KINDS, TASK_PRIORITIES, TASK_STATUSES, newId, type MeshDevice, type SyncCounts, type SyncKind, type SyncPeer, type SyncResult } from '@fbrx/shared';
import { CoreError } from '../errors';
import type { EventBus } from '../events';
import type { Logger } from '../logger';
import type { Db, SqlParam } from '../storage/db';

/**
 * FBRX Sync: projects, tasks, notes, snippets and FBRX calendar events kept the same on two of your computers. It runs
 * only when someone starts it, straight between the two over FBRX Mesh (every request and reply sealed with NaCl box
 * for that one computer), so no FBRX server holds or sees any of it. Both computers must allow it (the Sync permission
 * of each other's device card); the one that starts it does the work, the other answers.
 *
 * Each item carries the time it last changed; the newer copy wins. A deletion leaves a tombstone (database triggers,
 * migration 18), so it reaches the other computer instead of the other copy coming back. An item changed on both since
 * the two last synced is a conflict: the newer one wins, and a note or snippet keeps the other as a copy beside it.
 */

const TS = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/);
const ID = z.string().regex(/^[\w.-]{1,80}$/);
const opt = (max: number) => z.string().max(max).nullable();
const json = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => {
      try {
        return Array.isArray(JSON.parse(s));
      } catch {
        return false;
      }
    }, 'not a list');
const flag = z.union([z.literal(0), z.literal(1)]);
const stamps = { id: ID, created_at: TS, updated_at: TS };

/** Each kind's table and its columns, exactly as stored (an item crosses as its row). */
const KINDS = {
  projects: {
    table: 'projects',
    row: z.object({ ...stamps, name: z.string().min(1).max(120), description: z.string().max(20_000), status: z.enum(PROJECT_STATUSES), color: z.string().max(20), due: opt(40), milestones: json(200_000) }).strict(),
  },
  tasks: {
    table: 'tasks',
    row: z.object({ ...stamps, title: z.string().min(1).max(300), details: z.string().max(20_000), status: z.enum(TASK_STATUSES), priority: z.enum(TASK_PRIORITIES), due: opt(40), project_id: opt(80), completed_at: TS.nullable() }).strict(),
  },
  notes: {
    table: 'notes',
    row: z.object({ ...stamps, title: z.string().min(1).max(200), content: z.string().max(200_000), tags: json(5_000), project_id: opt(80), pinned: flag }).strict(),
  },
  snippets: {
    table: 'snippets',
    row: z.object({ ...stamps, title: z.string().min(1).max(200), language: z.string().max(40), content: z.string().max(200_000), tags: json(5_000), project_id: opt(80) }).strict(),
  },
  events: {
    table: 'calendar_items',
    row: z
      .object({
        ...stamps,
        title: z.string().min(1).max(300),
        start: z.string().min(10).max(40),
        end: z.string().min(10).max(40),
        all_day: flag,
        location: opt(500),
        notes: opt(20_000),
        color: opt(20),
        link_kind: opt(20),
        link_id: opt(80),
        repeat: z.enum(CALENDAR_REPEATS),
        repeat_until: opt(40),
        show_as: z.enum(CALENDAR_SHOW_AS),
        made_by: z.enum(['person', 'fabrix']),
      })
      .strict(),
  },
} satisfies Record<SyncKind, { table: string; row: z.ZodObject<z.ZodRawShape> }>;

type Row = Record<string, SqlParam> & { id: string; updated_at: string };
interface Stamp {
  id: string;
  at: string;
}
/** What a computer has: each item's id and when it changed, and what it deleted and when. */
interface Manifest {
  have: Record<SyncKind, Stamp[]>;
  gone: Record<SyncKind, Stamp[]>;
}

/** Notes and snippets keep the losing side of a conflict as a copy: they are where people lose real work. */
const COPY_KINDS: SyncKind[] = ['notes', 'snippets'];
/** The most item ids asked for at once, and the most row data sent in one sealed request (the mesh allows 1 MB). */
const BATCH_IDS = 200;
const BATCH_BYTES = 400_000;
/** Ids and times in one page of a computer's list of what it has (about 70 bytes each). */
const PAGE = 4000;
/** Tombstones older than this are forgotten: a computer away longer than that brings deleted items back. */
const TOMBSTONE_DAYS = 365;

const zero = (): SyncCounts => ({ received: 0, sent: 0, deleted: 0, conflicts: 0 });
const ids = z.array(ID).max(BATCH_IDS);
const gone = z.array(z.object({ id: ID, at: TS })).max(PAGE);

export interface SyncDeps {
  db: Db;
  events: EventBus;
  log: Logger;
  /** The paired device, as this computer knows it (its Sync permission here). */
  device: (id: string) => MeshDevice | undefined;
  devices: () => MeshDevice[];
  /** A sealed request to a paired computer over FBRX Mesh. */
  call: <T>(deviceId: string, method: string, params: unknown, timeoutMs: number) => Promise<T>;
  deviceName: () => string;
  audit: (action: string, actor: string, outcome: 'success' | 'failure' | 'denied', details?: Record<string, unknown>) => void;
}

export class SyncService {
  private readonly running = new Set<string>();

  constructor(private readonly d: SyncDeps) {}

  /** The paired computers and how each last synced with this one. */
  peers(): SyncPeer[] {
    return this.d
      .devices()
      .filter((x) => x.kind === 'desktop')
      .map((x) => {
        const r = this.d.db.get<{ last_sync_at: string | null; last_result: string | null }>('SELECT last_sync_at, last_result FROM sync_peers WHERE device_id = ?', x.id);
        return { deviceId: x.id, name: x.name, online: x.online, allowed: !!x.permissions.sync, lastSyncAt: r?.last_sync_at ?? null, last: r?.last_result ? (JSON.parse(r.last_result) as SyncResult) : null };
      });
  }

  // ------------------------------------------------------------------------------------- starting a sync

  /** Syncs with a paired computer now: both ways, everything that differs. */
  async syncWith(deviceId: string, actor: string): Promise<SyncResult> {
    const device = this.d.device(deviceId);
    if (!device || device.kind !== 'desktop') throw new CoreError('NOT_FOUND', 'Sync works between two paired computers: pair the other computer first (Mesh & phone)');
    if (!device.permissions.sync) throw new CoreError('FORBIDDEN', `Allow Sync for ${device.name} first (Mesh & phone → ${device.name} → Choose one by one → Sync)`);
    if (this.running.has(deviceId)) throw new CoreError('CONFLICT', `Already syncing with ${device.name}`);
    this.running.add(deviceId);
    try {
      const result = await this.run(device);
      this.d.audit('sync.done', actor, 'success', { device: device.name, ...result.total });
      return result;
    } catch (err) {
      this.d.audit('sync.done', actor, 'failure', { device: device.name, error: (err as Error).message });
      if (err instanceof CoreError && err.code === 'FORBIDDEN' && /not allowed/.test(err.message)) {
        throw new CoreError('FORBIDDEN', `${device.name} does not allow syncing with this computer yet: on ${device.name}, open Mesh & phone → ${this.d.deviceName()} → Choose one by one and turn on Sync`);
      }
      throw err;
    } finally {
      this.running.delete(deviceId);
    }
  }

  private async run(device: MeshDevice): Promise<SyncResult> {
    const call = <T>(method: string, params: unknown) => this.d.call<T>(device.id, method, params, 60_000);
    const since = this.d.db.get<{ last_sync_at: string | null }>('SELECT last_sync_at FROM sync_peers WHERE device_id = ?', device.id)?.last_sync_at ?? null;
    const theirs = await this.manifestOf(call);
    const mine = this.manifest();
    const kinds = Object.fromEntries(SYNC_KINDS.map((k) => [k, zero()])) as Record<SyncKind, SyncCounts>;

    for (const kind of SYNC_KINDS) {
      const c = kinds[kind];
      const plan = this.plan(kind, mine, theirs, since);
      // Theirs is newer or new here: bring it over. A note or snippet changed on both keeps this side as a copy first.
      const copies: Row[] = [];
      for (const id of plan.conflicts) {
        if (!COPY_KINDS.includes(kind)) continue;
        const loser = plan.pull.includes(id) ? this.row(kind, id) : null;
        if (loser) copies.push(this.copyOf(kind, loser, this.d.deviceName()));
      }
      const pulled = await this.fetch(call, kind, plan.pull);
      // Ours is newer: theirs is the copy, made here and sent along with ours.
      if (COPY_KINDS.includes(kind)) {
        const theirLosers = await this.fetch(call, kind, plan.conflicts.filter((id) => plan.push.includes(id)));
        for (const r of theirLosers) copies.push(this.copyOf(kind, r, device.name));
      }
      this.d.db.tx(() => {
        for (const r of pulled) if (this.upsert(kind, r)) c.received++;
        for (const r of copies) this.upsert(kind, r);
        for (const g of plan.deleteHere) if (this.remove(kind, g)) c.deleted++;
        for (const g of plan.goneThere) this.tombstone(kind, g);
      });
      c.conflicts = plan.conflicts.length;
      // Ours, the copies and what was deleted here go over, in batches the mesh carries.
      const out = [...plan.push.map((id) => this.row(kind, id)).filter((r): r is Row => !!r), ...copies];
      const goneOut = [...plan.deleteThere, ...plan.goneHere];
      for (const batch of batches(out)) {
        const r = await call<{ applied: number; deleted: number }>('sync.put', { kind, rows: batch, gone: [] });
        c.sent += r.applied;
      }
      for (let i = 0; i < goneOut.length; i += PAGE) c.deleted += (await call<{ applied: number; deleted: number }>('sync.put', { kind, rows: [], gone: goneOut.slice(i, i + PAGE) })).deleted;
      if (pulled.length || copies.length || plan.deleteHere.length) this.changed(kind);
    }

    const total = SYNC_KINDS.reduce((a, k) => ({ received: a.received + kinds[k].received, sent: a.sent + kinds[k].sent, deleted: a.deleted + kinds[k].deleted, conflicts: a.conflicts + kinds[k].conflicts }), zero());
    const result: SyncResult = { deviceId: device.id, deviceName: device.name, at: new Date().toISOString(), kinds, total };
    // Both remember this moment: changes after it on both sides are conflicts next time.
    await call('sync.finish', { at: result.at, kinds });
    this.remember(device.id, result);
    this.forgetOldTombstones();
    this.d.events.emit('sync.done', result);
    this.d.log.info('Synced', { device: device.name, ...total });
    return result;
  }

  /** What to bring here, send there and delete on either side, for one kind. */
  private plan(kind: SyncKind, mine: Manifest, theirs: Manifest, since: string | null) {
    const here = new Map(mine.have[kind].map((s) => [s.id, s.at]));
    const there = new Map((theirs.have?.[kind] ?? []).map((s) => [s.id, s.at]));
    const goneHere = new Map(mine.gone[kind].map((s) => [s.id, s.at]));
    const goneThere = new Map((theirs.gone?.[kind] ?? []).map((s) => [s.id, s.at]));
    const plan = { pull: [] as string[], push: [] as string[], conflicts: [] as string[], deleteHere: [] as Stamp[], deleteThere: [] as Stamp[], goneHere: [] as Stamp[], goneThere: [] as Stamp[] };
    for (const [id, at] of here) {
      const theirAt = there.get(id);
      if (theirAt === undefined) {
        const deleted = goneThere.get(id);
        if (deleted && deleted >= at) plan.deleteHere.push({ id, at: deleted });
        else plan.push.push(id);
        continue;
      }
      if (theirAt === at) continue;
      (theirAt > at ? plan.pull : plan.push).push(id);
      if (since && at > since && theirAt > since) plan.conflicts.push(id);
    }
    for (const [id, at] of there) {
      if (here.has(id)) continue;
      const deleted = goneHere.get(id);
      if (deleted && deleted >= at) plan.deleteThere.push({ id, at: deleted });
      else plan.pull.push(id);
    }
    // Deletions the other computer has not heard of travel too, so a third computer learns of them through either.
    for (const [id, at] of goneHere) if (!goneThere.has(id) && !there.has(id)) plan.goneHere.push({ id, at });
    for (const [id, at] of goneThere) if (!goneHere.has(id) && !here.has(id)) plan.goneThere.push({ id, at });
    return plan;
  }

  /** The other computer's list of what it has and what it deleted, page by page (a page stays within a reply). */
  private async manifestOf(call: <T>(method: string, params: unknown) => Promise<T>): Promise<Manifest> {
    const m: Manifest = { have: {} as Record<SyncKind, Stamp[]>, gone: {} as Record<SyncKind, Stamp[]> };
    for (const kind of SYNC_KINDS) {
      for (const part of ['have', 'gone'] as const) {
        const all: Stamp[] = [];
        let after = '';
        for (;;) {
          const r = await call<{ items: unknown[]; more: boolean }>('sync.manifest', { kind, part, after });
          const page = z.array(z.object({ id: ID, at: TS })).max(PAGE).parse(r.items ?? []);
          all.push(...page);
          if (!r.more || !page.length) break;
          after = page[page.length - 1].id;
        }
        m[part][kind] = all;
      }
    }
    return m;
  }

  /** The other computer's rows for these ids, asked for in batches (each reply stays within what the mesh carries). */
  private async fetch(call: <T>(method: string, params: unknown) => Promise<T>, kind: SyncKind, wanted: string[]): Promise<Row[]> {
    const out: Row[] = [];
    let queue = [...wanted];
    while (queue.length) {
      const asked = queue.slice(0, BATCH_IDS);
      const r = await call<{ rows: unknown[]; rest: string[] }>('sync.get', { kind, ids: asked });
      for (const raw of r.rows ?? []) out.push(this.valid(kind, raw));
      const rest = (r.rest ?? []).filter((id) => asked.includes(id));
      // Nothing came back for a batch that was asked for: stop rather than ask forever.
      if (rest.length === asked.length) throw new CoreError('UNAVAILABLE', 'The other computer could not send its items');
      queue = [...rest, ...queue.slice(BATCH_IDS)];
    }
    return out;
  }

  // ------------------------------------------------------------------------- answering the other computer

  /** A request from a paired computer that may sync with this one (its Sync permission here is checked by the mesh). */
  async handle(device: MeshDevice, method: string, p: any): Promise<unknown> {
    switch (method) {
      case 'sync.manifest': {
        const q = z.object({ kind: z.enum(SYNC_KINDS), part: z.enum(['have', 'gone']), after: z.string().max(80) }).parse(p);
        const items =
          q.part === 'have'
            ? this.d.db.all<Stamp>(`SELECT id, updated_at AS at FROM ${KINDS[q.kind].table} WHERE id > ? ORDER BY id LIMIT ?`, q.after, PAGE + 1)
            : this.d.db.all<Stamp>('SELECT id, deleted_at AS at FROM sync_tombstones WHERE kind = ? AND id > ? ORDER BY id LIMIT ?', q.kind, q.after, PAGE + 1);
        return { items: items.slice(0, PAGE), more: items.length > PAGE };
      }
      case 'sync.get': {
        const kind = z.enum(SYNC_KINDS).parse(p.kind);
        const rows: Row[] = [];
        const rest: string[] = [];
        let bytes = 0;
        for (const id of ids.parse(p.ids)) {
          const r = this.row(kind, id);
          if (!r) continue;
          const size = JSON.stringify(r).length;
          if (rows.length && bytes + size > BATCH_BYTES) rest.push(id);
          else {
            rows.push(r);
            bytes += size;
          }
        }
        return { rows, rest };
      }
      case 'sync.put': {
        const kind = z.enum(SYNC_KINDS).parse(p.kind);
        const rows = z.array(z.unknown()).max(BATCH_IDS * 5).parse(p.rows ?? []).map((r) => this.valid(kind, r));
        const deletions = gone.parse(p.gone ?? []);
        let applied = 0;
        let deleted = 0;
        this.d.db.tx(() => {
          for (const r of rows) if (this.upsert(kind, r)) applied++;
          for (const g of deletions) {
            if (this.remove(kind, g)) deleted++;
            else this.tombstone(kind, g);
          }
        });
        if (applied || deleted) this.changed(kind);
        return { applied, deleted };
      }
      case 'sync.finish': {
        const at = TS.parse(p.at);
        // The same sync seen from here: what it received is what this computer sent, and the other way round.
        const kinds = Object.fromEntries(
          SYNC_KINDS.map((k) => {
            const c = (p.kinds?.[k] ?? {}) as Partial<SyncCounts>;
            const n = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0);
            return [k, { received: n(c.sent), sent: n(c.received), deleted: n(c.deleted), conflicts: n(c.conflicts) }];
          }),
        ) as Record<SyncKind, SyncCounts>;
        const total = SYNC_KINDS.reduce((a, k) => ({ received: a.received + kinds[k].received, sent: a.sent + kinds[k].sent, deleted: a.deleted + kinds[k].deleted, conflicts: a.conflicts + kinds[k].conflicts }), zero());
        const result: SyncResult = { deviceId: device.id, deviceName: device.name, at, kinds, total };
        this.remember(device.id, result);
        this.d.audit('sync.done', `mesh:${device.name}`, 'success', { device: device.name, ...total });
        this.d.events.emit('sync.done', result);
        return { ok: true };
      }
      default:
        throw new CoreError('NOT_FOUND', `Unknown sync request ${method}`);
    }
  }

  // ------------------------------------------------------------------------------------------- storage

  private manifest(): Manifest {
    const have = {} as Record<SyncKind, Stamp[]>;
    const gone = {} as Record<SyncKind, Stamp[]>;
    for (const kind of SYNC_KINDS) {
      have[kind] = this.d.db.all<Stamp>(`SELECT id, updated_at AS at FROM ${KINDS[kind].table}`);
      gone[kind] = this.d.db.all<Stamp>('SELECT id, deleted_at AS at FROM sync_tombstones WHERE kind = ?', kind);
    }
    return { have, gone };
  }

  private row(kind: SyncKind, id: string): Row | null {
    const cols = Object.keys(KINDS[kind].row.shape);
    return this.d.db.get<Row>(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM ${KINDS[kind].table} WHERE id = ?`, id) ?? null;
  }

  private valid(kind: SyncKind, raw: unknown): Row {
    const r = KINDS[kind].row.safeParse(raw);
    if (!r.success) throw new CoreError('INVALID_ARGUMENT', `An item from the other computer was not understood (${kind}: ${r.error.issues[0]?.path.join('.')} ${r.error.issues[0]?.message})`);
    return r.data as Row;
  }

  /** Stores an item from the other computer unless this computer has a newer copy or deleted it later. */
  private upsert(kind: SyncKind, r: Row): boolean {
    const { table } = KINDS[kind];
    const deleted = this.d.db.get<{ deleted_at: string }>('SELECT deleted_at FROM sync_tombstones WHERE kind = ? AND id = ?', kind, r.id)?.deleted_at;
    if (deleted && deleted >= r.updated_at) return false;
    const row = { ...r };
    // It may belong to a project this computer does not have (deleted here, say): then it belongs to none.
    if ('project_id' in row && row.project_id && !this.d.db.get('SELECT 1 FROM projects WHERE id = ?', row.project_id)) row.project_id = null;
    const cols = Object.keys(row);
    const changes = this.d.db.run(
      `INSERT INTO ${table} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})
       ON CONFLICT(id) DO UPDATE SET ${cols.filter((c) => c !== 'id').map((c) => `"${c}" = excluded."${c}"`).join(', ')}
       WHERE excluded.updated_at > ${table}.updated_at`,
      ...cols.map((c) => row[c]),
    ).changes;
    if (changes) this.d.db.run('DELETE FROM sync_tombstones WHERE kind = ? AND id = ?', kind, r.id);
    return changes > 0;
  }

  /** Deletes an item the other computer deleted, unless it changed here after that. Keeps the deletion's own time. */
  private remove(kind: SyncKind, g: Stamp): boolean {
    const { table } = KINDS[kind];
    const cur = this.d.db.get<{ updated_at: string }>(`SELECT updated_at FROM ${table} WHERE id = ?`, g.id);
    if (!cur || cur.updated_at > g.at) return false;
    if (kind === 'projects') {
      // As deleting a project here does: what was in it stays, in no project (chats included).
      for (const t of ['tasks', 'notes', 'snippets', 'conversations']) this.d.db.run(`UPDATE ${t} SET project_id = NULL WHERE project_id = ?`, g.id);
    }
    this.d.db.run(`DELETE FROM ${table} WHERE id = ?`, g.id);
    this.tombstone(kind, g);
    return true;
  }

  private tombstone(kind: SyncKind, g: Stamp) {
    this.d.db.run('INSERT OR REPLACE INTO sync_tombstones (kind, id, deleted_at) VALUES (?, ?, ?)', kind, g.id, g.at);
  }

  /** The losing side of a conflict, kept beside the winner as a new item. */
  private copyOf(kind: SyncKind, r: Row, from: string): Row {
    const now = new Date().toISOString();
    const title = `${String(r.title)} (copy from ${from})`.slice(0, 200);
    return { ...r, id: newId(kind === 'notes' ? 'note' : 'snip'), title, updated_at: now };
  }

  private remember(deviceId: string, result: SyncResult) {
    this.d.db.run('INSERT OR REPLACE INTO sync_peers (device_id, last_sync_at, last_result) VALUES (?, ?, ?)', deviceId, result.at, JSON.stringify(result));
  }

  private forgetOldTombstones() {
    this.d.db.run('DELETE FROM sync_tombstones WHERE deleted_at < ?', new Date(Date.now() - TOMBSTONE_DAYS * 86_400_000).toISOString());
  }

  private changed(kind: SyncKind) {
    if (kind === 'events') this.d.events.emit('calendar.changed', { reason: 'synced' });
    else this.d.events.emit('workspace.changed', { kind });
  }
}

/** Rows grouped so each sealed request stays well within what the mesh carries. */
function* batches(rows: Row[]): Generator<Row[]> {
  let batch: Row[] = [];
  let bytes = 0;
  for (const r of rows) {
    const size = JSON.stringify(r).length;
    if (batch.length && (bytes + size > BATCH_BYTES || batch.length >= BATCH_IDS * 5)) {
      yield batch;
      batch = [];
      bytes = 0;
    }
    batch.push(r);
    bytes += size;
  }
  if (batch.length) yield batch;
}
