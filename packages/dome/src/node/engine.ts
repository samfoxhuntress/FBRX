import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { inCidr } from '@fbrx/shared';
import type { GateConfig } from '@fbrx/gate';
import { Detectors, type DetectContext } from '../detect';
import { normalizeName, parseFeed } from '../domains';
import {
  DOME_SEVERITIES,
  DOME_TEST_DOMAIN,
  type DomeDevice,
  type DomeEvent,
  type DomeFinding,
  type DomeSettings,
  type DomeSignal,
  type DomeState,
  type DomeStatus,
} from '../types';
import type { DomeSensor } from './sensors';
import type { DomeStore } from './store';

/** FBRX computers on FBRX Mesh, as the core on this server knows them. */
export interface DomeComputer {
  name: string;
  addresses: string[];
  protection: { name: string; state: string; realtime: boolean | null; threats: number } | null;
}

export interface DomeEngineOptions {
  store: DomeStore;
  sensors: DomeSensor[];
  mode: 'linux' | 'simulated';
  /** What the gate runs now. */
  gate: () => GateConfig | null;
  /** The gate's other addresses (the internet side), looked up now and then. */
  gateAddresses?: () => Promise<string[]>;
  /** Where the threat lists are kept between restarts. */
  feedCache: string;
  fetchFeed?: (url: string) => Promise<string>;
  /** Tells the FBRX computer a finding is about (through FBRX Mesh); returns its name when it was told. */
  notify?: (f: DomeFinding) => Promise<string | null>;
  /** FBRX computers on the mesh, for the device list. */
  computers?: () => Promise<DomeComputer[]>;
  /** How long a new MiniDome learns the network before it reports new devices. */
  learnMs?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

const HOSTNAME = /^(?=.{1,253}$)([a-zA-Z0-9_]([a-zA-Z0-9-_]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
export const DomeSettingsSchema = z.object({
  enabled: z.boolean(),
  sensitivity: z.enum(['low', 'normal', 'high']),
  feeds: z.array(z.string().url().max(500).refine((u) => /^https?:\/\//.test(u), 'Lists are fetched over http or https')).max(16),
  allow: z.array(z.string().regex(HOSTNAME, 'Not a domain')).max(500),
  notifyComputers: z.boolean(),
  newDevices: z.boolean(),
});

const FEED_EVERY_MS = 12 * 3600_000;
const MAX_FEED = 30 * 1024 * 1024;

async function defaultFetch(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000), redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const len = Number(res.headers.get('content-length') ?? 0);
  if (len > MAX_FEED) throw new Error('too big');
  const text = await res.text();
  if (text.length > MAX_FEED) throw new Error('too big');
  return text;
}

/**
 * FBRX MiniDome: listens to the gate (names asked, new connections, devices), runs the detectors, and keeps what
 * they find: one finding per device and subject, counted, with the latest evidence. FBRX computers a finding is
 * about can be told through FBRX Mesh (their FBRX Shield then knows too).
 */
export class DomeEngine {
  private readonly detectors: Detectors;
  private feed = new Set<string>([DOME_TEST_DOMAIN]);
  private feedAt: string | null = null;
  private feedErrors: string[] = [];
  private extra: string[] = [];
  private leases = new Map<string, { mac: string; name: string | null; network: string | null }>();
  private timers: NodeJS.Timeout[] = [];
  private buckets = new Map<number, number>();
  private counts = { dns: 0, flows: 0 };
  private since = new Date().toISOString();
  private running = false;
  private ctxCache: { at: number; ctx: DetectContext } | null = null;

  constructor(private readonly o: DomeEngineOptions) {
    this.detectors = new Detectors(() => this.context());
    if (!o.store.meta<string>('learning_until')) o.store.setMeta('learning_until', new Date(Date.now() + (o.learnMs ?? 10 * 60_000)).toISOString());
    this.loadFeedCache();
  }

  private log(level: 'info' | 'warn' | 'error', msg: string) {
    this.o.log?.(level, msg);
  }

  settings(): DomeSettings {
    return this.o.store.settings();
  }

  /** Changes the settings (checked); fetches the threat lists again when they changed. */
  setSettings(input: unknown): DomeSettings {
    const s = DomeSettingsSchema.parse(input);
    const before = this.settings();
    s.allow = [...new Set(s.allow.map(normalizeName))];
    this.o.store.setSettings(s);
    this.ctxCache = null;
    if (JSON.stringify(before.feeds) !== JSON.stringify(s.feeds)) void this.refreshFeeds();
    if (before.enabled !== s.enabled) {
      if (s.enabled) this.start();
      else this.pause();
    }
    return s;
  }

  // ------------------------------------------------------------------------------------------- context

  private context(): DetectContext {
    if (this.ctxCache && Date.now() - this.ctxCache.at < 5000) return this.ctxCache.ctx;
    const c = this.o.gate();
    const s = this.settings();
    const ctx: DetectContext = {
      gateAddresses: new Set([...(c?.networks.map((n) => n.address.split('/')[0]) ?? []), ...(c?.wan.address ? [c.wan.address.split('/')[0]] : []), ...(c?.vpn.enabled ? [c.vpn.address.split('/')[0]] : []), ...this.extra]),
      networks: [...(c?.networks.map((n) => ({ name: n.name, cidr: n.address })) ?? []), ...(c?.vpn.enabled ? [{ name: 'vpn', cidr: c.vpn.address }] : [])],
      feed: this.feed,
      blocked: new Set((c?.dns.block.enabled ? c.dns.block.domains : []).map(normalizeName)),
      allow: new Set(s.allow),
      sensitivity: s.sensitivity,
      meshPort: c?.qos.preferMesh.port ?? 47800,
      leaseMac: (ip) => this.leases.get(ip)?.mac ?? null,
    };
    this.ctxCache = { at: Date.now(), ctx };
    return ctx;
  }

  private learning(): boolean {
    const until = this.o.store.meta<string>('learning_until');
    return !!until && Date.now() < Date.parse(until);
  }

  // ------------------------------------------------------------------------------------------- feeds

  private loadFeedCache() {
    try {
      if (!existsSync(this.o.feedCache)) return;
      const j = JSON.parse(readFileSync(this.o.feedCache, 'utf8')) as { at: string; domains: string[] };
      this.feed = new Set([DOME_TEST_DOMAIN, ...j.domains]);
      this.feedAt = j.at;
    } catch {
      /* fetched again */
    }
  }

  /** Fetches the threat lists; the old ones stay when a list cannot be fetched. */
  async refreshFeeds(): Promise<{ domains: number; errors: string[] }> {
    const s = this.settings();
    const fetcher = this.o.fetchFeed ?? defaultFetch;
    const domains = new Set<string>([DOME_TEST_DOMAIN]);
    const errors: string[] = [];
    let fetched = 0;
    for (const url of s.feeds) {
      try {
        for (const d of parseFeed(await fetcher(url))) domains.add(d);
        fetched++;
      } catch (e) {
        errors.push(`${url}: ${(e as Error).message}`);
      }
    }
    this.feedErrors = errors;
    if (fetched || !s.feeds.length) {
      this.feed = domains;
      this.feedAt = new Date().toISOString();
      this.ctxCache = null;
      try {
        mkdirSync(dirname(this.o.feedCache), { recursive: true });
        writeFileSync(this.o.feedCache, JSON.stringify({ at: this.feedAt, domains: [...domains] }));
      } catch (e) {
        this.log('warn', `MiniDome: threat lists not saved: ${(e as Error).message}`);
      }
    }
    if (errors.length) this.log('warn', `MiniDome: ${errors.join('; ')}`);
    return { domains: this.feed.size, errors };
  }

  // ------------------------------------------------------------------------------------------- events

  /** One event from a sensor (or a test). */
  ingest(e: DomeEvent) {
    if (!this.settings().enabled) return;
    const c = this.o.gate();
    if (e.type === 'dns') {
      this.counts.dns++;
      const m = Math.floor(e.at / 60_000);
      this.buckets.set(m, (this.buckets.get(m) ?? 0) + 1);
    } else if (e.type === 'flow') this.counts.flows++;
    else if (e.type === 'lease' || e.type === 'neighbor') this.device(e, c);
    for (const s of this.detectors.handle(e)) this.signal(s);
  }

  /** A device seen on one of the gate's networks (the internet side's router is not one). */
  private device(e: Extract<DomeEvent, { type: 'lease' | 'neighbor' }>, c: GateConfig | null) {
    const network = e.type === 'lease' ? e.network : (c?.networks.find((n) => inCidr(e.ip, n.address))?.name ?? null);
    if (e.type === 'neighbor' && !network) return;
    if (e.type === 'lease') this.leases.set(e.ip, { mac: e.mac, name: e.name, network: e.network });
    const lease = this.leases.get(e.ip);
    const name = e.type === 'lease' ? e.name : lease?.mac === e.mac ? (lease.name ?? null) : null;
    const first = this.o.store.seen({ mac: e.mac, ip: e.ip, name, network });
    if (!first || this.learning() || !this.settings().newDevices) return;
    this.signal({
      key: `new-device:${e.mac}`,
      kind: 'new-device',
      severity: 'info',
      title: `New device on ${network ?? 'your network'}: ${name ?? e.mac}`,
      detail: `${name ?? 'A device'} (${e.mac}) joined ${network ?? 'your network'} at ${e.ip}. Expected? Resolve this. Not yours? Look at it under Devices.`,
      ip: e.ip,
      mac: e.mac,
      subject: e.mac,
      evidence: [`${new Date(e.at).toLocaleTimeString()} ${e.ip} ${e.mac}${name ? ` (${name})` : ''}`],
    });
  }

  private signal(s: DomeSignal) {
    const lease = s.ip ? this.leases.get(s.ip) : undefined;
    const known = s.mac ? this.o.store.device(s.mac) : s.ip ? this.o.store.byIp(s.ip) : null;
    const name = lease?.name ?? known?.name ?? null;
    const label = name ?? s.ip ?? 'A device';
    const signal = { ...s, title: s.title.replace('{device}', label) };
    const { finding, news } = this.o.store.record(signal, { name, network: lease?.network ?? known?.network ?? null, mac: s.mac ?? lease?.mac ?? known?.mac ?? null });
    if (news) this.log(finding.severity === 'info' ? 'info' : 'warn', `MiniDome: ${finding.title}`);
    if (news && this.o.notify && this.settings().notifyComputers && DOME_SEVERITIES.indexOf(finding.severity) >= DOME_SEVERITIES.indexOf('warning') && finding.device.ip) {
      void this.o
        .notify(finding)
        .then((who) => who && this.o.store.setNotified(finding.id, who))
        .catch((e) => this.log('warn', `MiniDome: could not tell the computer: ${(e as Error).message}`));
    }
  }

  // ------------------------------------------------------------------------------------------- reading

  findings(status?: DomeStatus | 'active', limit = 200): DomeFinding[] {
    return this.o.store.findings({ status, limit });
  }

  finding(id: number): DomeFinding | null {
    return this.o.store.finding(id);
  }

  setStatus(id: number, status: DomeStatus): DomeFinding | null {
    return this.o.store.setStatus(id, status);
  }

  async devices(): Promise<DomeDevice[]> {
    const computers = await (this.o.computers?.() ?? Promise.resolve([] as DomeComputer[])).catch(() => [] as DomeComputer[]);
    return this.o.store.devices().map((d) => {
      const pc = d.ip ? computers.find((c) => c.addresses.includes(d.ip!)) : undefined;
      return { ...d, fbrx: pc ? { name: pc.name, protection: pc.protection } : null };
    });
  }

  state(): DomeState {
    const now = Math.floor(Date.now() / 60_000);
    const learningUntil = this.o.store.meta<string>('learning_until');
    return {
      mode: this.o.mode,
      settings: this.settings(),
      open: this.o.store.openCounts(),
      learningUntil: learningUntil && Date.parse(learningUntil) > Date.now() ? learningUntil : null,
      stats: {
        since: this.since,
        dnsQueries: this.counts.dns,
        flows: this.counts.flows,
        dnsPerMinute: Array.from({ length: 60 }, (_x, i) => this.buckets.get(now - 59 + i) ?? 0),
        devices: this.o.store.deviceCount(),
        feedDomains: this.feed.size,
        feedUpdatedAt: this.feedAt,
        feedErrors: this.feedErrors,
        sensors: this.running ? this.o.sensors.map((s) => s.status()) : [],
      },
    };
  }

  // ------------------------------------------------------------------------------------------- running

  start() {
    if (this.running || !this.settings().enabled) return;
    this.running = true;
    for (const s of this.o.sensors) {
      try {
        s.start((e) => {
          try {
            this.ingest(e);
          } catch (err) {
            this.log('error', `MiniDome: ${(err as Error).message}`);
          }
        });
      } catch (e) {
        this.log('warn', `MiniDome: ${s.name} did not start: ${(e as Error).message}`);
      }
    }
    const every = (ms: number, fn: () => void) => {
      const t = setInterval(fn, ms);
      t.unref?.();
      this.timers.push(t);
    };
    every(60_000, () => {
      this.detectors.prune();
      const old = Math.floor(Date.now() / 60_000) - 60;
      for (const k of this.buckets.keys()) if (k < old) this.buckets.delete(k);
      this.o.store.trim();
    });
    const lookUp = () => void this.o.gateAddresses?.().then((a) => ((this.extra = a), (this.ctxCache = null))).catch(() => undefined);
    lookUp();
    every(60_000, lookUp);
    if (!this.feedAt || Date.now() - Date.parse(this.feedAt) > FEED_EVERY_MS) void this.refreshFeeds();
    every(FEED_EVERY_MS, () => void this.refreshFeeds());
  }

  private pause() {
    for (const s of this.o.sensors) s.stop();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.running = false;
  }

  stop() {
    this.pause();
  }
}
