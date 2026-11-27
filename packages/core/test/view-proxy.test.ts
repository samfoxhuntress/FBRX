import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { TLSSocket } from 'node:tls';
import { X509Certificate } from 'node:crypto';
import WebSocket from 'ws';
import { createSelfSignedCertificate } from '@fbrx/shared/node';
import { decodeRDCleanPathRequest, decodeRDCleanPathResponse, encodeRDCleanPathError, encodeRDCleanPathRequest, encodeRDCleanPathResponse, rdcleanpathSize } from '../src/view/rdcleanpath';
import { RemoteProxy, parseDestination, x224Choice, type ProxySessionEvent } from '../src/view/remote-proxy';

// An X.224 connection request as a client sends it (TPKT, X.224 CR, RDP_NEG_REQ asking for TLS and NLA).
const X224_REQUEST = Buffer.from('030000130ee000000000000100080003000000', 'hex');
// The computer's answer choosing TLS (RDP_NEG_RSP, selectedProtocol 1).
const X224_TLS = Buffer.from('030000130ed000001234000200080001000000', 'hex');
const X224_FAILED = Buffer.from('030000130ed000001234000300080005000000', 'hex');
const X224_OLD = Buffer.from('0300000b06d00000123400', 'hex');

const cert = createSelfSignedCertificate({ commonName: 'rdp-test' });

/** A pretend RDP server: answers the X.224 request, does TLS, then echoes what it gets. */
function fakeRdp(answer: Buffer = X224_TLS): Promise<{ server: Server; port: number }> {
  const server = createServer((sock: Socket) => {
    let buf = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 4 || buf.length < buf.readUInt16BE(2)) return;
      sock.off('data', onData);
      sock.write(answer);
      if (x224Choice(answer) !== 'tls') return;
      const tls = new TLSSocket(sock, { isServer: true, key: cert.keyPem, cert: cert.certPem });
      tls.on('data', (x: Buffer) => tls.write(Buffer.concat([Buffer.from('echo:'), x])));
      tls.on('error', () => undefined);
    };
    sock.on('data', onData);
    sock.on('error', () => undefined);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port })));
}

function open(url: string, protocols?: string[]): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, protocols);
    ws.binaryType = 'nodebuffer';
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

const next = (ws: WebSocket) => new Promise<Buffer>((resolve, reject) => {
  ws.once('message', (d) => resolve(d as Buffer));
  ws.once('close', () => reject(new Error('closed')));
});

describe('RDCleanPath messages', () => {
  it('reads a request as IronRDP builds it, and writes answers it can read', () => {
    const req = encodeRDCleanPathRequest({ destination: 'pc.example:3389', proxyAuth: 'tok', x224: X224_REQUEST });
    expect(rdcleanpathSize(req.subarray(0, 3))).toBeNull();
    expect(rdcleanpathSize(Buffer.concat([req, Buffer.from('more')]))).toBe(req.length);
    expect(decodeRDCleanPathRequest(req)).toMatchObject({ version: 3390, destination: 'pc.example:3389', proxyAuth: 'tok', serverAuth: null, x224: X224_REQUEST });
    expect(() => rdcleanpathSize(Buffer.from('GET /'))).toThrow();

    const der = new X509Certificate(cert.certPem).raw;
    const res = decodeRDCleanPathResponse(encodeRDCleanPathResponse({ x224: X224_TLS, certChain: [der, der], serverAddr: '10.0.0.5:3389' }));
    expect(res).toMatchObject({ error: null, x224: X224_TLS, serverAddr: '10.0.0.5:3389' });
    expect(res.certChain).toHaveLength(2);
    expect(res.certChain[0]!.equals(der)).toBe(true);

    expect(decodeRDCleanPathResponse(encodeRDCleanPathError({ errorCode: 103, wsaLastError: 10061 })).error).toEqual({ errorCode: 103, wsaLastError: 10061 });
    // Big numbers keep their sign byte: 200 is 0x00C8 in DER.
    expect(decodeRDCleanPathResponse(encodeRDCleanPathError({ errorCode: 1, httpStatusCode: 200 })).error).toEqual({ errorCode: 1, httpStatusCode: 200 });
  });

  it('reads destinations and what the computer chose', () => {
    expect(parseDestination('pc.example', 3389)).toEqual({ host: 'pc.example', port: 3389 });
    expect(parseDestination('10.0.0.5:3390', 3389)).toEqual({ host: '10.0.0.5', port: 3390 });
    expect(parseDestination('[fe80::1]:3389', 3389)).toEqual({ host: 'fe80::1', port: 3389 });
    expect(parseDestination('fe80::1', 3389)).toEqual({ host: 'fe80::1', port: 3389 });
    expect(parseDestination('bad host:1', 3389)).toBeNull();
    expect(x224Choice(X224_TLS)).toBe('tls');
    expect(x224Choice(X224_FAILED)).toBe('failed');
    expect(x224Choice(X224_OLD)).toBe('rdp');
  });
});

