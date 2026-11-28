import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIPv4 } from 'node:net';
import type { Agent } from 'node:https';
import { z } from 'zod';
import {
  HA_CODE_ALPHABET,
  HA_DEFAULT_SETTINGS,
  HA_HEARTBEAT_MS,
  HA_STATE_NAMES,
  HA_WITNESS_KEY,
  HaSettingsSchema,
  VIRTUAL_DEFAULT_PORT,
  haNormalCode,
  type HaEvent,
  type HaEventKind,
  type HaLeaseAnswer,
  type HaPath,
  type HaPreference,
  type HaSettings,
  type HaState,
  type HaStatus,
  type HaStep,
} from '@fbrx/shared';
import {
  HA_SIGNED_TYPE,
  HA_WITNESS_SIGNATURE,
  HaWitness,
  newWitnessKey,
  openString,
  pinnedAgent,
  pinnedFetch,
  sealString,
  signHaRequest,
  verifyHaRequest,
  type Db,
  type StoredLease,
} from '@fbrx/shared/node';
import type { ServerAlerts } from '../alerts/service';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../errors';
import { Heartbeat, type Beat, type HaPathName } from './heartbeat';
import type { CopyAck, CopyBatch, HaCopy } from './copy';

/**
 * FBRX Server high availability: this server and its partner as one pair.
 *
 * Pairing: the standby makes a pairing code; the primary is given the standby's address, its certificate's
 * fingerprint and the code, and asks to join over HTTPS pinned to that fingerprint. The standby answers with the
 * pair's secret, and from then on the two talk only over TLS both sides check (requests signed with the secret) and
 * by a signed heartbeat on UDP.
 *
 * Who serves: the active server says so in every heartbeat. The standby takes over when it has heard nothing on any
 * path for the takeover time (a second unless changed). With a third vote, the active server holds a lease from it
 * and renews it four times per takeover time; the standby takes over only once the third vote gives it the lease
 * (after the active one's ran out), and an active server that hears neither its partner nor the third vote stops
 * serving before its lease would run out. So the two are never active at once. Without a third vote the standby takes
 * over when every path is silent, and the page says what that risks.
 *
 * What the roles do when this server starts or stops serving is up to them (roles: activate and deactivate); each says
 * what it did, and those steps go into the pair's history and into the takeover's alert (its incident report).
 */

const KEY = { pair: 'ha.pair', code: 'ha.code', keys: 'ha.witness.keys', leases: 'ha.witness.leases' } as const;
const CODE_MS = 30 * 60_000;
const KEEP_EVENTS = 300;
/** The standby's code is valid for this long, for this many tries. */
const CODE_TRIES = 10;
/** The partner silent this long (at least) before "the pair runs on one server" is an alert. */
const ALONE_ALERT_MS = 5_000;
/** The third vote silent this long before it is an alert. */
const WITNESS_ALERT_MS = 30_000;
/** The standby's copy this far behind before it is an alert. */
const BEHIND_ALERT_MS = 60_000;
/** Before switching over, how long to wait for the standby to catch up. */
const CATCH_UP_MS = 10_000;

interface Partner {
  nodeId: string;
  name: string;
  url: string;
  fingerprint: string;
  version: string;
  preference: HaPreference;
  /** Its heartbeat on the network and on the dedicated link (host:port). */
  network: string;
  link: string | null;
}

interface StoredPair {
  pairId: string;
  nodeId: string;
  preference: HaPreference;
  /** Sealed with the server's key. */
  secret: string;
  term: number;
  settings: HaSettings;
  partner: Partner;
  witness: { url: string; fingerprint: string | null; id: string; secret: string } | null;
}

interface StoredCode {
  hash: string;
  expiresAt: string;
  tries: number;
}

interface WitnessKey {
  id: string;
  label: string;
  secret: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** What the roles do when this server starts or stops serving. */
export interface HaRoles {
  activate(reason: string): Promise<HaStep[]>;
  deactivate(reason: string): Promise<HaStep[]>;
}

export interface HaServiceOptions {
  db: Db;
  key: Uint8Array;
  name: string;
  version: string;
  /** This console's port (the partner reaches it on this). */
  port: number;
  /** The heartbeat's UDP port, and the address it listens on. */
  heartbeatPort: number;
  bind: string;
  /** This server's certificate fingerprint (null: plain HTTP, which cannot pair). */
  fingerprint: string | null;
  alerts: ServerAlerts;
  roles: HaRoles;
  log: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** How often the heartbeat goes out (tests make it quicker). */
  heartbeatMs?: number;
  /** How long the primary has been back as the standby before the work is handed back by itself. */
  handBackAfterMs?: number;
  /** The roles' data, copied to the standby. */
  copy?: HaCopy;
  /**
   * The standby takes its primary's key when paired, so what one sealed (a mail password, a NAS sign-in) the other
   * opens. The server seals its own few secrets (its management controller's) with it first, then changes the key.
   */
  adoptKey?: (key: Buffer, old: Buffer) => void;
}

const JoinSchema = z.object({
  code: z.string().min(4).max(40),
  pairId: z.string().min(8).max(64),
  node: z.object({
    nodeId: z.string().min(8).max(64),
    name: z.string().min(1).max(120),
    port: z.number().int().min(1).max(65535),
    heartbeatPort: z.number().int().min(1).max(65535),
    fingerprint: z.string().min(32).max(200),
    version: z.string().min(1).max(40),
    linkAddress: z.string().max(64).nullable(),
  }),
  settings: HaSettingsSchema,
  /** The primary's key (base64, 32 bytes). */
  key: z.string().regex(/^[A-Za-z0-9+/]{43}=$/),
});

const PeerSchema = z.object({ pair: z.string(), from: z.string(), op: z.enum(['take', 'switchover', 'config', 'unpair', 'hello', 'copy']) }).passthrough();

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const mono = () => performance.now();
const plainIp = (a: string) => a.replace(/^::ffff:/, '');
const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;

export class HaService {
  private pair: StoredPair | null = null;
  private state: HaState = 'single';
  private since = Date.now();
  private startedAt = mono();
  private readonly boot = randomBytes(6).toString('base64url');
  private seq = 0;
  private readonly hb: Heartbeat;
  private timers: NodeJS.Timeout[] = [];
  private agents = new Map<string, Agent>();
  /** The partner, as last heard. */
  private heard = HaService.unheard();
  /** The third vote, as last asked. */
  private lease = { deadline: -Infinity, holder: null as 'me' | 'partner' | null, ok: false, lastOkAt: null as number | null, lastAt: null as string | null, error: null as string | null, failingSince: null as number | null };
  private busy = false;
  private renewing = false;
  private switchingUntil = 0;
  private nextTry = 0;
  private partnerStandbySince: number | null = null;
  /** Since when both have been the standby (nobody serving). */
  private noneServingSince: number | null = null;
  private lastRenew = -Infinity;
  /** A takeover alert may be open (from before a restart too): its all-clear is due when the partner is back. */
  private takeoverOpen = true;
  private aloneRaised = false;
  private witnessRaised = false;
  private copying = false;
  private behindRaised = false;
  private lastCopyError = 0;
  /** Tests: paths that drop what goes out or comes in. */
  private dropped = { send: new Set<HaPathName>(), receive: new Set<HaPathName>(), witness: false };
  /** The witness this server hosts for other pairs. */
  readonly witness: HaWitness;

