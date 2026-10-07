import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { networkInterfaces, platform as osPlatform } from 'node:os';
import { extname, join, normalize } from 'node:path';
import mdnsFactory from 'multicast-dns';
import QRCode from 'qrcode';
import {
  newId,
  type AlertItem,
  type ApprovalRequest,
  type MeshDevice,
  type MeshJob,
  type MeshMessage,
  type MeshPairing,
  type MeshPermissions,
  type MeshStatus,
  type Note,
  type Task,
} from '@fbrx/shared';
import { CoreError, errorMessage } from '../errors';
import type { EventBus } from '../events';
import type { Logger } from '../logger';
import type { Db } from '../storage/db';
import {
  fingerprint,
  generateKeyPair,
  groupCode,
  macEquals,
  newPairingCode,
  normalizeCode,
  open,
  pairingMac,
  ReplayGuard,
  seal,
  type Envelope,
  type KeyPair,
} from './mesh-crypto';

export const MOBILE_PERMISSIONS: MeshPermissions = { status: true, chat: true, ask: true, approve: true, workspace: true, alerts: true, control: false, assist: false, command: false };
// Computers may ask each other's AI for help (each computer's Mesh Assist settings still decide); controllers are chosen by hand.
export const DESKTOP_PERMISSIONS: MeshPermissions = { status: true, chat: true, ask: false, approve: false, workspace: false, alerts: false, control: false, assist: true, command: false };
const PERMISSION_KEYS = Object.keys(MOBILE_PERMISSIONS) as Array<keyof MeshPermissions>;

const PAIRING_TTL_MS = 5 * 60_000;
const MAX_PAIR_FAILURES = 5;
const MAX_BODY = 256 * 1024;
const MOBILE_ONLINE_MS = 90_000;

interface DeviceRow {
  id: string;
  name: string;
  kind: 'desktop' | 'mobile';
  platform: string;
  version: string;
  public_key: string;
  addr: string | null;
  port: number | null;
  last_seen: string | null;
  paired_at: string;
  permissions: string;
}

interface RpcRequest {
  id: string;
  ts: number;
  method: string;
  params?: any;
}

type OutboxItem =
  | { type: 'alert'; alert: AlertItem }
  | { type: 'message'; message: MeshMessage }
  | { type: 'job'; job: MeshJob }
  | { type: 'notify'; title: string; body: string }
  | { type: 'locate' };

export interface MeshHost {
  appVersion: string;
  deviceName: () => string;
  settings: () => { enabled: boolean; port: number; incoming: 'ask' | 'allow' | 'deny' };
  /** Long-term key pair, kept in the vault. */
  keyPair: () => KeyPair;
  mobileDir: string | null;
  status: () => Promise<unknown>;
  approvals: () => ApprovalRequest[];
  resolveApproval: (id: string, decision: 'approve' | 'deny', by: string) => boolean;
  requestApproval: (deviceName: string, prompt: string, deviceId: string) => Promise<boolean>;
  runAsk: (prompt: string, deviceName: string, onTool: (name: string) => void) => Promise<{ answer: string; status: string; error?: string }>;
  tasks: () => Task[];
  saveTask: (t: unknown) => Task;
  notes: () => Note[];
  saveNote: (n: unknown) => Note;
  alerts: () => AlertItem[];
  notify: (title: string, body: string) => void;
  system: (cmd: 'lock' | 'sleep') => Promise<string>;
  audit: (action: string, actor: string, outcome: 'success' | 'failure' | 'denied', details?: Record<string, unknown>) => void;
  /** Mesh Assist requests (assist.offer / start / status / cancel) from a paired computer. */
  assist?: (device: MeshDevice, method: string, params: any) => Promise<unknown>;
}

/**
 * The personal mesh: this computer, your other FBRX computers and your phone. Devices pair once with a one-time
 * code (or QR), then talk over sealed, signed, replay-protected requests. Each paired device has its own
 * permissions on this computer and can be removed on its own.
 */
