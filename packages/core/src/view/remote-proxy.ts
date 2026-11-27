import { connect as netConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect, type PeerCertificate, type TLSSocket } from 'node:tls';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { pipeline } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, createWebSocketStream, type WebSocket } from 'ws';
import { RDCLEANPATH_ERRORS, RDCLEANPATH_VERSION, decodeRDCleanPathRequest, encodeRDCleanPathError, encodeRDCleanPathResponse, rdcleanpathSize, type RDCleanPathError } from './rdcleanpath';

/**
 * FBRX View's way out to the computers it shows. A remote screen drawn in the window (IronRDP for RDP, noVNC for VNC)
 * cannot open a network connection itself, so it opens a WebSocket to this proxy, which listens on this computer only
 * (127.0.0.1, a port of the moment) and connects for it: RDP through RDCleanPath (the proxy does the TLS with the
 * computer and hands back its certificates), VNC as a plain stream. Nothing reaches the proxy without a ticket: one
 * random token for one connection to one computer, made by the app when the person opens it, used once and good for a
 * minute.
 */

export type ProxyKind = 'rdp' | 'vnc';

export interface ProxyTicket {
  token: string;
  kind: ProxyKind;
  host: string;
  port: number;
  expiresAt: number;
}

export interface ProxySessionEvent {
  kind: ProxyKind;
  host: string;
  port: number;
  event: 'open' | 'close' | 'refused';
  /** Why it was refused or ended, in words. */
  why?: string;
  bytesIn?: number;
  bytesOut?: number;
}

export interface RemoteProxyOptions {
  log?: (level: 'info' | 'warn', msg: string) => void;
  onSession?: (e: ProxySessionEvent) => void;
  connectTimeoutMs?: number;
  ticketTtlMs?: number;
  now?: () => number;
}

const MAX_LIVE = 32;
const FIRST_MESSAGE_MS = 15_000;
const FIRST_MESSAGE_MAX = 64 * 1024;

export const DEFAULT_PORTS: Record<ProxyKind, number> = { rdp: 3389, vnc: 5900 };

/** "host", "host:port", "[v6]" or "[v6]:port" as IronRDP sends its destination. */
export function parseDestination(d: string, fallbackPort: number): { host: string; port: number } | null {
  const s = d.trim();
  const v6 = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(s);
  if (v6) return { host: v6[1]!, port: v6[2] ? Number(v6[2]) : fallbackPort };
  if (isIP(s) === 6) return { host: s, port: fallbackPort };
  const m = /^([^:\s]+)(?::(\d{1,5}))?$/.exec(s);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : fallbackPort;
  return port > 0 && port < 65536 ? { host: m[1]!, port } : null;
}

const sameHost = (a: string, b: string) => a.replace(/\.$/, '').toLowerCase() === b.replace(/\.$/, '').toLowerCase();

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** A connect error as RDCleanPath says it (the Windows socket error numbers IronRDP shows). */
function connectError(err: NodeJS.ErrnoException): RDCleanPathError {
  switch (err.code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'EAI_NONAME':
      return { errorCode: RDCLEANPATH_ERRORS.dnsFailed };
    case 'ECONNREFUSED':
      return { errorCode: RDCLEANPATH_ERRORS.targetUnreachable, wsaLastError: 10061 };
    case 'ETIMEDOUT':
      return { errorCode: RDCLEANPATH_ERRORS.targetUnreachable, wsaLastError: 10060 };
    case 'EHOSTUNREACH':
      return { errorCode: RDCLEANPATH_ERRORS.targetUnreachable, wsaLastError: 10065 };
    case 'ENETUNREACH':
      return { errorCode: RDCLEANPATH_ERRORS.targetUnreachable, wsaLastError: 10051 };
    default:
      return { errorCode: RDCLEANPATH_ERRORS.targetUnreachable };
  }
}