  constructor(private readonly o: HaServiceOptions) {
    this.hb = new Heartbeat({ port: o.heartbeatPort, bind: o.bind, secret: () => (this.pair ? this.secret() : null), onBeat: (b) => this.onBeat(b), log: o.log });
    this.witness = new HaWitness({
      secretOf: (id) => {
        const k = this.keys().find((x) => x.id === id);
        return k ? openString(o.key, k.secret, 'ha.witness') : null;
      },
      load: () => this.get<StoredLease[]>(KEY.leases) ?? [],
      save: (l) => this.put(KEY.leases, [...(this.get<StoredLease[]>(KEY.leases) ?? []).filter((x) => x.id !== l.id), l]),
      used: (id) => this.touchKey(id),
    });
  }

  private get heartbeatMs() {
    return this.o.heartbeatMs ?? HA_HEARTBEAT_MS;
  }

  private get takeoverMs() {
    return this.pair?.settings.takeoverMs ?? HA_DEFAULT_SETTINGS.takeoverMs;
  }

  /** The lease asked of the third vote: as long as the takeover time, renewed four times within it. */
  private get leaseMs() {
    return this.takeoverMs;
  }

  // ------------------------------------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    this.pair = this.get<StoredPair>(KEY.pair);
    this.startedAt = mono();
    if (!this.pair) this.o.copy?.off();
    if (this.pair) {
      // Nothing is served until the pair has decided who serves.
      this.setState('starting');
      this.o.copy?.becomeStandby();
      await this.o.roles.deactivate('Starting: waiting to hear the partner').catch(() => undefined);
      await this.hb.start();
    }
    const every = (ms: number, fn: () => void) => {
      const t = setInterval(fn, ms);
      t.unref?.();
      this.timers.push(t);
    };
    every(this.heartbeatMs, () => this.beat());
    every(Math.max(20, Math.round(this.heartbeatMs / 2)), () => void this.tick().catch((e) => this.o.log('warn', `High availability: ${(e as Error).message}`)));
  }

  stop(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.hb.stop();
    for (const a of this.agents.values()) a.destroy();
    this.agents.clear();
  }

  // ------------------------------------------------------------------------------------------- storage

  private get<T>(key: string): T | null {
    const r = this.o.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
    if (!r) return null;
    try {
      return JSON.parse(r.value) as T;
    } catch {
      return null;
    }
  }

  private put(key: string, value: unknown): void {
    if (value === null) this.o.db.run('DELETE FROM settings WHERE key = ?', key);
    else this.o.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  }

  private save(): void {
    this.put(KEY.pair, this.pair);
  }

  private secret(): string {
    return openString(this.o.key, this.pair!.secret, 'ha.pair');
  }

  private event(kind: HaEventKind, text: string, steps: HaStep[] = []): void {
    this.o.db.run('INSERT INTO ha_events (at, kind, text, steps) VALUES (?, ?, ?, ?)', iso(), kind, text.slice(0, 500), JSON.stringify(steps.slice(-50)));
    this.o.db.run(`DELETE FROM ha_events WHERE id NOT IN (SELECT id FROM ha_events ORDER BY id DESC LIMIT ${KEEP_EVENTS})`);
    this.o.log(kind === 'takeover' || kind === 'stopped' || kind === 'both-active' ? 'warn' : 'info', `High availability: ${text}`);
  }

  events(limit = 50): HaEvent[] {
    return this.o.db.all<{ id: number; at: string; kind: HaEventKind; text: string; steps: string }>('SELECT * FROM ha_events ORDER BY id DESC LIMIT ?', limit).map((e) => ({ ...e, steps: JSON.parse(e.steps) as HaStep[] }));
  }

  // ------------------------------------------------------------------------------------------- what it is

  /** Whether this server may change what the pair keeps: not paired, or the active one. */
  serving(): boolean {
    return !this.pair || this.state === 'active';
  }

  currentState(): HaState {
    return this.state;
  }

  partnerName(): string | null {
    return this.pair?.partner.name ?? null;
  }

  partnerUrl(): string | null {
    return this.pair?.partner.url ?? null;
  }

  private setState(s: HaState) {
    if (s !== this.state) {
      this.state = s;
      this.since = Date.now();
    }
  }

  private hears(now = mono()): boolean {
    return now - this.heard.at < this.takeoverMs;
  }

  /** The partner hears this server too (both ways), as its last heartbeat says. */
  private mutual(now = mono()): boolean {
    return this.hears(now) && !!this.heard.beat?.h;
  }

  status(): HaStatus {
    const p = this.pair;
    const now = mono();
    const ago = (t: number) => (Number.isFinite(t) ? iso(Date.now() - (now - t)) : null);
    const paths: HaPath[] = p
      ? [
          ...(p.partner.link ? [{ name: 'link' as const, address: p.partner.link, up: now - this.heard.path.link < this.takeoverMs, lastHeardAt: ago(this.heard.path.link) }] : []),
          { name: 'network' as const, address: p.partner.network, up: now - this.heard.path.network < this.takeoverMs, lastHeardAt: ago(this.heard.path.network) },
        ]
      : [];
    const warnings: string[] = [];
    if (p) {
      if (!p.witness && !p.partner.link) warnings.push('There is no third vote and no dedicated link: if the network between the two breaks while both run, both serve. Add a third vote (FBRX Command or another FBRX Server).');
      else if (!p.witness) warnings.push('There is no third vote: the standby takes over only when both paths are silent, and if both break while the primary still runs, both serve. Add a third vote.');
      if (p.partner.version !== this.o.version) warnings.push(`The two run different FBRX Server versions (${this.o.version} here, ${p.partner.version} on ${p.partner.name}): update the older one.`);
      if (!this.hears(now) && this.state !== 'starting') warnings.push(`${p.partner.name} is not answering.`);
      if (p.witness && this.state === 'active' && this.lease.error) warnings.push(`The third vote does not answer: ${this.lease.error}`);
    }
    const code = this.get<StoredCode>(KEY.code);
    const events = this.events(40);
    const b = this.heard.beat;
    return {
      available: !!this.o.fingerprint,
      reason: this.o.fingerprint ? null : 'High availability needs this console on HTTPS (FBRX_V_TLS).',
      me: { name: this.o.name, preference: p?.preference ?? null, state: this.state, term: p?.term ?? 0, since: iso(this.since) },
      partner: p
        ? {
            name: p.partner.name,
            url: p.partner.url,
            fingerprint: p.partner.fingerprint,
            version: p.partner.version,
            preference: p.partner.preference,
            state: b && this.hears(now) ? b.st : null,
            term: b?.t ?? 0,
            heard: this.hears(now),
            lastHeardAt: ago(this.heard.at),
          }
        : null,
      paths,
      witness: p?.witness ? { url: p.witness.url, fingerprint: p.witness.fingerprint, ok: this.lease.ok, lastAt: this.lease.lastAt, holder: this.lease.holder, error: this.lease.error } : null,
      copy: p ? (this.o.copy?.views() ?? []) : [],
      settings: p?.settings ?? HA_DEFAULT_SETTINGS,
      code: !p && code && Date.parse(code.expiresAt) > Date.now() && code.tries > 0 ? { expiresAt: code.expiresAt } : null,
      witnessKeys: this.keys().map(({ secret: _s, ...k }) => k),
      events,
      lastDrill: ((e) => (e ? { ...e, steps: JSON.parse(e.steps) as HaStep[] } : null))(this.o.db.get<{ id: number; at: string; kind: HaEventKind; text: string; steps: string }>("SELECT * FROM ha_events WHERE kind IN ('switchover', 'handback') ORDER BY id DESC LIMIT 1")),
      warnings,
    };
  }