export class MeshService {
  private server: Server | null = null;
  private mdns: ReturnType<typeof mdnsFactory> | null = null;
  private pairing: { code: string; expiresAt: number; failures: number } | null = null;
  private readonly replay = new ReplayGuard();
  private readonly outbox = new Map<string, OutboxItem[]>();
  private readonly jobs = new Map<string, MeshJob & { deviceId: string; at: number }>();
  private readonly nearby = new Map<string, { id: string; name: string; addr: string; at: number }>();
  private readonly pairAttempts = new Map<string, number[]>();
  private pingTimer: NodeJS.Timeout | null = null;
  private lastError: string | null = null;
  private online = new Map<string, boolean>();

  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
    private readonly log: Logger,
    private readonly host: MeshHost,
  ) {}

  get running(): boolean {
    return !!this.server?.listening;
  }

  private get self() {
    const kp = this.host.keyPair();
    return { id: fingerprint(kp.publicKey), ...kp };
  }

  // ---------------------------------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    if (this.server) return;
    const port = this.host.settings().port;
    const server = createServer((req, res) => void this.handle(req, res));
    server.requestTimeout = 30_000;
    server.headersTimeout = 15_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '0.0.0.0', () => {
        server.off('error', reject);
        resolve();
      });
    }).catch((err) => {
      this.lastError = errorMessage(err);
      throw new CoreError('UNAVAILABLE', `Mesh could not listen on port ${port}: ${this.lastError}`);
    });
    this.server = server;
    this.lastError = null;
    this.startMdns();
    this.pingTimer = setInterval(() => void this.pingPeers(), 60_000);
    this.pingTimer.unref?.();
    void this.pingPeers();
    this.changed();
  }

  async stop(): Promise<void> {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    try {
      this.mdns?.destroy();
    } catch {
      /* ignore */
    }
    this.mdns = null;
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
    this.pairing = null;
  }

  private changed() {
    try {
      this.events.emit('mesh.changed', this.status());
    } catch {
      /* vault locked */
    }
  }

  // ------------------------------------------------------------------------------------------ status

  addresses(): string[] {
    const out: string[] = [];
    for (const list of Object.values(networkInterfaces())) {
      for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
    }
    return out;
  }

  devices(): MeshDevice[] {
    return this.db.all<DeviceRow>('SELECT * FROM mesh_devices ORDER BY paired_at').map((r) => this.toDevice(r));
  }

  private toDevice(r: DeviceRow): MeshDevice {
    const perms = { ...(r.kind === 'mobile' ? MOBILE_PERMISSIONS : DESKTOP_PERMISSIONS), ...JSON.parse(r.permissions) };
    const online = r.kind === 'mobile' ? !!r.last_seen && Date.now() - Date.parse(r.last_seen) < MOBILE_ONLINE_MS : (this.online.get(r.id) ?? false);
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      platform: r.platform,
      version: r.version,
      addr: r.addr,
      port: r.port,
      online,
      lastSeen: r.last_seen,
      fingerprint: r.id,
      pairedAt: r.paired_at,
      permissions: perms,
    };
  }

  private row(id: string): DeviceRow {
    const r = this.db.get<DeviceRow>('SELECT * FROM mesh_devices WHERE id = ?', id);
    if (!r) throw new CoreError('NOT_FOUND', 'Device not found');
    return r;
  }

  status(): MeshStatus {
    const s = this.host.settings();
    const self = this.self;
    for (const [k, v] of this.nearby) if (Date.now() - v.at > 10 * 60_000) this.nearby.delete(k);
    const paired = new Set(this.devices().map((d) => d.id));
    return {
      enabled: s.enabled,
      running: this.running,
      port: s.port,
      self: { id: self.id, name: this.host.deviceName(), fingerprint: self.id, addresses: this.addresses() },
      devices: this.devices(),
      nearby: [...this.nearby.values()].filter((n) => !paired.has(n.id) && n.id !== self.id).map(({ id, name, addr }) => ({ id, name, addr })),
      pairing: this.pairing && this.pairing.expiresAt > Date.now() ? this.pairingInfo() : null,
      error: this.lastError,
    };
  }

  private pairingCache: { code: string; info: MeshPairing } | null = null;

  private pairingInfo(): MeshPairing {
    const p = this.pairing!;
    if (this.pairingCache?.code === p.code) return this.pairingCache.info;
    return { code: groupCode(p.code), expiresAt: new Date(p.expiresAt).toISOString(), url: this.pairUrl(p.code), qrDataUrl: '' };
  }

  private pairUrl(code: string): string {
    const addr = this.addresses()[0] ?? '127.0.0.1';
    const self = this.self;
    return `http://${addr}:${this.host.settings().port}/m/#pair=${code}&fp=${self.id}`;
  }

  // ----------------------------------------------------------------------------------------- pairing

  async startPairing(): Promise<MeshPairing> {
    if (!this.running) throw new CoreError('UNAVAILABLE', 'Turn the mesh on first');
    const code = newPairingCode();
    this.pairing = { code, expiresAt: Date.now() + PAIRING_TTL_MS, failures: 0 };
    const url = this.pairUrl(code);
    const info: MeshPairing = { code: groupCode(code), expiresAt: new Date(this.pairing.expiresAt).toISOString(), url, qrDataUrl: await QRCode.toDataURL(url, { margin: 1, width: 280 }) };
    this.pairingCache = { code, info };
    this.changed();
    return info;
  }

  cancelPairing(): MeshStatus {
    this.pairing = null;
    this.pairingCache = null;
    this.changed();
    return this.status();
  }

  /** Server side of pairing: verifies the requester knows the current code and registers its key. */
  private acceptPairing(body: any, remoteAddr: string): unknown {
    const p = this.pairing;
    if (!p || p.expiresAt < Date.now()) throw new CoreError('FORBIDDEN', 'No pairing in progress on this computer');
    const publicKey = String(body?.publicKey ?? '');
    const kind = body?.kind === 'desktop' ? 'desktop' : 'mobile';
    if (Buffer.from(publicKey, 'base64').length !== 32) throw new CoreError('INVALID_ARGUMENT', 'Invalid key');
    const self = this.self;
    if (!macEquals(String(body?.mac ?? ''), pairingMac(p.code, 'fbrx-pair-v1', publicKey, self.publicKey))) {
      p.failures++;
      if (p.failures >= MAX_PAIR_FAILURES) {
        this.pairing = null;
        this.host.audit('pairing.locked', 'mesh', 'denied', { from: remoteAddr });
        this.host.notify('Pairing stopped', 'Too many wrong pairing codes were tried. Start pairing again if this was you.');
      }
      this.host.audit('pairing.rejected', 'mesh', 'denied', { from: remoteAddr });
      this.changed();
      throw new CoreError('UNAUTHENTICATED', 'Wrong or expired pairing code');
    }
    const id = fingerprint(publicKey);
    if (id === self.id) throw new CoreError('INVALID_ARGUMENT', 'A computer cannot pair with itself');
    const name = String(body?.name ?? '').trim().slice(0, 80) || (kind === 'mobile' ? 'Phone' : 'Computer');
    const port = kind === 'desktop' && Number.isInteger(body?.port) ? Number(body.port) : null;
    const perms = kind === 'mobile' ? MOBILE_PERMISSIONS : DESKTOP_PERMISSIONS;
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO mesh_devices (id, name, kind, platform, version, public_key, addr, port, last_seen, paired_at, permissions) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, platform = excluded.platform, version = excluded.version, addr = excluded.addr, port = excluded.port, last_seen = excluded.last_seen`,
      id,
      name,
      kind,
      String(body?.platform ?? '').slice(0, 40),
      String(body?.version ?? '').slice(0, 40),
      publicKey,
      remoteAddr,
      port,
      now,
      now,
      JSON.stringify(perms),
    );
    this.pairing = null;
    this.pairingCache = null;
    this.online.set(id, true);
    this.host.audit('device.paired', 'user', 'success', { device: name, kind, id });
    this.host.notify('Device paired', `${name} is now part of your mesh.`);
    this.changed();
    return {
      deviceId: id,
      name: this.host.deviceName(),
      publicKey: self.publicKey,
      id: self.id,
      platform: osPlatform(),
      version: this.host.appVersion,
      permissions: perms,
      mac: pairingMac(p.code, 'fbrx-pair-v1-ack', self.publicKey, publicKey, id),
    };
  }

  /** Client side of pairing: this computer joins another computer that is showing a code. */
  async pairWith(codeRaw: string, hostRaw: string): Promise<MeshDevice> {
    const code = normalizeCode(codeRaw);
    if (code.length !== 20) throw new CoreError('INVALID_ARGUMENT', 'Enter the 20-character code shown on the other computer');
    const target = parseHost(hostRaw, this.host.settings().port);
    const base = `http://${target.host}:${target.port}`;
    const hello: any = await fetchJson(`${base}/mesh/hello`);
    const theirKey = String(hello.publicKey ?? '');
    if (fingerprint(theirKey) !== hello.id) throw new CoreError('INTERNAL', 'The other computer sent an inconsistent identity');
    const self = this.self;
    const res: any = await fetchJson(`${base}/mesh/pair`, {
      publicKey: self.publicKey,
      kind: 'desktop',
      name: this.host.deviceName(),
      platform: osPlatform(),
      version: this.host.appVersion,
      port: this.host.settings().port,
      mac: pairingMac(code, 'fbrx-pair-v1', self.publicKey, theirKey),
    });
    if (!macEquals(res.mac, pairingMac(code, 'fbrx-pair-v1-ack', theirKey, self.publicKey, self.id))) {
      throw new CoreError('UNAUTHENTICATED', 'The other computer could not prove it knows the code; pairing aborted');
    }
    const id = fingerprint(theirKey);
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO mesh_devices (id, name, kind, platform, version, public_key, addr, port, last_seen, paired_at, permissions) VALUES (?, ?, 'desktop', ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, addr = excluded.addr, port = excluded.port, last_seen = excluded.last_seen`,
      id,
      String(res.name ?? 'Computer').slice(0, 80),
      String(res.platform ?? ''),
      String(res.version ?? ''),
      theirKey,
      target.host,
      target.port,
      now,
      now,
      JSON.stringify(DESKTOP_PERMISSIONS),
    );
    this.online.set(id, true);
    this.host.audit('device.paired', 'user', 'success', { device: res.name, kind: 'desktop', id });
    this.changed();
    return this.toDevice(this.row(id));
  }

  removeDevice(id: string): MeshStatus {
    const r = this.row(id);
    this.db.run('DELETE FROM mesh_devices WHERE id = ?', id);
    this.outbox.delete(id);
    this.host.audit('device.removed', 'user', 'success', { device: r.name, id });
    this.changed();
    return this.status();
  }

  setPermissions(id: string, patch: Partial<MeshPermissions>): MeshDevice {
    const d = this.toDevice(this.row(id));
    const next = { ...d.permissions };
    for (const k of PERMISSION_KEYS) if (typeof patch[k] === 'boolean') next[k] = patch[k]!;
    this.db.run('UPDATE mesh_devices SET permissions = ? WHERE id = ?', JSON.stringify(next), id);
    this.host.audit('device.permissions', 'user', 'success', { device: d.name, permissions: next });
    this.changed();
    return this.toDevice(this.row(id));
  }

  // ---------------------------------------------------------------------------------------- outbound

  /** A sealed request to a paired computer, answered with its sealed reply. */
  async call<T = any>(id: string, method: string, params?: unknown, timeoutMs = 15_000): Promise<T> {
    const r = this.row(id);
    if (r.kind !== 'desktop' || !r.addr || !r.port) throw new CoreError('UNAVAILABLE', `${r.name} cannot be reached directly`);
    const self = this.self;
    const req: RpcRequest = { id: newId('rq'), ts: Date.now(), method, params };
    const env = seal(req, r.public_key, self.secretKey, self.id);
    let res: Response;
    try {
      res = await fetch(`http://${r.addr.includes(':') ? `[${r.addr}]` : r.addr}:${r.port}/mesh/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(env),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      this.setOnline(id, false);
      throw new CoreError('UNAVAILABLE', `${r.name} is not reachable (${(err as any).cause?.code ?? errorMessage(err)})`);
    }
    const body: any = await res.json().catch(() => ({}));
    if (!body.nonce) {
      const code = ['UNAUTHENTICATED', 'FORBIDDEN', 'NOT_FOUND', 'INVALID_ARGUMENT'].includes(body.error?.code) ? body.error.code : 'UNAVAILABLE';
      throw new CoreError(code, `${r.name}: ${body.error?.message ?? `refused the request (HTTP ${res.status})`}`);
    }
    const reply = open<{ re: string; ok: boolean; result?: T; error?: { code: string; message: string } }>(body, r.public_key, self.secretKey);
    if (!reply || reply.re !== req.id) throw new CoreError('UNAUTHENTICATED', `Reply from ${r.name} could not be verified`);
    this.setOnline(id, true);
    this.db.run('UPDATE mesh_devices SET last_seen = ? WHERE id = ?', new Date().toISOString(), id);
    if (!reply.ok) throw new CoreError((reply.error?.code as any) ?? 'INTERNAL', reply.error?.message ?? 'Request failed');
    return reply.result as T;
  }

  private setOnline(id: string, on: boolean) {
    if (this.online.get(id) !== on) {
      this.online.set(id, on);
      this.changed();
    }
  }

  private async pingPeers() {
    for (const d of this.devices()) {
      if (d.kind !== 'desktop') continue;
      await this.call(d.id, 'hello', undefined, 5000).catch(() => undefined);
    }
  }

  async peerInfo(id: string): Promise<unknown> {
    const d = this.toDevice(this.row(id));
    if (d.kind === 'mobile') return { online: d.online, lastSeen: d.lastSeen };
    return this.call(id, 'status');
  }

  /** Asks a paired computer's agent to do something; progress arrives as `mesh.job` events. */
  async ask(id: string, prompt: string, reqId: string): Promise<MeshJob> {
    if (!prompt.trim()) throw new CoreError('INVALID_ARGUMENT', 'Type a request');
    const job = await this.call<MeshJob>(id, 'ask', { prompt: prompt.slice(0, 8000) });
    this.events.emit('mesh.job', { reqId, job });
    void (async () => {
      let cur = job;
      const until = Date.now() + 15 * 60_000;
      while ((cur.status === 'running' || cur.status === 'waiting-approval') && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          cur = await this.call<MeshJob>(id, 'job', { jobId: job.jobId });
          this.events.emit('mesh.job', { reqId, job: cur });
        } catch {
          /* keep polling until the deadline */
        }
      }
    })();
    return job;
  }

  /** Sends a chat message to every paired device allowed to chat. */
  async message(text: string): Promise<{ delivered: number; total: number }> {
    const t = text.trim().slice(0, 4000);
    if (!t) throw new CoreError('INVALID_ARGUMENT', 'Type a message');
    const self = this.self;
    const msg = this.storeMessage({ id: newId('mmsg'), fromId: self.id, fromName: this.host.deviceName(), text: t, at: new Date().toISOString() });
    const targets = this.devices().filter((d) => d.permissions.chat);
    let delivered = 0;
    await Promise.all(
      targets.map(async (d) => {
        if (d.kind === 'mobile') {
          this.queue(d.id, { type: 'message', message: msg });
          delivered++;
        } else if (await this.call(d.id, 'chat.send', { id: msg.id, text: t }).then(() => true, () => false)) delivered++;
      }),
    );
    return { delivered, total: targets.length };
  }

  messages(): MeshMessage[] {
    return this.db
      .all<any>('SELECT * FROM mesh_messages ORDER BY at DESC LIMIT 200')
      .reverse()
      .map((r) => ({ id: r.id, fromId: r.from_id, fromName: r.from_name, text: r.text, at: r.at }));
  }

  private storeMessage(m: MeshMessage): MeshMessage {
    this.db.run('INSERT OR IGNORE INTO mesh_messages (id, from_id, from_name, text, at) VALUES (?, ?, ?, ?, ?)', m.id, m.fromId, m.fromName, m.text, m.at);
    this.db.run('DELETE FROM mesh_messages WHERE id NOT IN (SELECT id FROM mesh_messages ORDER BY at DESC LIMIT 1000)');
    this.events.emit('mesh.message', m);
    return m;
  }

  async action(id: string, action: 'notify' | 'locate' | 'lock' | 'sleep', text?: string): Promise<void> {
    const d = this.toDevice(this.row(id));
    if (d.kind === 'mobile') {
      if (action === 'notify') this.queue(id, { type: 'notify', title: this.host.deviceName(), body: (text ?? '').slice(0, 500) || 'Hello from your computer' });
      else if (action === 'locate') this.queue(id, { type: 'locate' });
      else throw new CoreError('INVALID_ARGUMENT', 'Phones can only be notified or located');
      return;
    }
    await this.call(id, 'action', { action, text });
  }

  private queue(id: string, item: OutboxItem) {
    const q = this.outbox.get(id) ?? [];
    q.push(item);
    if (q.length > 200) q.splice(0, q.length - 200);
    this.outbox.set(id, q);
  }

  /** Delivers an alert to every paired phone allowed to see alerts. */
  pushAlert(alert: AlertItem): number {
    let n = 0;
    for (const d of this.devices()) {
      if (d.kind === 'mobile' && d.permissions.alerts) {
        this.queue(d.id, { type: 'alert', alert });
        n++;
      }
    }
    return n;
  }

  /** Online state of paired devices, for alert rules. */
  peers(): Array<{ id: string; name: string; online: boolean }> {
    return this.devices().map((d) => ({ id: d.id, name: d.name, online: d.online }));
  }

  // ----------------------------------------------------------------------------------------- inbound

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://mesh.local');
    const remote = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/m')) {
        res.writeHead(302, { Location: '/m/' }).end();
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/m/')) return this.serveMobile(url.pathname.slice(3), res);
      if (req.method === 'GET' && url.pathname === '/mesh/hello') {
        const self = this.self;
        return json(res, 200, { id: self.id, publicKey: self.publicKey, name: this.host.deviceName(), version: this.host.appVersion, platform: osPlatform(), pairing: !!this.pairing && this.pairing.expiresAt > Date.now() });
      }
      if (req.method === 'POST' && url.pathname === '/mesh/pair') {
        if (!this.allowPairAttempt(remote)) return json(res, 429, { error: { code: 'FORBIDDEN', message: 'Too many attempts; wait a minute' } });
        const body = await readJson(req);
        return json(res, 200, this.acceptPairing(body, remote));
      }
      if (req.method === 'POST' && url.pathname === '/mesh/rpc') {
        const env = (await readJson(req)) as Envelope;
        return json(res, 200, await this.rpc(env, remote));
      }
      json(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    } catch (err) {
      const e = err instanceof CoreError ? err : new CoreError('INTERNAL', 'Request failed');
      if (!(err instanceof CoreError)) this.log.warn('Mesh request failed', { error: errorMessage(err) });
      json(res, e.code === 'UNAUTHENTICATED' ? 401 : e.code === 'FORBIDDEN' ? 403 : e.code === 'NOT_FOUND' ? 404 : 400, { error: { code: e.code, message: e.message } });
    }
  }

  private allowPairAttempt(ip: string): boolean {
    const now = Date.now();
    const list = (this.pairAttempts.get(ip) ?? []).filter((t) => now - t < 60_000);
    list.push(now);
    this.pairAttempts.set(ip, list);
    return list.length <= 10;
  }

  private serveMobile(rel: string, res: ServerResponse) {
    const dir = this.host.mobileDir;
    const file = normalize(rel || 'index.html').replace(/^([/\\])+/, '');
    if (!dir || file.includes('..') || !/^[\w.-]+$/.test(file)) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    let path = join(dir, file);
    if (!existsSync(path) && file === 'nacl.min.js') {
      try {
        // Development and headless runs serve the library straight from node_modules.
        path = createRequire(import.meta.url).resolve('tweetnacl/nacl-fast.min.js');
      } catch {
        /* packaged builds ship it in the mobile folder */
      }
    }
    if (!existsSync(path)) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
    const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
    res.writeHead(200, {
      'Content-Type': types[extname(path)] ?? 'application/octet-stream',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
      'X-Frame-Options': 'DENY',
    });
    res.end(readFileSync(path));
  }

  /** Opens a sealed request from a paired device, checks freshness and permissions, and seals the reply. */
  private async rpc(env: Envelope, remote: string): Promise<{ nonce: string; box: string }> {
    const id = String(env?.from ?? '');
    const r = this.db.get<DeviceRow>('SELECT * FROM mesh_devices WHERE id = ?', id);
    if (!r) throw new CoreError('UNAUTHENTICATED', 'This device is not paired with this computer');
    const self = this.self;
    const req = open<RpcRequest>(env, r.public_key, self.secretKey);
    if (!req || typeof req.method !== 'string' || typeof req.id !== 'string') throw new CoreError('UNAUTHENTICATED', 'Request could not be verified');
    if (!this.replay.check(`${id}:${req.id}`, Number(req.ts))) throw new CoreError('UNAUTHENTICATED', 'Stale or repeated request (check both clocks)');
    this.db.run('UPDATE mesh_devices SET last_seen = ?, addr = ? WHERE id = ?', new Date().toISOString(), remote || r.addr, id);
    if (r.kind === 'desktop') this.setOnline(id, true);
    const device = this.toDevice(this.db.get<DeviceRow>('SELECT * FROM mesh_devices WHERE id = ?', id)!);
    let reply: { re: string; ok: boolean; result?: unknown; error?: { code: string; message: string } };
    try {
      reply = { re: req.id, ok: true, result: await this.dispatch(device, req.method, req.params ?? {}) };
    } catch (err) {
      const e = err instanceof CoreError ? err : new CoreError('INTERNAL', errorMessage(err));
      reply = { re: req.id, ok: false, error: { code: e.code, message: e.message } };
      if (e.code === 'FORBIDDEN') this.host.audit('rpc.denied', `mesh:${device.name}`, 'denied', { method: req.method });
    }
    const out = seal(reply, r.public_key, self.secretKey, self.id);
    return { nonce: out.nonce, box: out.box };
  }

  private async dispatch(d: MeshDevice, method: string, p: any): Promise<unknown> {
    const need = (perm: keyof MeshPermissions) => {
      if (!d.permissions[perm]) throw new CoreError('FORBIDDEN', `${d.name} is not allowed to do this (${perm})`);
    };
    const actor = `mesh:${d.name}`;
    switch (method) {
      case 'hello':
        return { name: this.host.deviceName(), version: this.host.appVersion, platform: osPlatform(), permissions: d.permissions };
      case 'status':
        need('status');
        return this.host.status();
      case 'sync': {
        const items = this.outbox.get(d.id) ?? [];
        this.outbox.set(d.id, []);
        return {
          name: this.host.deviceName(),
          permissions: d.permissions,
          items: items.filter((i) => (i.type === 'alert' ? d.permissions.alerts : i.type === 'message' ? d.permissions.chat : true)),
          approvals: d.permissions.approve ? this.approvalsFor(d.id) : [],
          jobs: [...this.jobs.values()].filter((j) => j.deviceId === d.id).map(publicJob),
        };
      }
      case 'chat.send': {
        need('chat');
        const text = String(p.text ?? '').trim().slice(0, 4000);
        if (!text) throw new CoreError('INVALID_ARGUMENT', 'Empty message');
        this.storeMessage({ id: /^[\w-]{4,64}$/.test(p.id) ? p.id : newId('mmsg'), fromId: d.id, fromName: d.name, text, at: new Date().toISOString() });
        this.host.notify(`Message from ${d.name}`, text.slice(0, 200));
        return { ok: true };
      }
      case 'messages':
        need('chat');
        return this.messages().slice(-100);
      case 'ask':
        need('ask');
        return publicJob(this.startJob(d, String(p.prompt ?? '')));
      case 'job': {
        const j = this.jobs.get(String(p.jobId ?? ''));
        if (!j || j.deviceId !== d.id) throw new CoreError('NOT_FOUND', 'Job not found');
        return publicJob(j);
      }
      case 'approvals.list':
        need('approve');
        return this.approvalsFor(d.id);
      case 'approvals.resolve': {
        need('approve');
        const id = String(p.id ?? '');
        if (!this.approvalsFor(d.id).some((a) => a.id === id)) throw new CoreError('NOT_FOUND', 'Approval not found');
        const ok = this.host.resolveApproval(id, p.decision === 'approve' ? 'approve' : 'deny', actor);
        return { resolved: ok };
      }
      case 'tasks.list':
        need('workspace');
        return this.host.tasks();
      case 'tasks.save':
        need('workspace');
        return this.host.saveTask(p);
      case 'notes.list':
        need('workspace');
        return this.host.notes().slice(0, 200);
      case 'notes.save':
        need('workspace');
        return this.host.saveNote(p);
      case 'alerts.list':
        need('alerts');
        return this.host.alerts();
      case 'assist.offer':
      case 'assist.start':
      case 'assist.status':
      case 'assist.cancel':
        if (d.kind !== 'desktop' || !this.host.assist) throw new CoreError('NOT_FOUND', 'Mesh Assist is not available here');
        return this.host.assist(d, method, p);
      case 'action': {
        const a = String(p.action ?? '');
        if (a === 'notify') {
          need('chat');
          this.host.notify(`From ${d.name}`, String(p.text ?? '').slice(0, 500) || 'Hello');
          return { ok: true };
        }
        need('control');
        if (a === 'locate') {
          this.host.notify('Locate this computer', `${d.name} is looking for this computer.`);
          return { ok: true };
        }
        if (a === 'lock' || a === 'sleep') {
          this.host.audit(`action.${a}`, actor, 'success');
          return { message: await this.host.system(a) };
        }
        throw new CoreError('INVALID_ARGUMENT', 'Unknown action');
      }
      default:
        throw new CoreError('NOT_FOUND', `Unknown method ${method}`);
    }
  }

  /** Approvals a device may act on: never the approval for its own request to this computer. */
  private approvalsFor(deviceId: string): ApprovalRequest[] {
    return this.host.approvals().filter((a) => !((a.tool === 'mesh.ask' || a.tool === 'mesh.assist') && (a.input as { deviceId?: string })?.deviceId === deviceId));
  }

  private startJob(d: MeshDevice, promptRaw: string): MeshJob {
    const prompt = promptRaw.trim().slice(0, 8000);
    if (!prompt) throw new CoreError('INVALID_ARGUMENT', 'Empty request');
    const mode = this.host.settings().incoming;
    if (mode === 'deny') throw new CoreError('FORBIDDEN', 'This computer does not accept requests from other devices');
    const job: MeshJob & { deviceId: string; at: number } = { jobId: newId('job'), status: mode === 'ask' && d.kind === 'desktop' ? 'waiting-approval' : 'running', text: '', error: null, tools: [], deviceId: d.id, at: Date.now() };
    this.jobs.set(job.jobId, job);
    for (const [k, j] of this.jobs) if (Date.now() - j.at > 3600_000) this.jobs.delete(k);
    this.host.audit('ask', `mesh:${d.name}`, 'success', { prompt: prompt.slice(0, 200) });
    void (async () => {
      try {
        if (job.status === 'waiting-approval') {
          const ok = await this.host.requestApproval(d.name, prompt, d.id);
          if (!ok) {
            job.status = 'denied';
            job.error = 'The person at this computer declined the request';
            return;
          }
          job.status = 'running';
        }
        const r = await this.host.runAsk(prompt, d.name, (tool) => job.tools.push(tool));
        job.text = r.answer;
        job.status = r.status === 'completed' ? 'done' : 'error';
        job.error = r.error ?? null;
      } catch (err) {
        job.status = 'error';
        job.error = errorMessage(err);
      } finally {
        if (d.kind === 'mobile') this.queue(d.id, { type: 'job', job: publicJob(job) });
      }
    })();
    return job;
  }

  // -------------------------------------------------------------------------------------------- mDNS

  private startMdns() {
    try {
      const m = mdnsFactory();
      this.mdns = m;
      const svc = '_fbrx._tcp.local';
      const self = this.self;
      const instance = `${self.id.slice(0, 12)}.${svc}`;
      const hostName = `fbrx-${self.id.slice(0, 12)}.local`;
      m.on('query', (q: any) => {
        if (!q.questions?.some((x: any) => x.name === svc)) return;
        const addrs = this.addresses();
        try {
          m.respond({
            answers: [{ name: svc, type: 'PTR', ttl: 120, data: instance }],
            additionals: [
              { name: instance, type: 'SRV', ttl: 120, data: { port: this.host.settings().port, target: hostName, priority: 0, weight: 0 } },
              { name: instance, type: 'TXT', ttl: 120, data: [`id=${self.id}`, `name=${this.host.deviceName().slice(0, 60)}`] },
              ...addrs.map((a) => ({ name: hostName, type: 'A' as const, ttl: 120, data: a })),
            ],
          } as any);
        } catch {
          /* ignore */
        }
      });
      m.on('response', (res: any, rinfo: any) => {
        const all = [...(res.answers ?? []), ...(res.additionals ?? [])];
        const txt = all.find((r: any) => r.type === 'TXT' && String(r.name).endsWith(svc));
        if (!txt) return;
        const kv = Object.fromEntries(
          [].concat(txt.data ?? []).map((b: any) => {
            const s = b.toString();
            const i = s.indexOf('=');
            return [s.slice(0, i), s.slice(i + 1)];
          }),
        ) as Record<string, string>;
        if (!kv.id || kv.id === this.self.id) return;
        this.nearby.set(kv.id, { id: kv.id, name: (kv.name || 'FBRX computer').slice(0, 80), addr: rinfo?.address ?? '', at: Date.now() });
      });
      m.on('error', () => undefined);
      const query = () => {
        try {
          m.query([{ name: svc, type: 'PTR' }]);
        } catch {
          /* ignore */
        }
      };
      query();
      const t = setInterval(query, 60_000);
      t.unref?.();
      m.once('destroyed' as any, () => clearInterval(t));
    } catch (err) {
      this.log.debug('mDNS unavailable', { error: errorMessage(err) });
    }
  }
}

function publicJob(j: MeshJob): MeshJob {
  return { jobId: j.jobId, status: j.status, text: j.text, error: j.error, tools: [...j.tools] };
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new CoreError('INVALID_ARGUMENT', 'Request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new CoreError('INVALID_ARGUMENT', 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function parseHost(raw: string, defaultPort: number): { host: string; port: number } {
  const s = raw.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const m = s.match(/^\[?([A-Za-z0-9.:-]+?)\]?(?::(\d{2,5}))?$/);
  if (!m) throw new CoreError('INVALID_ARGUMENT', 'Enter the other computer as name-or-address[:port]');
  const port = m[2] ? Number(m[2]) : defaultPort;
  if (port < 1 || port > 65535) throw new CoreError('INVALID_ARGUMENT', 'Invalid port');
  return { host: m[1], port };
}

async function fetchJson(url: string, body?: unknown): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new CoreError('UNAVAILABLE', `Could not reach the other computer (${(err as any).cause?.code ?? errorMessage(err)})`);
  }
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new CoreError(j.error?.code ?? 'UNAVAILABLE', j.error?.message ?? `HTTP ${res.status}`);
  return j;
}