/** The certificate chain as DER, the computer's own first. */
function chainOf(peer: PeerCertificate & { issuerCertificate?: PeerCertificate }): Buffer[] {
  const out: Buffer[] = [];
  const seen = new Set<string>();
  let c: (PeerCertificate & { issuerCertificate?: PeerCertificate }) | undefined = peer;
  while (c && c.raw && !seen.has(c.fingerprint256) && out.length < 10) {
    seen.add(c.fingerprint256);
    out.push(Buffer.from(c.raw));
    c = c.issuerCertificate as typeof c;
  }
  return out;
}

/** Reads one TPKT packet (the computer's X.224 reply) from a socket. */
function readTpkt(sock: Socket, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const done = (err: Error | null, v?: Buffer) => {
      clearTimeout(timer);
      sock.off('data', onData);
      sock.off('error', onError);
      sock.off('close', onClose);
      if (err) reject(err);
      else resolve(v!);
    };
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 4) {
        if (buf[0] !== 3) return done(new Error('The computer did not answer as an RDP server'));
        const len = buf.readUInt16BE(2);
        if (len < 7) return done(new Error('The computer sent a bad RDP reply'));
        if (buf.length >= len) {
          if (buf.length > len) sock.unshift(buf.subarray(len));
          sock.pause();
          return done(null, buf.subarray(0, len));
        }
      }
    };
    const onError = (e: Error) => done(e);
    const onClose = () => done(new Error('The computer closed the connection'));
    const timer = setTimeout(() => done(new Error('The computer did not answer the RDP connection request')), timeoutMs);
    sock.on('data', onData);
    sock.on('error', onError);
    sock.on('close', onClose);
  });
}

/**
 * What the computer chose in its X.224 reply: 'tls' (TLS or NLA follow), 'failed' (it refused what was offered), or
 * 'rdp' (old RDP security without TLS, which FBRX View does not use).
 */
export function x224Choice(tpkt: Buffer): 'tls' | 'failed' | 'rdp' {
  // TPKT (4) + X.224 Connection Confirm (LI, code, dst-ref, src-ref, class = 7), then RDP_NEG_RSP or RDP_NEG_FAILURE.
  const neg = 11;
  if (tpkt.length < neg + 8) return 'rdp';
  const type = tpkt[neg];
  if (type === 0x03) return 'failed';
  if (type !== 0x02) return 'rdp';
  return tpkt.readUInt32LE(neg + 4) === 0 ? 'rdp' : 'tls';
}

export class RemoteProxy {
  private wss: WebSocketServer | null = null;
  private port = 0;
  private readonly tickets = new Map<string, ProxyTicket>();
  private readonly live = new Set<() => void>();

