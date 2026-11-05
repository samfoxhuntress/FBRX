import net from 'node:net';
import { newId, type SavedServer, type ServerCheck, type ServerSuggestion } from '@fbrx/shared';
import { CoreError } from '../errors';
import type { MetaStore } from '../storage/meta';
import { formatFingerprint, peerCertificate, sameFingerprint } from '../util/pinned-tls';

const KEY = 'servers.saved';
const MAX_SERVERS = 100;
/** FBRX Server's web console. */
export const SERVER_CONSOLE_PORT = 9443;

export interface SavedServersDeps {
  meta: MetaStore;
  audit: (action: string, details: Record<string, unknown>) => void;
  /** Paired computers on FBRX Mesh that announce server roles. */
  meshServers: () => Array<{ name: string; host: string; roles: string[] }>;
}

type Stored = Omit<SavedServer, 'url'>;

const bracket = (host: string) => (host.includes(':') ? `[${host}]` : host);
const urlOf = (s: Pick<SavedServer, 'scheme' | 'host' | 'port'>) => `${s.scheme}://${bracket(s.host)}:${s.port}/`;

/** "fbrx-server", "192.168.1.20:9443", "https://[fd00::2]:9443/console": scheme, host and port. */
export function parseServerAddress(address: string, port?: number): { scheme: 'https' | 'http'; host: string; port: number } {
  const raw = address.trim();
  if (!raw) throw new CoreError('INVALID_ARGUMENT', 'Enter the server\'s address');
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw.includes(':') && !raw.includes('[') && raw.split(':').length > 2 ? `[${raw}]` : raw}`);
  } catch {
    throw new CoreError('INVALID_ARGUMENT', 'That is not an address FBRX can open');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new CoreError('INVALID_ARGUMENT', 'Only https:// and http:// addresses open here');
  if (u.username || u.password) throw new CoreError('INVALID_ARGUMENT', 'Leave the user name and password out of the address; the console asks for them');
  const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!/^[a-z0-9.:_-]{1,253}$/.test(host)) throw new CoreError('INVALID_ARGUMENT', 'Enter an IP address or host name');
  const scheme = u.protocol === 'http:' ? 'http' : 'https';
  const p = port ?? (u.port ? Number(u.port) : /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? (scheme === 'http' ? 80 : 443) : SERVER_CONSOLE_PORT);
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new CoreError('INVALID_ARGUMENT', 'Port must be 1-65535');
  return { scheme, host, port: p };
}

/** Electron reports "sha256/<base64>"; Node and FBRX Server "AB:CD:…". */
export function certificateFingerprint(fp: string): string {
  const m = /^sha256\/(.+)$/i.exec(fp.trim());
  return formatFingerprint(m ? Buffer.from(m[1], 'base64').toString('hex') : fp);
}

/**
 * Servers whose web consoles open inside FBRX: FBRX Server's (port 9443) or any other one. A certificate no authority
 * vouches for (FBRX Server makes its own) is trusted by its fingerprint, once the person has compared it with the
 * one the server shows; the built-in browser then accepts that exact certificate for that address and nothing else.
 */
export class SavedServers {
  constructor(private readonly d: SavedServersDeps) {}

  list(): SavedServer[] {
    return this.stored()
      .map((s) => ({ ...s, url: urlOf(s) }))
      .sort((a, b) => (b.lastOpenedAt ?? b.createdAt).localeCompare(a.lastOpenedAt ?? a.createdAt));
  }

  /** FBRX Servers on the mesh that are not saved yet. */
  suggestions(): ServerSuggestion[] {
    const saved = this.stored();
    return this.d
      .meshServers()
      .filter((m) => m.roles.length && !saved.some((s) => s.host === m.host.toLowerCase()))
      .map((m) => ({ name: m.name, host: m.host, port: SERVER_CONSOLE_PORT, roles: m.roles }));
  }

  get(id: string): SavedServer {
    const s = this.list().find((x) => x.id === id);
    if (!s) throw new CoreError('NOT_FOUND', 'That server is not saved any more');
    return s;
  }

  save(input: { id?: string; name?: string; address: string; port?: number; notes?: string }): SavedServer {
    const { scheme, host, port } = parseServerAddress(input.address, input.port);
    const all = this.stored();
    const same = (s: Stored) => s.scheme === scheme && s.host === host && s.port === port;
    const prev = input.id ? all.find((s) => s.id === input.id) : all.find(same);
    if (input.id && !prev) throw new CoreError('NOT_FOUND', 'That server is not saved any more');
    if (all.some((s) => same(s) && s.id !== prev?.id)) throw new CoreError('CONFLICT', 'That address is saved already');
    const moved = !!prev && (prev.scheme !== scheme || prev.host !== host || prev.port !== port);
    const next: Stored = {
      id: prev?.id ?? newId('srv'),
      name: (input.name?.trim() || prev?.name || host).slice(0, 120),
      scheme,
      host,
      port,
      // A certificate is trusted for one address: a new address is checked again.
      fingerprint: moved ? null : (prev?.fingerprint ?? null),
      notes: (input.notes ?? prev?.notes ?? '').slice(0, 2000),
      createdAt: prev?.createdAt ?? new Date().toISOString(),
      lastOpenedAt: prev?.lastOpenedAt ?? null,
    };
    if (!prev && all.length >= MAX_SERVERS) throw new CoreError('CONFLICT', `At most ${MAX_SERVERS} servers can be saved`);
    this.write([next, ...all.filter((s) => s.id !== next.id)]);
    if (!prev) this.d.audit('server.saved', { host, port, scheme });
    return this.get(next.id);
  }

  remove(id: string): void {
    const all = this.stored();
    const s = all.find((x) => x.id === id);
    if (!s) return;
    this.write(all.filter((x) => x.id !== id));
    this.d.audit('server.removed', { host: s.host, port: s.port });
  }

  async check(id: string): Promise<ServerCheck> {
    const s = this.get(id);
    if (s.scheme === 'http') {
      const err = await tcpReach(s.host, s.port);
      return { url: s.url, reachable: !err, certificate: null, ok: !err, changed: false, error: err };
    }
    try {
      const c = await peerCertificate(s.url, 8000);
      const pinned = sameFingerprint(s.fingerprint, c.fingerprint);
      return {
        url: s.url,
        reachable: true,
        certificate: { fingerprint: c.fingerprint, subject: c.subject, issuer: c.issuer, validTo: c.validTo, trustedBySystem: c.trusted },
        ok: c.trusted || pinned,
        changed: !!s.fingerprint && !pinned && !c.trusted,
        error: null,
      };
    } catch (e) {
      return { url: s.url, reachable: false, certificate: null, ok: false, changed: false, error: reachError(e, s) };
    }
  }

  trust(id: string, fingerprint: string): SavedServer {
    const fp = certificateFingerprint(fingerprint);
    if (fp.length !== 95) throw new CoreError('INVALID_ARGUMENT', 'That is not a SHA-256 fingerprint');
    const all = this.stored();
    const s = all.find((x) => x.id === id);
    if (!s) throw new CoreError('NOT_FOUND', 'That server is not saved any more');
    if (s.scheme !== 'https') throw new CoreError('INVALID_ARGUMENT', 'Only https:// servers have a certificate');
    this.write(all.map((x) => (x.id === id ? { ...x, fingerprint: fp } : x)));
    this.d.audit('server.trusted', { host: s.host, port: s.port, fingerprint: fp, replaced: s.fingerprint });
    return this.get(id);
  }

  opened(id: string): void {
    const all = this.stored();
    if (!all.some((x) => x.id === id)) throw new CoreError('NOT_FOUND', 'That server is not saved any more');
    this.write(all.map((x) => (x.id === id ? { ...x, lastOpenedAt: new Date().toISOString() } : x)));
  }

  /**
   * For the built-in browser: whether a page's certificate (that no authority vouches for) is the one trusted for that
   * exact address. Anything else is refused.
   */
  trustsCertificate(url: string, fingerprint: string): boolean {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'wss:') return false;
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const port = Number(u.port || 443);
    const s = this.stored().find((x) => x.scheme === 'https' && x.host === host && x.port === port);
    return !!s && sameFingerprint(s.fingerprint, certificateFingerprint(fingerprint));
  }

  private stored(): Stored[] {
    return this.d.meta.get<Stored[]>(KEY) ?? [];
  }

  private write(list: Stored[]): void {
    this.d.meta.set(KEY, list.slice(0, MAX_SERVERS));
  }
}

function reachError(e: unknown, s: Pick<SavedServer, 'host' | 'port'>): string {
  const code = (e as { code?: string }).code ?? '';
  if (code === 'ECONNREFUSED') return `${s.host} answers, but nothing listens on port ${s.port}. Is the console running there?`;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `${s.host} could not be found. Check the name, or use its IP address.`;
  if (code === 'TIMEOUT' || code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return `No answer from ${s.host}:${s.port}. Is it on, and on this network?`;
  return (e as Error).message || `Could not reach ${s.host}:${s.port}`;
}

function tcpReach(host: string, port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: 8000 });
    sock.once('connect', () => {
      sock.destroy();
      resolve(null);
    });
    sock.once('timeout', () => {
      sock.destroy();
      resolve(reachError({ code: 'TIMEOUT' }, { host, port }));
    });
    sock.once('error', (e) => resolve(reachError(e, { host, port })));
  });
}