describe('FBRX View proxy', () => {
  const events: ProxySessionEvent[] = [];
  const proxy = new RemoteProxy({ onSession: (e) => events.push(e), connectTimeoutMs: 3000 });
  let rdp: { server: Server; port: number };

  beforeAll(async () => {
    rdp = await fakeRdp();
  });
  afterAll(async () => {
    await proxy.close();
    rdp.server.close();
  });

  it('connects RDP for a ticket: the X.224 answer, the certificate, then the stream both ways', async () => {
    const t = await proxy.ticket('rdp', '127.0.0.1', rdp.port);
    expect(t.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/rdp$/);
    const ws = await open(t.url);
    const req = encodeRDCleanPathRequest({ destination: t.destination, proxyAuth: t.token, x224: X224_REQUEST });
    // Sent in two pieces, as a stream may arrive.
    ws.send(req.subarray(0, 10));
    ws.send(req.subarray(10));
    const res = decodeRDCleanPathResponse(await next(ws));
    expect(res.error).toBeNull();
    expect(res.x224!.equals(X224_TLS)).toBe(true);
    expect(res.certChain[0]!.equals(new X509Certificate(cert.certPem).raw)).toBe(true);
    expect(res.serverAddr).toBe(`127.0.0.1:${rdp.port}`);
    ws.send(Buffer.from('hello'));
    expect((await next(ws)).toString()).toBe('echo:hello');
    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    expect(events.filter((e) => e.kind === 'rdp').map((e) => e.event)).toEqual(['open', 'close']);
  });

  it('refuses a missing, used or misdirected ticket, and says why a computer cannot be reached', async () => {
    const ask = async (token: string, destination: string) => {
      const ws = await open((await proxy.ticket('vnc', 'x')).url.replace(/\/vnc.*/, '/rdp'));
      ws.send(encodeRDCleanPathRequest({ destination, proxyAuth: token, x224: X224_REQUEST }));
      return decodeRDCleanPathResponse(await next(ws)).error;
    };
    expect(await ask('nope', `127.0.0.1:${rdp.port}`)).toMatchObject({ errorCode: 1, httpStatusCode: 401 });
    const t = await proxy.ticket('rdp', '127.0.0.1', rdp.port);
    expect(await ask(t.token, '10.9.9.9:3389')).toMatchObject({ errorCode: 1, httpStatusCode: 403 });
    // The ticket went with the refusal: it is used once.
    expect(await ask(t.token, t.destination)).toMatchObject({ errorCode: 1, httpStatusCode: 401 });
    // A VNC ticket is not an RDP ticket.
    const v = await proxy.ticket('vnc', '127.0.0.1', rdp.port);
    expect(await ask(v.token, v.destination)).toMatchObject({ httpStatusCode: 401 });

    const closed = await fakeRdp();
    const port = closed.port;
    closed.server.close();
    const c = await proxy.ticket('rdp', '127.0.0.1', port);
    expect(await ask(c.token, c.destination)).toMatchObject({ errorCode: 103, wsaLastError: 10061 });

    const refusing = await fakeRdp(X224_FAILED);
    const f = await proxy.ticket('rdp', '127.0.0.1', refusing.port);
    expect(await ask(f.token, f.destination)).toMatchObject({ errorCode: 2 });
    refusing.server.close();
    expect(events.some((e) => e.event === 'refused' && /refused the security/.test(e.why ?? ''))).toBe(true);
  });

  it('carries VNC for a ticket, and closes without one', async () => {
    const echo = createServer((s) => s.on('data', (d) => s.write(d)).on('error', () => undefined));
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', () => r()));
    const port = (echo.address() as { port: number }).port;
    const t = await proxy.ticket('vnc', '127.0.0.1', port);
    const ws = await open(t.url, ['binary']);
    expect(ws.protocol).toBe('binary');
    ws.send(Buffer.from('RFB 003.008\n'));
    expect((await next(ws)).toString()).toBe('RFB 003.008\n');
    ws.close();

    const again = await open(t.url);
    const code = await new Promise<number>((r) => again.once('close', (c) => r(c)));
    expect(code).toBe(1008);
    echo.close();
  });

  it('lets a ticket expire', async () => {
    let now = 1_000_000;
    const p = new RemoteProxy({ now: () => now, ticketTtlMs: 1000 });
    const t = await p.ticket('vnc', '127.0.0.1', 1);
    now += 2000;
    const ws = await open(t.url);
    expect(await new Promise<number>((r) => ws.once('close', (c) => r(c)))).toBe(1008);
    await p.close();
  });
});