  constructor(private readonly o: RemoteProxyOptions = {}) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  /** Starts listening on 127.0.0.1 (once); the port it got. */
  async start(): Promise<number> {
    if (this.wss) return this.port;
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, maxPayload: 16 * 1024 * 1024, perMessageDeflate: false, handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false) });
    this.wss = wss;
    await new Promise<void>((resolve, reject) => {
      wss.once('listening', resolve);
      wss.once('error', reject);
    });
    this.port = (wss.address() as { port: number }).port;
    wss.on('connection', (ws, req) => this.accept(ws, req));
    return this.port;
  }

  /** A ticket for one connection: the address the window connects to, and the token it gives. */
  async ticket(kind: ProxyKind, host: string, port?: number): Promise<{ token: string; url: string; destination: string }> {
    const p = await this.start();
    const now = this.now();
    for (const [k, t] of this.tickets) if (t.expiresAt <= now) this.tickets.delete(k);
    const token = randomBytes(24).toString('base64url');
    const realPort = port ?? DEFAULT_PORTS[kind];
    this.tickets.set(token, { token, kind, host, port: realPort, expiresAt: now + (this.o.ticketTtlMs ?? 60_000) });
    const destination = isIP(host) === 6 ? `[${host}]:${realPort}` : `${host}:${realPort}`;
    return { token, url: kind === 'rdp' ? `ws://127.0.0.1:${p}/rdp` : `ws://127.0.0.1:${p}/vnc?t=${token}`, destination };
  }

  /** Takes a ticket (once): null when there is no such ticket, or it is used, old or for something else. */
  private take(token: string, kind: ProxyKind): ProxyTicket | null {
    for (const [k, t] of this.tickets) {
      if (sameToken(k, token)) {
        this.tickets.delete(k);
        return t.kind === kind && t.expiresAt > this.now() ? t : null;
      }
    }
    return null;
  }

  async close(): Promise<void> {
    for (const stop of [...this.live]) stop();
    this.tickets.clear();
    const wss = this.wss;
    this.wss = null;
    if (wss) await new Promise<void>((r) => wss.close(() => r()));
  }

  private event(e: ProxySessionEvent) {
    try {
      this.o.onSession?.(e);
    } catch {
      /* the audit's trouble is not the connection's */
    }
  }

  private accept(ws: WebSocket, req: IncomingMessage) {
    const remote = req.socket.remoteAddress ?? '';
    if (!/^(127\.|::1$|::ffff:127\.)/.test(remote) || this.live.size >= MAX_LIVE) {
      ws.close(1008, 'Not allowed');
      return;
    }
    const url = new URL(req.url ?? '/', 'ws://127.0.0.1');
    if (url.pathname === '/rdp') this.rdp(ws);
    else if (url.pathname === '/vnc') this.vnc(ws, url.searchParams.get('t') ?? '');
    else ws.close(1008, 'Not allowed');
  }

  /** Carries a connection both ways until either side ends it. */
  private carry(ws: WebSocket, sock: Socket | TLSSocket, t: ProxyTicket, first?: Buffer) {
    const stream = createWebSocketStream(ws);
    let bytesIn = 0;
    let bytesOut = 0;
    sock.on('data', (d: Buffer) => (bytesIn += d.length));
    stream.on('data', (d: Buffer) => (bytesOut += d.length));
    let ended = false;
    const stop = () => {
      if (ended) return;
      ended = true;
      this.live.delete(stop);
      sock.destroy();
      stream.destroy();
      this.event({ kind: t.kind, host: t.host, port: t.port, event: 'close', bytesIn, bytesOut });
    };
    this.live.add(stop);
    if (first?.length) sock.write(first);
    pipeline(stream, sock, () => stop());
    pipeline(sock, stream, () => stop());
    sock.resume();
    this.event({ kind: t.kind, host: t.host, port: t.port, event: 'open' });
  }

  private refuse(ws: WebSocket, t: Pick<ProxyTicket, 'kind' | 'host' | 'port'> | null, why: string, pdu?: RDCleanPathError) {
    this.o.log?.('warn', `FBRX View: ${t ? `${t.kind} to ${t.host}:${t.port}` : 'a connection'} refused: ${why}`);
    if (t) this.event({ kind: t.kind, host: t.host, port: t.port, event: 'refused', why });
    if (pdu && ws.readyState === ws.OPEN) ws.send(encodeRDCleanPathError(pdu), () => ws.close(1000));
    else ws.close(1008, why.slice(0, 100));
  }

  private vnc(ws: WebSocket, token: string) {
    const t = this.take(token, 'vnc');
    if (!t) return this.refuse(ws, null, 'no ticket');
    const sock = netConnect({ host: t.host, port: t.port });
    sock.setNoDelay(true);
    sock.setTimeout(this.o.connectTimeoutMs ?? 10_000, () => sock.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    sock.once('error', (err) => this.refuse(ws, t, err.message));
    sock.once('connect', () => {
      sock.setTimeout(0);
      sock.removeAllListeners('error');
      sock.on('error', () => undefined);
      this.carry(ws, sock, t);
    });
  }

  private rdp(ws: WebSocket) {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => this.refuse(ws, null, 'no request'), FIRST_MESSAGE_MS);
    const onMessage = (data: Buffer | ArrayBuffer | Buffer[]) => {
      const chunk = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
      buf = Buffer.concat([buf, chunk]);
      let size: number | null;
      try {
        size = rdcleanpathSize(buf);
      } catch {
        clearTimeout(timer);
        ws.off('message', onMessage);
        return this.refuse(ws, null, 'not an RDCleanPath request', { errorCode: RDCLEANPATH_ERRORS.general, httpStatusCode: 400 });
      }
      if (size === null) {
        if (buf.length > FIRST_MESSAGE_MAX) {
          clearTimeout(timer);
          ws.off('message', onMessage);
          this.refuse(ws, null, 'request too large', { errorCode: RDCLEANPATH_ERRORS.general, httpStatusCode: 413 });
        }
        return;
      }
      clearTimeout(timer);
      ws.off('message', onMessage);
      void this.rdpConnect(ws, buf.subarray(0, size), buf.subarray(size));
    };
    ws.on('message', onMessage);
  }

  private async rdpConnect(ws: WebSocket, pdu: Buffer, rest: Buffer) {
    let req;
    try {
      req = decodeRDCleanPathRequest(pdu);
    } catch (err) {
      return this.refuse(ws, null, (err as Error).message, { errorCode: RDCLEANPATH_ERRORS.general, httpStatusCode: 400 });
    }
    if (req.version !== RDCLEANPATH_VERSION) return this.refuse(ws, null, `version ${req.version}`, { errorCode: RDCLEANPATH_ERRORS.general, httpStatusCode: 400 });
    const t = this.take(req.proxyAuth, 'rdp');
    if (!t) return this.refuse(ws, null, 'no ticket', { errorCode: RDCLEANPATH_ERRORS.general, httpStatusCode: 401 });
    const dest = parseDestination(req.destination, DEFAULT_PORTS.rdp);
    if (!dest || !sameHost(dest.host, t.host) || dest.port !== t.port) return this.refuse(ws, t, 'the ticket is for another computer', { errorCode: RDCLEANPATH_ERRORS.general, httpStatusCode: 403 });
    if (req.preconnectionBlob) return this.refuse(ws, t, 'preconnection blobs are not supported', { errorCode: RDCLEANPATH_ERRORS.general, httpStatusCode: 400 });

    const timeout = this.o.connectTimeoutMs ?? 10_000;
    let sock: Socket;
    try {
      sock = await new Promise<Socket>((resolve, reject) => {
        const s = netConnect({ host: t.host, port: t.port });
        s.setNoDelay(true);
        s.setTimeout(timeout, () => s.destroy(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
        s.once('error', reject);
        s.once('connect', () => {
          s.setTimeout(0);
          s.off('error', reject);
          resolve(s);
        });
      });
    } catch (err) {
      return this.refuse(ws, t, (err as Error).message, connectError(err as NodeJS.ErrnoException));
    }
    sock.on('error', () => undefined);
    let x224: Buffer;
    try {
      sock.write(req.x224);
      x224 = await readTpkt(sock, timeout);
    } catch (err) {
      sock.destroy();
      return this.refuse(ws, t, (err as Error).message, { errorCode: RDCLEANPATH_ERRORS.negotiation });
    }
    const choice = x224Choice(x224);
    if (choice !== 'tls') {
      sock.destroy();
      return this.refuse(ws, t, choice === 'failed' ? 'the computer refused the security FBRX View asked for' : 'the computer only offers old RDP security, without TLS', { errorCode: RDCLEANPATH_ERRORS.negotiation });
    }
    let tls: TLSSocket;
    try {
      tls = await new Promise<TLSSocket>((resolve, reject) => {
        // The window checks the computer's certificate (it gets the chain below), as a remote desktop client does.
        const s = tlsConnect({ socket: sock, rejectUnauthorized: false, servername: isIP(t.host) ? undefined : t.host });
        s.once('secureConnect', () => {
          s.off('error', reject);
          resolve(s);
        });
        s.once('error', reject);
      });
    } catch (err) {
      sock.destroy();
      return this.refuse(ws, t, (err as Error).message, { errorCode: RDCLEANPATH_ERRORS.tlsFailed });
    }
    tls.on('error', () => undefined);
    tls.pause();
    const chain = chainOf(tls.getPeerCertificate(true));
    const serverAddr = `${sock.remoteAddress && isIP(sock.remoteAddress) === 6 ? `[${sock.remoteAddress}]` : sock.remoteAddress}:${sock.remotePort}`;
    if (ws.readyState !== ws.OPEN) {
      tls.destroy();
      return;
    }
    ws.send(encodeRDCleanPathResponse({ x224, certChain: chain, serverAddr }));
    this.carry(ws, tls, t, rest);
  }
}