  // ------------------------------------------------------------------------------------------- pairing

  /** On the standby-to-be: a pairing code, shown this once. */
  makeCode(): { code: string; expiresAt: string; fingerprint: string } {
    if (!this.o.fingerprint) throw conflict('High availability needs this console on HTTPS');
    if (this.pair) throw conflict(`This server is already paired with ${this.pair.partner.name}`);
    const raw = Array.from({ length: 10 }, () => HA_CODE_ALPHABET[randomInt(HA_CODE_ALPHABET.length)]).join('');
    const expiresAt = iso(Date.now() + CODE_MS);
    this.put(KEY.code, { hash: sha(raw), expiresAt, tries: CODE_TRIES } satisfies StoredCode);
    return { code: `${raw.slice(0, 5)}-${raw.slice(5)}`, expiresAt, fingerprint: this.o.fingerprint };
  }

  cancelCode(): void {
    this.put(KEY.code, null);
  }

  /** On the primary: pair with the standby at this address, trusted by its fingerprint, with its code. */
  async pairWith(i: { address: string; fingerprint: string; code: string; linkAddress?: string | null }): Promise<HaStatus> {
    if (!this.o.fingerprint) throw conflict('High availability needs this console on HTTPS');
    if (this.pair) throw conflict(`This server is already paired with ${this.pair.partner.name}`);
    const m = /^\[?([^\]\s/]+?)\]?(?::(\d{1,5}))?$/.exec(i.address.trim());
    if (!m) throw badRequest('Give the other server’s address (a name or an IPv4 address, with :port if it is not 9443)');
    const host = m[1]!;
    const port = m[2] ? Number(m[2]) : VIRTUAL_DEFAULT_PORT;
    const ip = isIPv4(host) ? host : await lookup(host, { family: 4 }).then((r) => r.address).catch(() => null);
    if (!ip) throw badRequest(`${host} has no IPv4 address this server can find`);
    const linkAddress = i.linkAddress?.trim() || null;
    if (linkAddress && !isIPv4(linkAddress)) throw badRequest('The dedicated link address must be an IPv4 address');
    const url = `https://${host}:${port}`;
    const pairId = randomBytes(12).toString('base64url');
    const nodeId = randomBytes(12).toString('base64url');
    const settings: HaSettings = { ...HA_DEFAULT_SETTINGS, linkAddress };
    const body = JSON.stringify({ code: i.code, pairId, node: { nodeId, name: this.o.name, port: this.o.port, heartbeatPort: this.o.heartbeatPort, fingerprint: this.o.fingerprint, version: this.o.version, linkAddress }, settings, key: Buffer.from(this.o.key).toString('base64') } satisfies z.infer<typeof JoinSchema>);
    let r: Response;
    try {
      r = await this.https(`${url}/v1/ha/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(15_000) }, i.fingerprint);
    } catch (e) {
      throw badRequest(`Could not reach ${host}:${port}: ${(e as Error).message}`);
    }
    const j = (await r.json().catch(() => null)) as { secret?: string; node?: { nodeId: string; name: string; version: string; heartbeatPort: number; linkAddress: string | null }; error?: { message: string } } | null;
    if (!r.ok || !j?.secret || !j.node) throw badRequest(j?.error?.message ?? `${host} answered ${r.status}`);
    this.pair = {
      pairId,
      nodeId,
      preference: 'primary',
      secret: sealString(this.o.key, j.secret, 'ha.pair'),
      term: 1,
      settings,
      partner: {
        nodeId: j.node.nodeId,
        name: j.node.name,
        url,
        fingerprint: i.fingerprint,
        version: j.node.version,
        preference: 'standby',
        network: `${ip}:${j.node.heartbeatPort}`,
        link: j.node.linkAddress ? `${j.node.linkAddress}:${j.node.heartbeatPort}` : null,
      },
      witness: null,
    };
    this.save();
    this.resetHeard();
    this.startedAt = mono();
    this.setState('starting');
    await this.hb.start();
    this.event('paired', `Paired with ${j.node.name}: ${this.o.name} is the primary, ${j.node.name} the standby`);
    return this.status();
  }

  /** On the standby: the primary asks to pair (with the code this server showed). */
  join(raw: unknown, remoteAddress: string): { secret: string; node: { nodeId: string; name: string; version: string; heartbeatPort: number; linkAddress: string | null } } {
    if (!this.o.fingerprint) throw conflict('This server is not on HTTPS, so it cannot be paired');
    if (this.pair) throw conflict(`This server is already paired with ${this.pair.partner.name}`);
    const i = JoinSchema.parse(raw);
    const code = this.get<StoredCode>(KEY.code);
    if (!code || code.tries <= 0 || Date.parse(code.expiresAt) <= Date.now()) throw unauthorized('Make a pairing code on the standby first (it lasts 30 minutes)');
    if (!same(code.hash, sha(haNormalCode(i.code)))) {
      code.tries -= 1;
      this.put(KEY.code, code);
      throw unauthorized('That pairing code is not right');
    }
    if (i.node.version !== this.o.version) throw conflict(`Both servers must run the same FBRX Server version (${this.o.version} here, ${i.node.version} there)`);
    const ip = plainIp(remoteAddress);
    if (!isIPv4(ip)) throw badRequest('The primary must reach this server over IPv4');
    this.adoptKey(Buffer.from(i.key, 'base64'));
    const secret = randomBytes(32).toString('base64url');
    this.pair = {
      pairId: i.pairId,
      nodeId: randomBytes(12).toString('base64url'),
      preference: 'standby',
      secret: sealString(this.o.key, secret, 'ha.pair'),
      term: 0,
      settings: { ...i.settings, linkAddress: null },
      partner: {
        nodeId: i.node.nodeId,
        name: i.node.name,
        url: `https://${ip}:${i.node.port}`,
        fingerprint: i.node.fingerprint,
        version: i.node.version,
        preference: 'primary',
        network: `${ip}:${i.node.heartbeatPort}`,
        link: i.node.linkAddress ? `${i.node.linkAddress}:${i.node.heartbeatPort}` : null,
      },
      witness: null,
    };
    this.save();
    this.put(KEY.code, null);
    this.resetHeard();
    this.startedAt = mono();
    this.setState('starting');
    // What it kept goes: the primary's copy comes in full.
    this.o.copy?.off();
    this.o.copy?.becomeStandby();
    void this.hb.start();
    void this.o.roles.deactivate(`Paired as the standby of ${i.node.name}`).catch(() => undefined);
    this.event('paired', `Paired with ${i.node.name}: ${i.node.name} is the primary, ${this.o.name} the standby`);
    return { secret, node: { nodeId: this.pair.nodeId, name: this.o.name, version: this.o.version, heartbeatPort: this.o.heartbeatPort, linkAddress: null } };
  }

  /** The standby takes the primary's key (its own sealed secrets re-sealed with it first). */
  private adoptKey(k: Buffer) {
    if (k.length !== 32) throw badRequest('The primary’s key is not right');
    const old = Buffer.from(this.o.key);
    if (old.equals(k)) return;
    const keys = this.keys().map((w) => ({ ...w, secret: sealString(k, openString(old, w.secret, 'ha.witness'), 'ha.witness') }));
    if (this.o.adoptKey) this.o.adoptKey(k, old);
    else this.o.key.set(k);
    this.put(KEY.keys, keys);
  }

  /** Leaves the pair (and tells the partner, when it answers). The active server keeps serving. */
  async unpair(by: string): Promise<HaStatus> {
    const p = this.pair;
    if (!p) throw conflict('This server is not paired');
    await this.peer('unpair', {}, 5_000).catch(() => undefined);
    this.leave(`${by} ended the pair with ${p.partner.name}`);
    return this.status();
  }

  private leave(text: string) {
    const p = this.pair!;
    const wasActive = this.state === 'active';
    if (p.witness && wasActive) void this.witnessCall(true).catch(() => undefined);
    this.pair = null;
    this.save();
    this.o.copy?.off();
    this.hb.stop();
    this.resetHeard();
    this.setState('single');
    this.event('unpaired', text);
    for (const rule of ['ha_partner_lost', 'ha_takeover', 'ha_stopped', 'ha_third_vote', 'ha_behind']) void this.o.alerts.clear(rule).catch(() => undefined);
    // A standby that leaves serves what it has, like any single server.
    if (!wasActive) void this.o.roles.activate('This server left its pair').catch(() => undefined);
  }

  private static unheard() {
    return { beat: null as Beat | null, at: -Infinity, path: { link: -Infinity, network: -Infinity } as Record<HaPathName, number>, boot: null as string | null, bootTs: 0, seq: -1, seqOn: { link: -1, network: -1 } as Record<HaPathName, number> };
  }

  private resetHeard() {
    this.heard = HaService.unheard();
    this.lease = { deadline: -Infinity, holder: null, ok: false, lastOkAt: null, lastAt: null, error: null, failingSince: null };
    this.aloneRaised = false;
    this.witnessRaised = false;
    this.partnerStandbySince = null;
    this.noneServingSince = null;
  }

  // ------------------------------------------------------------------------------------------- settings

  /** The pair's settings (both servers take them) and this server's dedicated link address. */
  async setSettings(i: Partial<HaSettings>): Promise<HaStatus> {
    const p = this.pair;
    if (!p) throw conflict('Pair this server first');
    const next = HaSettingsSchema.parse({ ...p.settings, ...i });
    if (next.linkAddress && !isIPv4(next.linkAddress)) throw badRequest('The dedicated link address must be an IPv4 address');
    p.settings = next;
    this.save();
    await this.peer('config', { settings: { takeoverMs: next.takeoverMs, autoHandBack: next.autoHandBack }, linkAddress: next.linkAddress }).catch((e) => {
      throw conflict(`Saved here, but ${p.partner.name} did not take it: ${(e as Error).message}`);
    });
    return this.status();
  }

  /** The pair's third vote: a witness's address, its certificate (when no authority vouches for it) and its key. */
  async setWitness(i: { url: string; fingerprint?: string | null; key: string } | null): Promise<HaStatus> {
    const p = this.pair;
    if (!p) throw conflict('Pair this server first');
    if (this.state !== 'active') throw conflict(`Set the third vote on the active server (${p.partner.name})`);
    if (!i) {
      if (p.witness) await this.witnessCall(true).catch(() => undefined);
      p.witness = null;
    } else {
      const m = HA_WITNESS_KEY.exec(i.key.trim());
      if (!m) throw badRequest('That is not a third-vote key (it starts with fbrxw1.)');
      let url: URL;
      try {
        url = new URL(i.url.trim());
      } catch {
        throw badRequest('Give the third vote’s address, like https://command.example.org');
      }
      if (url.protocol !== 'https:') throw badRequest('The third vote must be on https://');
      const before = p.witness;
      p.witness = { url: url.origin, fingerprint: i.fingerprint?.trim() || null, id: m[1]!, secret: sealString(this.o.key, m[2]!, 'ha.witness.client') };
      // It has to answer, and give this (active) server the lease.
      try {
        const a = await this.witnessCall(false);
        if (!a.granted) throw new Error('it gave the lease to someone else');
      } catch (e) {
        p.witness = before;
        throw badRequest(`The third vote did not answer as it should: ${(e as Error).message}`);
      }
    }
    this.save();
    await this.peer('config', { witness: p.witness ? { ...p.witness, secret: openString(this.o.key, p.witness.secret, 'ha.witness.client') } : null }).catch((e) => {
      throw conflict(`Saved here, but ${p.partner.name} did not take it: ${(e as Error).message}`);
    });
    this.event('third-vote', p.witness ? `The third vote is ${p.witness.url}` : 'The pair has no third vote now');
    return this.status();
  }

  // ------------------------------------------------------------------------------------------- the heartbeat

  private beat() {
    const p = this.pair;
    if (!p) return;
    const secret = this.secret();
    const base = { p: p.pairId, n: p.nodeId, b: this.boot, s: ++this.seq, t: p.term, st: this.state, pr: p.preference, h: this.hears(), ts: Date.now() };
    if (!this.dropped.send.has('network')) this.hb.send({ ...base, pa: 'network' }, p.partner.network, secret);
    if (p.partner.link && !this.dropped.send.has('link')) this.hb.send({ ...base, pa: 'link' }, p.partner.link, secret);
  }

  private onBeat(b: Beat) {
    const p = this.pair;
    if (!p || b.p !== p.pairId || b.n !== p.partner.nodeId || this.dropped.receive.has(b.pa)) return;
    const h = this.heard;
    // Only news: a later count on that path in the same run, or a new run sent just now (a heartbeat recorded and
    // played again later must not keep the standby from taking over).
    if (b.b === h.boot) {
      if (b.s <= h.seqOn[b.pa]) return;
    } else {
      if (Math.abs(Date.now() - b.ts) > 10_000 || b.ts <= h.bootTs) return;
      Object.assign(h, { boot: b.b, bootTs: b.ts, seq: -1, seqOn: { link: -1, network: -1 } });
    }
    h.seqOn[b.pa] = b.s;
    if (b.s > h.seq) {
      h.seq = b.s;
      h.beat = b;
    }
    const now = mono();
    h.at = now;
    h.path[b.pa] = now;
  }

  // ------------------------------------------------------------------------------------------- deciding

  private async tick(): Promise<void> {
    const p = this.pair;
    if (!p || this.busy) return;
    const now = mono();
    const hears = this.hears(now);
    const b = this.heard.beat;
    const switching = now < this.switchingUntil;
    const partnerActive = hears && b?.st === 'active';
    const silent = Number.isFinite(this.heard.at) ? now - this.heard.at : null;
    if (p.witness && this.state === 'active' && now - this.lastRenew >= this.leaseMs / 4) {
      this.lastRenew = now;
      void this.renew();
    }
    // Both the standby: if it lasts, the primary serves (or, after longer, whichever is left).
    if (hears && b?.st === 'standby' && this.state === 'standby' && !switching) this.noneServingSince ??= now;
    else this.noneServingSince = null;

    // The partner as the standby, for how long (for handing back by itself).
    if (hears && b?.st === 'standby') this.partnerStandbySince ??= now;
    else this.partnerStandbySince = null;

    switch (this.state) {
      case 'starting': {
        if (partnerActive) await this.demote('starting', `${p.partner.name} is active`);
        else if (hears && (p.preference === 'primary' || b?.st === 'stopped' || now - this.startedAt > 3 * this.takeoverMs)) await this.tryActive('start', `${this.o.name} started and ${p.partner.name} was not serving`);
        else if (!hears && now - this.startedAt >= 1.5 * this.takeoverMs) await this.tryActive('takeover', `${p.partner.name} did not answer when ${this.o.name} started`);
        break;
      }
      case 'standby': {
        if (switching || now < this.nextTry) break;
        const none = this.noneServingSince === null ? 0 : now - this.noneServingSince;
        if (!hears) await this.tryActive('takeover', `${p.partner.name} stopped answering: nothing heard on ${p.partner.link ? 'either path' : 'the network'} for ${seconds(silent ?? this.takeoverMs)}`);
        else if (b?.st === 'stopped') await this.tryActive('takeover', `${p.partner.name} stopped serving`);
        else if (none > (p.preference === 'primary' ? 2 : 4) * this.takeoverMs) await this.tryActive('start', 'Neither server was serving');
        break;
      }
      case 'active': {
        if (partnerActive && !switching) {
          // Both serving (they could not hear each other, without a third vote): the later takeover keeps serving.
          const theyWin = b!.t > p.term || (b!.t === p.term && b!.pr === 'primary');
          if (theyWin) {
            await this.demote('both-active', `Both servers were serving; ${p.partner.name} took over later, so it keeps serving`);
            void this.o.alerts.event({ rule: 'ha_both_active', role: 'ha', severity: 'warning', title: `Both servers of the pair were serving for a while (${this.o.name} and ${p.partner.name})`, detail: `They could not hear each other. ${p.partner.name} keeps serving; changes made on ${this.o.name} meanwhile are replaced by ${p.partner.name}'s.`, yours: 'Add a third vote (FBRX Command or another FBRX Server), or a dedicated link between the two, so it cannot happen again.' }).catch(() => undefined);
            break;
          }
        }
        // A margin before the lease runs out, so the roles have stopped before the third vote can give it away.
        if (p.witness && !this.mutual(now) && now > this.lease.deadline - Math.min(300, this.leaseMs / 4)) {
          await this.halt(`${this.o.name} could reach neither ${p.partner.name} nor the third vote, so it stopped serving rather than risk both serving`);
          break;
        }
        await this.watchPartner(now, hears);
        if (hears && b?.st === 'standby') {
          void this.ship();
          this.watchCopy();
        }
        const caughtUp = this.o.copy?.caughtUp() ?? true;
        if (p.settings.autoHandBack && caughtUp && p.preference === 'standby' && b?.pr === 'primary' && this.partnerStandbySince !== null && now - this.partnerStandbySince > (this.o.handBackAfterMs ?? 60_000) && !switching) {
          await this.switchover('the pair (hand back by itself)', 'handback').catch((e) => this.o.log('warn', `High availability: handing back failed: ${(e as Error).message}`));
        }
        break;
      }
      case 'stopped': {
        if (partnerActive) await this.demote('standby', `${p.partner.name} is serving`);
        else if (now >= this.nextTry) await this.tryActive('resume', `${this.o.name} reaches the third vote again`);
        break;
      }
    }
  }

  /** While active: the partner gone quiet (or back) is an alert of its own. */
  private async watchPartner(now: number, hears: boolean) {
    const p = this.pair!;
    const silent = now - this.heard.at;
    if (!hears && !this.aloneRaised && silent >= Math.max(ALONE_ALERT_MS, 3 * this.takeoverMs)) {
      this.aloneRaised = true;
      this.event('partner-lost', `${p.partner.name} is not answering: the pair runs on ${this.o.name} alone`);
      void this.o.alerts.raise({ rule: 'ha_partner_lost', role: 'ha', severity: 'warning', title: `The pair runs on one server: ${p.partner.name} is not answering`, detail: `${this.o.name} serves; if it stops too, nothing takes over.`, yours: `Find out why ${p.partner.name} stopped (power, network, an update). Once it is back it catches up as the standby by itself.` }).catch(() => undefined);
    }
    if (hears && this.heard.beat?.st === 'standby') {
      const steps: HaStep[] = [{ at: iso(), text: `${p.partner.name} answered again and is the standby` }];
      if (this.aloneRaised) {
        this.aloneRaised = false;
        this.event('partner-back', `${p.partner.name} is back as the standby`, steps);
        void this.o.alerts.clear('ha_partner_lost', undefined, { detail: `${p.partner.name} is back as the standby.`, steps }).catch(() => undefined);
      }
      if (this.takeoverOpen) {
        this.takeoverOpen = false;
        void this.o.alerts.clear('ha_takeover', undefined, { detail: `${p.partner.name} answered again and is the standby; ${this.o.name} keeps serving.`, steps }).catch(() => undefined);
      }
    }
  }

  /** Become the active one, with the third vote's lease when the pair has one. */
  private async tryActive(kind: 'start' | 'takeover' | 'resume' | 'switchover' | 'handback', reason: string, steps: HaStep[] = []): Promise<boolean> {
    const p = this.pair!;
    this.busy = true;
    try {
      const at = (text: string) => steps.push({ at: iso(), text });
      if (kind === 'takeover') at(reason);
      if (p.witness) {
        let a: HaLeaseAnswer;
        try {
          a = await this.witnessCall(false, Math.max(p.term, this.heard.beat?.t ?? 0) + 1);
        } catch (e) {
          // Without the third vote nothing is taken over: better none serving than two.
          if (this.state === 'starting') this.setState('standby');
          this.nextTry = mono() + this.takeoverMs;
          this.o.log('warn', `High availability: not taking over: the third vote did not answer (${(e as Error).message})`);
          return false;
        }
        if (!a.granted) {
          if (this.state === 'starting') this.setState('standby');
          this.nextTry = mono() + Math.min(a.remainingMs + 50, this.takeoverMs);
          return false;
        }
        p.term = a.term;
        at(`The third vote gave ${this.o.name} the pair (term ${a.term})`);
      } else p.term = Math.max(p.term, this.heard.beat?.t ?? 0) + 1;
      this.save();
      const was = this.state;
      const asOf = this.o.copy?.copyAsOf() ?? null;
      if (kind === 'takeover' && this.o.copy) at(asOf ? `Its copy of ${p.partner.name}'s data was current as of ${seconds(Math.max(0, Date.now() - Date.parse(asOf)))} before` : `It had no complete copy of ${p.partner.name}'s data yet`);
      this.o.copy?.becomeActive();
      this.setState('active');
      steps.push(...(await this.o.roles.activate(reason).catch((e) => [{ at: iso(), text: `A role did not start: ${(e as Error).message}` }])));
      at(`${this.o.name} is serving`);
      this.aloneRaised = false;
      if (was === 'stopped') void this.o.alerts.clear('ha_stopped', undefined, { detail: `${this.o.name} reaches the third vote again and serves.`, steps }).catch(() => undefined);
      if (kind === 'takeover') {
        this.takeoverOpen = true;
        this.event('takeover', `${this.o.name} took over from ${p.partner.name}`, steps);
        void this.o.alerts
          .raise({ rule: 'ha_takeover', role: 'ha', severity: 'critical', title: `${this.o.name} took over from ${p.partner.name}`, detail: reason, done: `${this.o.name} serves everything ${p.partner.name} served.`, yours: `Find out why ${p.partner.name} stopped (power, network, a crash). Once it is back it catches up as the standby; hand the work back from High availability when you are ready.`, steps })
          .catch(() => undefined);
      } else if (kind === 'resume') this.event('resumed', `${this.o.name} serves again: ${reason}`, steps);
      else if (kind === 'start' && was === 'standby') this.event('resumed', reason, steps);
      return true;
    } finally {
      this.busy = false;
    }
  }

  private async demote(kind: 'starting' | 'standby' | 'both-active', reason: string): Promise<HaStep[]> {
    const was = this.state;
    this.setState('standby');
    this.o.copy?.becomeStandby();
    const steps = was === 'active' || was === 'stopped' ? await this.o.roles.deactivate(reason).catch((e) => [{ at: iso(), text: `A role did not stop: ${(e as Error).message}` }]) : [];
    if (kind === 'both-active') this.event('both-active', reason, steps);
    if (was === 'stopped') void this.o.alerts.clear('ha_stopped', undefined, { detail: `${this.pair?.partner.name} serves; ${this.o.name} is the standby.` }).catch(() => undefined);
    return steps;
  }

  private async halt(reason: string) {
    this.busy = true;
    try {
      this.setState('stopped');
      this.o.copy?.becomeStandby();
      const steps = await this.o.roles.deactivate(reason).catch((e) => [{ at: iso(), text: `A role did not stop: ${(e as Error).message}` }]);
      this.nextTry = mono() + this.takeoverMs;
      this.event('stopped', reason, steps);
      void this.o.alerts.raise({ rule: 'ha_stopped', role: 'ha', severity: 'critical', title: `${this.o.name} stopped serving`, detail: reason, yours: `Check the network around ${this.o.name}, ${this.pair?.partner.name} and the third vote.`, steps }).catch(() => undefined);
    } finally {
      this.busy = false;
    }
  }

  // ------------------------------------------------------------------------------------------- copying

  /** The roles' data to copy (set once the roles are up, before start). */
  useCopy(c: HaCopy): void {
    this.o.copy = c;
  }

  /** Sends the standby what changed (a full copy first when it needs one). */
  private async ship(force = false): Promise<void> {
    const c = this.o.copy;
    if (!c || (this.copying && !force)) return;
    while (this.copying) await new Promise((r) => setTimeout(r, 10));
    this.copying = true;
    try {
      for (const parts of c.snapshots()) {
        let last: CopyAck[] = [];
        for (const part of parts) last = (await this.peer<{ acks: CopyAck[] }>('copy', { batches: [part] }, 60_000)).acks;
        c.acked(last);
      }
      const batches = c.outgoing(force);
      if (batches.length) c.acked((await this.peer<{ acks: CopyAck[] }>('copy', { batches }, 30_000)).acks);
    } catch (e) {
      if (Date.now() - this.lastCopyError > 30_000) {
        this.lastCopyError = Date.now();
        this.o.log('warn', `High availability: copying to ${this.pair?.partner.name} failed: ${(e as Error).message}`);
      }
    } finally {
      this.copying = false;
    }
  }

  /** The standby falling far behind is an alert; caught up again, its all-clear. */
  private watchCopy() {
    const c = this.o.copy;
    const p = this.pair;
    if (!c || !p) return;
    const late = c.views().filter((v) => v.state !== 'caught-up' && (v.behindMs ?? 0) > BEHIND_ALERT_MS);
    if (late.length && !this.behindRaised) {
      this.behindRaised = true;
      const worst = Math.max(...late.map((v) => v.behindMs ?? 0));
      void this.o.alerts.raise({ rule: 'ha_behind', role: 'ha', severity: 'warning', title: `${p.partner.name} is falling behind: its copy is ${seconds(worst)} old`, detail: `Behind on ${late.map((v) => v.label.toLowerCase()).join(', ')}. If ${this.o.name} stopped now, what changed since would be missing on ${p.partner.name}.`, yours: `Check the network between ${this.o.name} and ${p.partner.name}, and that ${p.partner.name} has room on its drive.` }).catch(() => undefined);
    } else if (this.behindRaised && c.caughtUp()) {
      this.behindRaised = false;
      void this.o.alerts.clear('ha_behind', undefined, { detail: `${p.partner.name} has caught up.` }).catch(() => undefined);
    }
  }

  // ------------------------------------------------------------------------------------------- the third vote

  /** Keeps the lease while active (and the third vote's state on the page). */
  private async renew(): Promise<void> {
    const p = this.pair;
    if (!p?.witness || this.state !== 'active' || this.renewing || this.busy) return;
    this.renewing = true;
    try {
      const a = await this.witnessCall(false);
      if (!a.granted && this.state === 'active') {
        // The third vote gave the pair to the partner: this server must stop at once.
        await this.halt(`The third vote gave the pair to ${p.partner.name}, so ${this.o.name} stopped serving`);
      }
    } catch {
      /* counted in witnessCall */
    } finally {
      this.renewing = false;
    }
  }

  private async witnessCall(release: boolean, term = this.pair!.term): Promise<HaLeaseAnswer> {
    const p = this.pair!;
    const w = p.witness!;
    const body = JSON.stringify({ id: w.id, node: p.nodeId, term, leaseMs: this.leaseMs, ...(release ? { release: true } : {}) });
    const sentAt = mono();
    try {
      if (this.dropped.witness) throw new Error('out of reach (test)');
      const r = await this.https(`${w.url}/v1/ha/witness/lease`, { method: 'POST', headers: { 'content-type': HA_SIGNED_TYPE, [HA_WITNESS_SIGNATURE]: signHaRequest(body, openString(this.o.key, w.secret, 'ha.witness.client')) }, body, signal: AbortSignal.timeout(Math.max(400, Math.min(this.leaseMs / 2, 2_000))) }, w.fingerprint);
      const j = (await r.json().catch(() => null)) as (HaLeaseAnswer & { error?: { message: string } }) | null;
      if (!r.ok || !j || typeof j.granted !== 'boolean') throw new Error(j?.error?.message ?? `it answered ${r.status}`);
      if (j.granted) this.lease.deadline = sentAt + this.leaseMs;
      if (release) this.lease.deadline = -Infinity;
      this.lease.holder = j.holder === p.nodeId ? 'me' : j.holder ? 'partner' : null;
      this.lease.ok = true;
      this.lease.lastOkAt = mono();
      this.lease.lastAt = iso();
      this.lease.error = null;
      this.lease.failingSince = null;
      if (this.witnessRaised) {
        this.witnessRaised = false;
        void this.o.alerts.clear('ha_third_vote', undefined, { detail: 'The third vote answers again.' }).catch(() => undefined);
      }
      return j;
    } catch (e) {
      const msg = (e as Error).name === 'TimeoutError' ? 'no answer in time' : (e as Error).message;
      this.lease.ok = false;
      this.lease.error = msg;
      this.lease.failingSince ??= mono();
      if (!this.witnessRaised && this.state === 'active' && mono() - this.lease.failingSince > WITNESS_ALERT_MS) {
        this.witnessRaised = true;
        void this.o.alerts.raise({ rule: 'ha_third_vote', role: 'ha', severity: 'warning', title: 'The pair’s third vote does not answer', detail: `${w.url}: ${msg}`, yours: `While it is gone, ${this.o.name} keeps serving only while it hears ${p.partner.name}. Check the third vote and the network to it.` }).catch(() => undefined);
      }
      throw new Error(msg);
    }
  }

  // ------------------------------------------------------------------------------------------- switching over

  /**
   * Hands the work to the standby on purpose (a drill, or before an update), or back to the primary. Asked on either
   * server: the standby passes it to the active one.
   */
  async switchover(by: string, kind: 'switchover' | 'handback' = 'switchover'): Promise<HaStatus> {
    const p = this.pair;
    if (!p) throw conflict('This server is not paired');
    if (this.state === 'standby' && this.hears() && this.heard.beat?.st === 'active') {
      await this.peer('switchover', { by, kind }, 30_000);
      return this.status();
    }
    if (this.state !== 'active') throw conflict(`${this.o.name} is ${HA_STATE_NAMES[this.state].toLowerCase()}: nothing to hand over`);
    // Just after a change the partner's next heartbeat may still be on its way: wait for it a moment.
    const ready = () => this.mutual() && this.heard.beat?.st === 'standby';
    for (const until = mono() + 2 * this.takeoverMs; !ready() && mono() < until; ) await new Promise((r) => setTimeout(r, this.heartbeatMs));
    if (!ready()) throw conflict(`${p.partner.name} is not ready to take over (it has to be heard as the standby)`);
    // And it has everything: nothing is lost by switching over.
    const copied = () => this.o.copy?.caughtUp() ?? true;
    for (const until = mono() + CATCH_UP_MS; !copied() && mono() < until; ) await new Promise((r) => setTimeout(r, this.heartbeatMs));
    if (!copied()) {
      const behind = (this.o.copy?.views() ?? []).filter((v) => v.state !== 'caught-up').map((v) => v.label.toLowerCase());
      throw conflict(`${p.partner.name} is still copying (${behind.join(', ')}): try again when it has caught up`);
    }
    if (this.busy) throw conflict('The pair is busy: try again in a moment');
    this.busy = true;
    this.switchingUntil = mono() + 30_000;
    const steps: HaStep[] = [];
    const at = (text: string) => steps.push({ at: iso(), text });
    try {
      at(kind === 'handback' ? `${by} handed the work back to ${p.partner.name}` : `${by} switched over to ${p.partner.name}`);
      // The last changes go first; from now on nothing changes here.
      this.setState('standby');
      await this.ship(true);
      this.o.copy?.becomeStandby();
      steps.push(...(await this.o.roles.deactivate(`Switching over to ${p.partner.name}`).catch((e) => [{ at: iso(), text: `A role did not stop: ${(e as Error).message}` }])));
      if (p.witness) {
        await this.witnessCall(true).catch(() => undefined);
        at(`${this.o.name} gave up the third vote's lease`);
      }
      try {
        const r = await this.peer<{ steps: HaStep[] }>('take', { kind, steps }, 30_000);
        steps.splice(0, steps.length, ...r.steps);
      } catch (e) {
        // It did not take over: this server serves again.
        at(`${p.partner.name} did not take over (${(e as Error).message}); ${this.o.name} serves again`);
        this.busy = false;
        await this.tryActive('resume', 'The switchover did not happen', steps);
        throw conflict(`${p.partner.name} did not take over: ${(e as Error).message}`);
      }
      this.event(kind, kind === 'handback' ? `Handed back to ${p.partner.name}` : `Switched over to ${p.partner.name}`, steps);
      return this.status();
    } finally {
      this.busy = false;
      this.switchingUntil = mono() + 2 * this.takeoverMs;
    }
  }

  // ------------------------------------------------------------------------------------------- the partner

  /** A signed request from the partner. */
  async handlePeer(body: string, signature: string | undefined): Promise<unknown> {
    const p = this.pair;
    if (!p || !verifyHaRequest(body, signature, this.secret())) throw unauthorized('Not from this server’s partner');
    const m = PeerSchema.parse(JSON.parse(body));
    if (m.pair !== p.pairId || m.from !== p.partner.nodeId) throw forbidden('Not from this server’s partner');
    switch (m.op) {
      case 'hello':
        return { ok: true, state: this.state };
      case 'copy': {
        if (this.state === 'active') throw conflict(`${this.o.name} is the active server: it does not take a copy`);
        const { batches } = z.object({ batches: z.array(z.object({ name: z.string().max(40) }).passthrough()).max(20) }).parse(m);
        return { acks: this.o.copy?.receive(batches as unknown as CopyBatch[]) ?? [] };
      }
      case 'take': {
        const { kind, steps } = z.object({ kind: z.enum(['switchover', 'handback']), steps: z.array(z.object({ at: z.string(), text: z.string().max(300) })).max(50) }).parse(m);
        // Already serving (it saw nobody was): the same outcome.
        if (this.state === 'active') return { steps: [...steps, { at: iso(), text: `${this.o.name} is serving` }] };
        if (this.state !== 'standby') throw conflict(`${this.o.name} is not the standby`);
        this.switchingUntil = mono() + 30_000;
        const mine = [...steps];
        const ok = await this.tryActive(kind, kind === 'handback' ? `${p.partner.name} handed the work back` : `${p.partner.name} switched over to ${this.o.name}`, mine);
        this.switchingUntil = mono() + 2 * this.takeoverMs;
        if (!ok) throw conflict('the third vote did not give it the pair');
        this.event(kind, kind === 'handback' ? `${p.partner.name} handed the work back to ${this.o.name}` : `${p.partner.name} switched over to ${this.o.name}`, mine);
        void this.o.alerts.clear('ha_takeover', undefined, { detail: `The work moved to ${this.o.name}.`, steps: mine }).catch(() => undefined);
        void this.o.alerts.event({ rule: kind === 'handback' ? 'ha_handback' : 'ha_switchover', role: 'ha', severity: 'info', title: kind === 'handback' ? `The work was handed back to ${this.o.name}` : `Switched over to ${this.o.name}`, detail: `${this.o.name} serves; ${p.partner.name} is the standby.`, steps: mine }).catch(() => undefined);
        return { steps: mine };
      }
      case 'switchover': {
        const { by, kind } = z.object({ by: z.string().max(120), kind: z.enum(['switchover', 'handback']) }).parse(m);
        await this.switchover(by, kind);
        return { ok: true };
      }
      case 'config': {
        const c = z
          .object({
            settings: z.object({ takeoverMs: HaSettingsSchema.shape.takeoverMs, autoHandBack: z.boolean() }).optional(),
            linkAddress: z.string().max(64).nullable().optional(),
            witness: z.object({ url: z.string().url(), fingerprint: z.string().nullable(), id: z.string(), secret: z.string() }).nullable().optional(),
          })
          .parse(m);
        if (c.settings) p.settings = { ...p.settings, ...c.settings };
        if (c.linkAddress !== undefined) p.partner.link = c.linkAddress && isIPv4(c.linkAddress) ? `${c.linkAddress}:${p.partner.network.split(':')[1]}` : null;
        if (c.witness !== undefined) p.witness = c.witness ? { ...c.witness, secret: sealString(this.o.key, c.witness.secret, 'ha.witness.client') } : null;
        this.save();
        return { ok: true };
      }
      case 'unpair':
        this.leave(`${p.partner.name} ended the pair`);
        return { ok: true };
    }
  }

  private async peer<T = unknown>(op: string, payload: object = {}, timeoutMs = 10_000): Promise<T> {
    const p = this.pair!;
    const body = JSON.stringify({ pair: p.pairId, from: p.nodeId, op, ...payload });
    const r = await this.https(`${p.partner.url}/v1/ha/peer`, { method: 'POST', headers: { 'content-type': HA_SIGNED_TYPE, [HA_WITNESS_SIGNATURE]: signHaRequest(body, this.secret()) }, body, signal: AbortSignal.timeout(timeoutMs) }, p.partner.fingerprint);
    const j = (await r.json().catch(() => null)) as (T & { error?: { message: string } }) | null;
    if (!r.ok) throw new Error(j?.error?.message ?? `${p.partner.name} answered ${r.status}`);
    return j as T;
  }

  /** HTTPS to the partner or the third vote: pinned to the fingerprint trusted, or checked by the system's authorities. */
  private https(url: string, init: RequestInit, fingerprint: string | null): Promise<Response> {
    if (!fingerprint) return fetch(url, init);
    let a = this.agents.get(fingerprint);
    if (!a) {
      a = pinnedAgent(fingerprint, 'The other server presented a different certificate than the one trusted when pairing.');
      this.agents.set(fingerprint, a);
    }
    return pinnedFetch(url, init, a);
  }

  // ------------------------------------------------------------------------------------------- hosting a third vote

  private keys(): WitnessKey[] {
    return this.get<WitnessKey[]>(KEY.keys) ?? [];
  }

  private touchKey(id: string) {
    const keys = this.keys();
    const k = keys.find((x) => x.id === id);
    // At most once a minute: renewals come several times a second.
    if (k && (!k.lastUsedAt || Date.now() - Date.parse(k.lastUsedAt) > 60_000)) {
      k.lastUsedAt = iso();
      this.put(KEY.keys, keys);
    }
  }

  /** A key another pair uses to have this server as its third vote, shown this once. */
  addWitnessKey(label: string): { id: string; key: string; fingerprint: string | null } {
    const keys = this.keys();
    if (keys.length >= 20) throw conflict('At most 20 third-vote keys: remove one first');
    const k = newWitnessKey();
    keys.push({ id: k.id, label: label.trim().slice(0, 80) || 'A pair of FBRX Servers', secret: sealString(this.o.key, k.secret, 'ha.witness'), createdAt: iso(), lastUsedAt: null });
    this.put(KEY.keys, keys);
    return { id: k.id, key: k.key, fingerprint: this.o.fingerprint };
  }

  removeWitnessKey(id: string): void {
    const keys = this.keys();
    if (!keys.some((k) => k.id === id)) throw notFound('That third-vote key is gone already');
    this.put(KEY.keys, keys.filter((k) => k.id !== id));
    this.put(KEY.leases, (this.get<StoredLease[]>(KEY.leases) ?? []).filter((l) => l.id !== id));
    this.witness.forget(id);
  }

  // ------------------------------------------------------------------------------------------- tests

  /** Tests: cut a path, one way or both. */
  testDrop(o: { send?: HaPathName[]; receive?: HaPathName[]; witness?: boolean }): void {
    this.dropped = { send: new Set(o.send ?? []), receive: new Set(o.receive ?? []), witness: !!o.witness };
  }
}
