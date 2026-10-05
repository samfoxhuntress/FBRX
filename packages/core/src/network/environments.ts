import { request as httpsRequest, Agent } from 'node:https';
import { connect as tlsConnect, type ConnectionOptions, type PeerCertificate, type TLSSocket } from 'node:tls';
import {
  NETENV_KINDS,
  newId,
  type NetDeviceState,
  type NetEnvClient,
  type NetEnvDevice,
  type NetEnvDeviceAction,
  type NetEnvDeviceStats,
  type NetEnvInput,
  type NetEnvironment,
  type NetEnvOverview,
  type NetEnvProbe,
  type NetEnvSite,
  type NetEnvVoucher,
} from '@fbrx/shared';
import { CoreError } from '../errors';
import type { EventBus } from '../events';
import type { Logger } from '../logger';
import type { MetaStore } from '../storage/meta';
import type { Vault } from '../vault/vault';

/**
 * Network environments (Network Center → Environments, Endpoint Ultra): the UniFi console that runs a school's or
 * office's network, reached through its local UniFi Network API with an API key (UniFi Network → Settings →
 * Control Plane → Integrations).
 *
 * - The key lives in the vault as an internal secret; the agent never sees it.
 * - UniFi consoles ship with a certificate no authority vouches for. The first connection shows its SHA-256
 *   fingerprint; once the person confirms it, every later connection must present exactly that certificate, checked
 *   before a single byte of the request (and its key) is sent.
 * - Reading is open to the agent's read tools; restarting a device or making guest codes goes through approvals.
 */

const STORE_KEY = 'netenv.list';
const SECRET = (id: string) => `fbrx.netenv.${id}`;
const MAX_BODY = 5_000_000;
const TIMEOUT_MS = 15_000;
/** UniFi OS consoles serve the API under /proxy/network; a standalone Network server serves it at the root. */
const BASES = ['/proxy/network/integration/v1', '/integration/v1'];
const UNTRUSTED_CERT = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_GET_ISSUER_CERT',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_UNTRUSTED',
]);

interface Stored {
  id: string;
  kind: NetEnvironment['kind'];
  name: string;
  url: string;
  fingerprint: string | null;
  trust: NetEnvironment['trust'];
  defaultSiteId: string | null;
  base: string | null;
  createdAt: string;
  lastOkAt: string | null;
  lastError: string | null;
}

interface Target {
  url: string;
  fingerprint: string | null;
  base: string | null;
}

export interface NetEnvDeps {
  meta: MetaStore;
  vault: Vault;
  events: EventBus;
  log: Logger;
  /** Why environments cannot be used right now (Endpoint Basic), or null. */
  unavailable: () => string | null;
}

export const normalizeFingerprint = (fp: string) => fp.replace(/[^0-9a-f]/gi, '').toUpperCase();
const formatFingerprint = (fp: string) => normalizeFingerprint(fp).match(/.{2}/g)?.join(':') ?? '';

