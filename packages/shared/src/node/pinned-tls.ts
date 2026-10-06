import { Agent, request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { connect as tlsConnect, type ConnectionOptions, type PeerCertificate, type TLSSocket } from 'node:tls';

/**
 * Trusting a server by its certificate's SHA-256 fingerprint ("pinning"), for servers no public authority vouches for:
 * a UniFi console, FBRX Command on a home or school network with its own certificate, or a server's management
 * controller (iDRAC). Nothing is sent until the certificate the server presents has the fingerprint that was trusted.
 */

export type PinErrorCode = 'FORBIDDEN' | 'TIMEOUT' | 'INVALID_ARGUMENT' | 'CANCELLED';
/** Makes the errors these helpers throw (FBRX Endpoint passes its own error type). */
export type PinErrorFactory = (code: PinErrorCode, message: string) => Error;
const plainError: PinErrorFactory = (code, message) => Object.assign(new Error(message), { code });

export const normalizeFingerprint = (fp: string) => fp.replace(/[^0-9a-f]/gi, '').toUpperCase();
export const formatFingerprint = (fp: string) => normalizeFingerprint(fp).match(/.{2}/g)?.join(':') ?? '';
export const sameFingerprint = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && normalizeFingerprint(a) === normalizeFingerprint(b);

const servername = (host: string) => (/^[\d.]+$|:/.test(host) ? undefined : host);

/** An agent that checks the server's certificate fingerprint before handing the connection to the request. */
export function pinnedAgent(fingerprint: string, mismatch = 'The server presented a different certificate than the one you trusted.', err: PinErrorFactory = plainError): Agent {
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
        cb(err('FORBIDDEN', mismatch));
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

export interface PresentedCertificate {
  fingerprint: string;
  subject: string;
  issuer: string;
  validTo: string;
  /** Whether the system's certificate authorities vouch for it under this name (no pinning needed). */
  trusted: boolean;
}

/** The certificate a host presents, whoever signed it, and whether the system already trusts it. */
export function peerCertificate(url: string, timeoutMs = 15_000, err: PinErrorFactory = plainError): Promise<PresentedCertificate> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const sock = tlsConnect({ host: u.hostname, port: Number(u.port || 443), servername: servername(u.hostname), rejectUnauthorized: false, timeout: timeoutMs });
    sock.once('secureConnect', () => {
      const c: PeerCertificate = sock.getPeerCertificate();
      const trusted = sock.authorized;
      sock.end();
      const name = (x: PeerCertificate['subject'] | undefined) => (x ? [x.CN, x.O].filter(Boolean).join(', ') : '');
      resolve({ fingerprint: formatFingerprint(c.fingerprint256 ?? ''), subject: name(c.subject) || 'unnamed', issuer: name(c.issuer) || 'unnamed', validTo: c.valid_to ?? '', trusted });
    });
    sock.once('timeout', () => {
      sock.destroy();
      reject(err('TIMEOUT', `No answer from ${u.host}`));
    });
    sock.once('error', reject);
  });
}

/**
 * fetch() over a pinned agent: the same Request/Response shapes as the global fetch, for code that talks to a server
 * trusted by fingerprint (Node's built-in fetch cannot take an agent).
 */
export function pinnedFetch(url: string, init: RequestInit & { duplex?: 'half' }, agent: Agent, err: PinErrorFactory = plainError): Promise<Response> {
  const u = new URL(url);
  if (u.protocol !== 'https:') return Promise.reject(err('INVALID_ARGUMENT', 'Pinned connections need https://'));
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    const body = init.body;
    if (typeof body === 'string' && !headers['content-length']) headers['content-length'] = String(Buffer.byteLength(body));
    const req = httpsRequest(
      { protocol: 'https:', hostname: u.hostname, port: u.port || 443, path: `${u.pathname}${u.search}`, method: init.method ?? 'GET', headers, agent, servername: servername(u.hostname) },
      (res) => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : String(v));
        const status = res.statusCode ?? 0;
        const empty = status === 204 || status === 304 || init.method === 'HEAD';
        if (empty) res.resume();
        resolve(new Response(empty ? null : (Readable.toWeb(res) as ReadableStream), { status, statusText: res.statusMessage, headers: h }));
      },
    );
    const signal = init.signal;
    const abort = () => req.destroy(signal?.reason instanceof Error ? signal.reason : err('CANCELLED', 'Request cancelled'));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    req.once('close', () => signal?.removeEventListener('abort', abort));
    req.once('error', reject);
    if (body == null) req.end();
    else if (typeof body === 'string' || body instanceof Uint8Array) req.end(body);
    else if (body instanceof ReadableStream) Readable.fromWeb(body as never).once('error', (e) => req.destroy(e)).pipe(req);
    else reject(err('INVALID_ARGUMENT', 'Unsupported request body'));
  });
}