/** https://host[:port] with nothing after it. Bare addresses get https://. */
export function consoleUrl(raw: string): string {
  const t = raw.trim();
  const u = new URL(/^[a-z]+:\/\//i.test(t) ? t : `https://${t}`);
  if (u.protocol !== 'https:') throw new CoreError('INVALID_ARGUMENT', 'Use the console’s https:// address');
  return `https://${u.host}`;
}

/** An agent that checks the server's certificate fingerprint before handing the connection to the request. */
function pinnedAgent(fingerprint: string): Agent {
  const want = normalizeFingerprint(fingerprint);
  const agent = new Agent({ keepAlive: false, maxCachedSessions: 0 });
  (agent as unknown as { createConnection: (o: ConnectionOptions, cb: (e: Error | null, s?: TLSSocket) => void) => undefined }).createConnection = (opts, cb) => {
    const sock = tlsConnect({ ...opts, rejectUnauthorized: false });
    let settled = false;
    sock.once('secureConnect', () => {
      settled = true;
      const got = normalizeFingerprint(sock.getPeerCertificate()?.fingerprint256 ?? '');
      if (got !== want) {
        sock.destroy();
        cb(new CoreError('FORBIDDEN', 'The console presented a different certificate than the one you trusted. If it was replaced on purpose, edit the environment and test again.'));
      } else cb(null, sock);
    });
    sock.once('error', (e) => {
      if (!settled) {
        settled = true;
        cb(e);
      }
    });
    return undefined;
  };
  return agent;
}

/** The certificate a host presents, whoever signed it. */
export function peerCertificate(url: string): Promise<{ fingerprint: string; subject: string; issuer: string; validTo: string }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const sock = tlsConnect({ host: u.hostname, port: Number(u.port || 443), servername: /^[\d.]+$|:/.test(u.hostname) ? undefined : u.hostname, rejectUnauthorized: false, timeout: TIMEOUT_MS });
    sock.once('secureConnect', () => {
      const c: PeerCertificate = sock.getPeerCertificate();
      sock.end();
      const name = (x: PeerCertificate['subject'] | undefined) => (x ? [x.CN, x.O].filter(Boolean).join(', ') : '');
      resolve({ fingerprint: formatFingerprint(c.fingerprint256 ?? ''), subject: name(c.subject) || 'unnamed', issuer: name(c.issuer) || 'unnamed', validTo: c.valid_to ?? '' });
    });
    sock.once('timeout', () => {
      sock.destroy();
      reject(new CoreError('TIMEOUT', `No answer from ${u.host}`));
    });
    sock.once('error', reject);
  });
}

interface Reply {
  status: number;
  body: any;
}

function call(t: Target, method: 'GET' | 'POST', path: string, key: string, payload?: unknown): Promise<Reply> {
  const url = new URL(`${t.url}${t.base ?? BASES[0]}${path}`);
  const data = payload === undefined ? undefined : Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      {
        method,
        agent: t.fingerprint ? pinnedAgent(t.fingerprint) : undefined,
        headers: { 'X-API-KEY': key, accept: 'application/json', ...(data ? { 'content-type': 'application/json', 'content-length': String(data.length) } : {}) },
        timeout: TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_BODY) req.destroy(new CoreError('INTERNAL', 'The console sent too much data'));
          else chunks.push(c);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: unknown = text;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            /* not JSON */
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on('timeout', () => req.destroy(new CoreError('TIMEOUT', `No answer from ${url.host}`)));
    req.on('error', reject);
    req.end(data);
  });
}

const errorText = (r: Reply) => (r.body && typeof r.body === 'object' && typeof r.body.message === 'string' ? r.body.message : `HTTP ${r.status}`);

function explain(r: Reply): CoreError {
  if (r.status === 401 || r.status === 403) return new CoreError('UNAUTHENTICATED', 'The console did not accept the API key. Make a new one in UniFi Network → Settings → Control Plane → Integrations.');
  if (r.status === 404) return new CoreError('NOT_FOUND', `Not found on the console (${errorText(r)})`);
  if (r.status === 429) return new CoreError('UNAVAILABLE', 'The console asked us to slow down; try again in a minute');
  return new CoreError('UNAVAILABLE', `The console answered: ${errorText(r)}`);
}

/** Every page of a list endpoint ({ offset, limit, totalCount, data }). */
async function all(t: Target, path: string, key: string, cap = 2000): Promise<any[]> {
  const out: any[] = [];
  for (let offset = 0; out.length < cap; ) {
    const r = await call(t, 'GET', `${path}${path.includes('?') ? '&' : '?'}offset=${offset}&limit=200`, key);
    if (r.status !== 200) throw explain(r);
    const page: any[] = Array.isArray(r.body?.data) ? r.body.data : Array.isArray(r.body) ? r.body : [];
    out.push(...page);
    const total = Number(r.body?.totalCount ?? out.length);
    if (!page.length || out.length >= total) break;
    offset += page.length;
  }
  return out.slice(0, cap);
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function deviceState(raw: unknown): NetDeviceState {
  const s = String(raw ?? '').toUpperCase();
  if (s === 'ONLINE') return 'online';
  if (s === 'OFFLINE' || s === 'CONNECTION_INTERRUPTED' || s === 'ISOLATED') return 'offline';
  if (s === 'UPDATING' || s === 'GETTING_READY' || s === 'ADOPTING' || s === 'PROVISIONING') return 'updating';
  if (s === 'PENDING_ADOPTION') return 'pending';
  return 'other';
}

const ROLE_NAMES: Record<string, string> = { switching: 'switch', accessPoint: 'access point', gateway: 'gateway', routing: 'gateway', camera: 'camera' };

export function mapDevice(d: any): NetEnvDevice {
  const features: string[] = Array.isArray(d.features) ? d.features.map(String) : [];
  // Gateways (Dream Machines, Cloud Gateways, Security Gateways) also switch; name them by what matters most.
  const gateway = /^(UDM|UCG|UXG|USG|UDR|UDW|UX\b|EFG)/i.test(String(d.model ?? '')) || features.includes('gateway');
  const roles = [...new Set([...(gateway ? ['gateway'] : []), ...features.map((f) => ROLE_NAMES[f] ?? f)])];
  return {
    id: String(d.id),
    name: str(d.name) ?? str(d.macAddress) ?? 'Unnamed device',
    model: str(d.model) ?? '',
    mac: str(d.macAddress) ?? '',
    ip: str(d.ipAddress),
    state: deviceState(d.state),
    roles,
    firmware: str(d.firmwareVersion),
    firmwareUpdatable: d.firmwareUpdatable === true,
  };
}

export function mapClient(c: any): NetEnvClient {
  const type = String(c.type ?? '').toUpperCase();
  return {
    id: String(c.id),
    name: str(c.name) ?? str(c.hostname) ?? str(c.macAddress) ?? 'Unknown',
    type: type === 'WIRED' ? 'wired' : type === 'WIRELESS' ? 'wireless' : type === 'VPN' || type === 'TELEPORT' ? 'vpn' : 'other',
    ip: str(c.ipAddress),
    mac: str(c.macAddress),
    connectedAt: str(c.connectedAt),
    uplinkDeviceId: str(c.uplinkDeviceId),
  };
}

function mapVoucher(v: any): NetEnvVoucher {
  return {
    id: String(v.id),
    code: String(v.code ?? ''),
    name: str(v.name) ?? '',
    timeLimitMinutes: num(v.timeLimitMinutes),
    guestLimit: num(v.authorizedGuestLimit),
    expired: v.expired === true,
    createdAt: str(v.createdAt),
  };
}

export class NetEnvironments {
  constructor(private readonly d: NetEnvDeps) {}

  private load(): Stored[] {
    return this.d.meta.get<Stored[]>(STORE_KEY) ?? [];
  }

  private store(list: Stored[]) {
    this.d.meta.set(STORE_KEY, list);
    this.d.events.emit('netenv.changed', this.list());
  }

  private view(s: Stored): NetEnvironment {
    const { base: _b, ...rest } = s;
    let hasKey = false;
    try {
      hasKey = this.d.vault.isUnlocked && this.d.vault.has(SECRET(s.id));
    } catch {
      hasKey = false;
    }
    return { ...rest, hasKey };
  }

  private gate() {
    const why = this.d.unavailable();
    if (why) throw new CoreError('FEATURE_UNAVAILABLE', why);
  }

  private key(id: string): string {
    if (!this.d.vault.isUnlocked) throw new CoreError('LOCKED', 'Unlock the vault (Credentials) to use the network environment; its API key is kept there');
    const k = this.d.vault.get(SECRET(id), { allowInternal: true });
    if (!k) throw new CoreError('NOT_FOUND', 'No API key is saved for this environment; edit it and paste one');
    return k;
  }

  private get(id: string): Stored {
    const s = this.load().find((x) => x.id === id);
    if (!s) throw new CoreError('NOT_FOUND', 'Unknown network environment');
    return s;
  }

  private note(id: string, ok: boolean, error?: string) {
    const list = this.load();
    const s = list.find((x) => x.id === id);
    if (!s) return;
    if (ok) {
      s.lastOkAt = new Date().toISOString();
      s.lastError = null;
    } else s.lastError = error ?? 'Failed';
    this.store(list);
  }

  list(): NetEnvironment[] {
    return this.load().map((s) => this.view(s));
  }

  /**
   * Tries an address and key without saving anything. When the console's certificate is not vouched for by an
   * authority (the usual case), returns it so the person can compare the fingerprint and trust it.
   */
  async probe(p: { url: string; apiKey?: string; id?: string; fingerprint?: string | null }): Promise<NetEnvProbe> {
    this.gate();
    const url = consoleUrl(p.url);
    const saved = p.id ? this.get(p.id) : null;
    const key = p.apiKey?.trim() || (saved ? this.key(saved.id) : '');
    if (!key) throw new CoreError('INVALID_ARGUMENT', 'Paste the API key from UniFi Network');
    let fingerprint = p.fingerprint ?? (saved && saved.url === url ? saved.fingerprint : null);
    let certificate: NetEnvProbe['certificate'] = null;
    if (!fingerprint) {
      try {
        const r = await call({ url, fingerprint: null, base: BASES[0] }, 'GET', '/info', key);
        void r;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code ?? '';
        if (!UNTRUSTED_CERT.has(code)) return { ok: false, certificate: null, version: null, sites: [], message: this.reachError(e, url) };
        certificate = await peerCertificate(url);
        if (!p.fingerprint) return { ok: false, certificate, version: null, sites: [], message: 'Check the certificate fingerprint, then trust it to continue.' };
        fingerprint = certificate.fingerprint;
      }
    }
    try {
      const found = await this.discover({ url, fingerprint, base: null }, key);
      return { ok: true, certificate, version: found.version, sites: found.sites, message: null };
    } catch (e) {
      return { ok: false, certificate, version: null, sites: [], message: e instanceof CoreError ? e.message : this.reachError(e, url) };
    }
  }

  private reachError(e: unknown, url: string): string {
    const code = (e as NodeJS.ErrnoException).code ?? '';
    if (UNTRUSTED_CERT.has(code)) return "The console's certificate is not trusted on this computer. Edit the environment and test the connection to check and trust it.";
    if (code === 'ECONNREFUSED') return `${new URL(url).host} refused the connection. Is that the console's address?`;
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `Could not find ${new URL(url).hostname} on the network`;
    if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return `${new URL(url).host} is not reachable from this computer`;
    return e instanceof Error ? e.message : String(e);
  }

  /** Finds the API base path, the Network version and the sites. */
  private async discover(t: Target, key: string): Promise<{ base: string; version: string | null; sites: NetEnvSite[] }> {
    let last: Reply | null = null;
    for (const base of t.base ? [t.base] : BASES) {
      const r = await call({ ...t, base }, 'GET', '/info', key);
      if (r.status === 200) {
        const sites = (await all({ ...t, base }, '/sites', key)).map((s) => ({ id: String(s.id), name: str(s.name) ?? str(s.internalReference) ?? 'Site' }));
        return { base, version: str(r.body?.applicationVersion), sites };
      }
      last = r;
      if (r.status !== 404) break;
    }
    if (last?.status === 404) throw new CoreError('NOT_FOUND', 'This console does not offer the UniFi Network API. Update UniFi Network to version 9 or newer.');
    throw explain(last ?? { status: 0, body: null });
  }

  async save(input: NetEnvInput): Promise<NetEnvironment> {
    this.gate();
    if (!NETENV_KINDS.includes(input.kind)) throw new CoreError('INVALID_ARGUMENT', 'Unknown kind of network environment');
    const url = consoleUrl(input.url);
    const list = this.load();
    const existing = input.id ? list.find((x) => x.id === input.id) : undefined;
    if (input.id && !existing) throw new CoreError('NOT_FOUND', 'Unknown network environment');
    const id = existing?.id ?? newId('net');
    if (input.apiKey?.trim()) {
      if (!this.d.vault.isUnlocked) throw new CoreError('LOCKED', 'Unlock the vault (Credentials) first: the API key is kept there');
      this.d.vault.set({ name: SECRET(id), value: input.apiKey.trim(), kind: 'api-key', description: `UniFi API key for ${input.name}` }, { internal: true });
    } else if (!existing) throw new CoreError('INVALID_ARGUMENT', 'Paste the API key from UniFi Network');
    const fingerprint = input.fingerprint === undefined ? (existing && existing.url === url ? existing.fingerprint : null) : input.fingerprint ? formatFingerprint(input.fingerprint) : null;
    const record: Stored = {
      id,
      kind: input.kind,
      name: input.name.trim().slice(0, 80) || 'Network',
      url,
      fingerprint,
      trust: fingerprint ? 'pinned' : 'system',
      defaultSiteId: input.defaultSiteId === undefined ? (existing?.defaultSiteId ?? null) : input.defaultSiteId,
      base: existing && existing.url === url ? existing.base : null,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      lastOkAt: existing?.lastOkAt ?? null,
      lastError: null,
    };
    this.store(existing ? list.map((x) => (x.id === id ? record : x)) : [...list, record]);
    this.d.log.info('Network environment saved', { id, url, trust: record.trust });
    return this.view(record);
  }

  remove(id: string): { deleted: boolean } {
    const list = this.load();
    if (!list.some((x) => x.id === id)) return { deleted: false };
    try {
      if (this.d.vault.isUnlocked) this.d.vault.delete(SECRET(id), { internal: true });
    } catch {
      /* already gone */
    }
    this.store(list.filter((x) => x.id !== id));
    return { deleted: true };
  }

  /** The environment's API, with its base path discovered (and remembered) on first use. */
  private async session(id: string): Promise<{ s: Stored; t: Target; key: string }> {
    this.gate();
    const s = this.get(id);
    const key = this.key(id);
    let t: Target = { url: s.url, fingerprint: s.fingerprint, base: s.base };
    if (!t.base) {
      try {
        const found = await this.discover(t, key);
        t = { ...t, base: found.base };
        const list = this.load();
        const x = list.find((y) => y.id === id);
        if (x) {
          x.base = found.base;
          x.defaultSiteId ??= found.sites[0]?.id ?? null;
          this.store(list);
        }
        s.defaultSiteId ??= found.sites[0]?.id ?? null;
      } catch (e) {
        const err = e instanceof CoreError ? e : new CoreError('UNAVAILABLE', this.reachError(e, s.url));
        this.note(id, false, err.message);
        throw err;
      }
    }
    return { s, t, key };
  }

  private async guarded<T>(id: string, fn: () => Promise<T>): Promise<T> {
    try {
      const out = await fn();
      this.note(id, true);
      return out;
    } catch (e) {
      const err = e instanceof CoreError ? e : new CoreError('UNAVAILABLE', this.reachError(e, this.get(id).url));
      this.note(id, false, err.message);
      throw err;
    }
  }

  private siteOf(s: Stored, sites: NetEnvSite[], siteId?: string): NetEnvSite {
    const want = siteId ?? s.defaultSiteId;
    const site = sites.find((x) => x.id === want) ?? sites[0];
    if (!site) throw new CoreError('NOT_FOUND', 'The console has no sites this API key can see');
    return site;
  }

  async overview(id: string, siteId?: string): Promise<NetEnvOverview> {
    const { s, t, key } = await this.session(id);
    return this.guarded(id, async () => {
      const sites = (await all(t, '/sites', key)).map((x) => ({ id: String(x.id), name: str(x.name) ?? 'Site' }));
      const site = this.siteOf(s, sites, siteId);
      const [devices, clients] = await Promise.all([all(t, `/sites/${encodeURIComponent(site.id)}/devices`, key), all(t, `/sites/${encodeURIComponent(site.id)}/clients`, key, 5000)]);
      return { environment: this.view(this.get(id)), site, sites, devices: devices.map(mapDevice), clients: clients.map(mapClient), fetchedAt: new Date().toISOString() };
    });
  }

  async deviceStats(id: string, deviceId: string, siteId?: string): Promise<NetEnvDeviceStats & { device: NetEnvDevice | null }> {
    const { s, t, key } = await this.session(id);
    return this.guarded(id, async () => {
      const site = siteId ?? s.defaultSiteId;
      if (!site) throw new CoreError('NOT_FOUND', 'Pick a site first');
      const base = `/sites/${encodeURIComponent(site)}/devices/${encodeURIComponent(deviceId)}`;
      const [detail, stats] = await Promise.all([call(t, 'GET', base, key), call(t, 'GET', `${base}/statistics/latest`, key)]);
      if (stats.status !== 200) throw explain(stats);
      const b = stats.body ?? {};
      return {
        device: detail.status === 200 ? mapDevice(detail.body) : null,
        uptimeSec: num(b.uptimeSec),
        cpuPct: num(b.cpuUtilizationPct),
        memPct: num(b.memoryUtilizationPct),
        load1: num(b.loadAverage1Min),
        txBps: num(b.uplink?.txRateBps),
        rxBps: num(b.uplink?.rxRateBps),
        lastHeartbeatAt: str(b.lastHeartbeatAt),
      };
    });
  }

  async deviceAction(id: string, deviceId: string, action: NetEnvDeviceAction, siteId?: string): Promise<{ ok: true }> {
    const { s, t, key } = await this.session(id);
    return this.guarded(id, async () => {
      const site = siteId ?? s.defaultSiteId;
      if (!site) throw new CoreError('NOT_FOUND', 'Pick a site first');
      const r = await call(t, 'POST', `/sites/${encodeURIComponent(site)}/devices/${encodeURIComponent(deviceId)}/actions`, key, { action: action.toUpperCase() });
      if (r.status < 200 || r.status >= 300) throw explain(r);
      this.d.log.info('Network device action', { id, deviceId, action });
      return { ok: true as const };
    });
  }

  async vouchers(id: string, siteId?: string): Promise<NetEnvVoucher[]> {
    const { s, t, key } = await this.session(id);
    return this.guarded(id, async () => {
      const site = siteId ?? s.defaultSiteId;
      if (!site) throw new CoreError('NOT_FOUND', 'Pick a site first');
      return (await all(t, `/sites/${encodeURIComponent(site)}/hotspot/vouchers`, key, 500)).map(mapVoucher);
    });
  }

  /** Guest Wi-Fi codes for the site's hotspot (guest network with vouchers turned on in UniFi). */
  async createVouchers(id: string, p: { name: string; count?: number; timeLimitMinutes: number; guestLimit?: number; siteId?: string }): Promise<NetEnvVoucher[]> {
    const { s, t, key } = await this.session(id);
    return this.guarded(id, async () => {
      const site = p.siteId ?? s.defaultSiteId;
      if (!site) throw new CoreError('NOT_FOUND', 'Pick a site first');
      const r = await call(t, 'POST', `/sites/${encodeURIComponent(site)}/hotspot/vouchers`, key, {
        count: p.count ?? 1,
        name: p.name.slice(0, 60) || 'FBRX guest',
        timeLimitMinutes: p.timeLimitMinutes,
        ...(p.guestLimit ? { authorizedGuestLimit: p.guestLimit } : {}),
      });
      if (r.status < 200 || r.status >= 300) throw explain(r);
      const made: any[] = Array.isArray(r.body?.vouchers) ? r.body.vouchers : Array.isArray(r.body?.data) ? r.body.data : [];
      return made.map(mapVoucher);
    });
  }
}
