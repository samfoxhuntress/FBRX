/**
 * RDCleanPath, the small handshake FBRX View's RDP client (IronRDP, running in the window) speaks to the proxy in the
 * main process: a browser cannot open a TCP connection or do TLS itself, so it sends its first RDP packet (the X.224
 * connection request) inside a request, the proxy connects, does TLS with the computer, and answers with the computer's
 * X.224 reply and its certificate chain; after that the proxy carries the RDP stream. The messages are DER (ASN.1),
 * every field explicitly tagged ([0] version, [1] error, [2] destination, [3] proxy_auth, [4] server_auth,
 * [5] preconnection_blob, [6] x224_connection_pdu, [7] server_cert_chain, [9] server_addr), as IronRDP's
 * ironrdp-rdcleanpath defines them.
 */

export const RDCLEANPATH_VERSION = 3390;

export const RDCLEANPATH_ERRORS = {
  general: 1,
  negotiation: 2,
  targetUnreachable: 103,
  dnsFailed: 104,
  tlsFailed: 105,
} as const;

export interface RDCleanPathRequest {
  version: number;
  destination: string;
  proxyAuth: string;
  serverAuth: string | null;
  preconnectionBlob: string | null;
  x224: Buffer;
}

export interface RDCleanPathError {
  errorCode: number;
  httpStatusCode?: number;
  wsaLastError?: number;
  tlsAlertCode?: number;
}

// ------------------------------------------------------------------------------------------------- DER, the little

const SEQUENCE = 0x30;
const INTEGER = 0x02;
const UTF8 = 0x0c;
const OCTETS = 0x04;
const ctx = (n: number) => 0xa0 | n;

function tlv(tag: number, value: Buffer): Buffer {
  const n = value.length;
  let len: Buffer;
  if (n < 0x80) len = Buffer.from([n]);
  else if (n <= 0xff) len = Buffer.from([0x81, n]);
  else if (n <= 0xffff) len = Buffer.from([0x82, n >> 8, n & 0xff]);
  else if (n <= 0xffffff) len = Buffer.from([0x83, n >> 16, (n >> 8) & 0xff, n & 0xff]);
  else len = Buffer.from([0x84, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
  return Buffer.concat([Buffer.from([tag]), len, value]);
}

function integer(v: number): Buffer {
  if (!Number.isSafeInteger(v) || v < 0) throw new Error('RDCleanPath: a negative or too large number');
  const bytes: number[] = [];
  let x = v;
  do {
    bytes.unshift(x % 256);
    x = Math.floor(x / 256);
  } while (x > 0);
  if (bytes[0]! & 0x80) bytes.unshift(0);
  return tlv(INTEGER, Buffer.from(bytes));
}

const explicit = (n: number, inner: Buffer) => tlv(ctx(n), inner);

interface Node {
  tag: number;
  value: Buffer;
  /** The whole element's length, header included. */
  size: number;
}

/** One element at the start of buf; null while more bytes are needed. Throws on what is not DER. */
function readTlv(buf: Buffer, at = 0): Node | null {
  if (buf.length < at + 2) return null;
  const tag = buf[at]!;
  if ((tag & 0x1f) === 0x1f) throw new Error('RDCleanPath: a long tag');
  let len = buf[at + 1]!;
  let head = 2;
  if (len & 0x80) {
    const count = len & 0x7f;
    if (count === 0 || count > 4) throw new Error('RDCleanPath: a bad length');
    if (buf.length < at + 2 + count) return null;
    len = 0;
    for (let i = 0; i < count; i++) len = len * 256 + buf[at + 2 + i]!;
    head += count;
  }
  if (buf.length < at + head + len) return null;
  return { tag, value: buf.subarray(at + head, at + head + len), size: head + len };
}

function children(value: Buffer): Node[] {
  const out: Node[] = [];
  let at = 0;
  while (at < value.length) {
    const n = readTlv(value, at);
    if (!n) throw new Error('RDCleanPath: a cut element');
    out.push(n);
    at += n.size;
  }
  return out;
}

function readInteger(n: Node): number {
  if (n.tag !== INTEGER || n.value.length === 0 || n.value.length > 7) throw new Error('RDCleanPath: a bad number');
  let v = 0;
  for (const b of n.value) v = v * 256 + b;
  return v;
}

function readString(n: Node): string {
  if (n.tag !== UTF8) throw new Error('RDCleanPath: a bad text field');
  return n.value.toString('utf8');
}

// ------------------------------------------------------------------------------------------------- the messages

/** How many bytes the first message needs (null: not enough yet to tell); throws when it is not RDCleanPath. */
export function rdcleanpathSize(buf: Buffer): number | null {
  if (buf.length >= 1 && buf[0] !== SEQUENCE) throw new Error('RDCleanPath: not a request');
  const n = readTlv(buf);
  return n ? n.size : null;
}

/** The client's request: where to connect, the proxy ticket and its X.224 connection request. */
export function decodeRDCleanPathRequest(buf: Buffer): RDCleanPathRequest {
  const outer = readTlv(buf);
  if (!outer || outer.tag !== SEQUENCE) throw new Error('RDCleanPath: not a request');
  const fields = new Map<number, Node>();
  for (const c of children(outer.value)) {
    if ((c.tag & 0xe0) !== 0xa0) throw new Error('RDCleanPath: an untagged field');
    const inner = children(c.value);
    if (inner.length !== 1) throw new Error('RDCleanPath: a bad field');
    fields.set(c.tag & 0x1f, inner[0]!);
  }
  const need = (k: number) => {
    const f = fields.get(k);
    if (!f) throw new Error(`RDCleanPath: field ${k} is missing`);
    return f;
  };
  const version = readInteger(need(0));
  if (fields.has(1)) throw new Error('RDCleanPath: the client sent an error');
  const x224 = need(6);
  if (x224.tag !== OCTETS) throw new Error('RDCleanPath: a bad X.224 field');
  return {
    version,
    destination: readString(need(2)),
    proxyAuth: readString(need(3)),
    serverAuth: fields.has(4) ? readString(fields.get(4)!) : null,
    preconnectionBlob: fields.has(5) ? readString(fields.get(5)!) : null,
    x224: Buffer.from(x224.value),
  };
}

/** The proxy's answer once it reached the computer: its X.224 reply, its certificates and the address it used. */
export function encodeRDCleanPathResponse(o: { x224: Buffer; certChain: Buffer[]; serverAddr: string }): Buffer {
  return tlv(
    SEQUENCE,
    Buffer.concat([
      explicit(0, integer(RDCLEANPATH_VERSION)),
      explicit(6, tlv(OCTETS, o.x224)),
      explicit(7, tlv(SEQUENCE, Buffer.concat(o.certChain.map((c) => tlv(OCTETS, c))))),
      explicit(9, tlv(UTF8, Buffer.from(o.serverAddr, 'utf8'))),
    ]),
  );
}

/** The proxy's answer when it could not reach the computer. */
export function encodeRDCleanPathError(e: RDCleanPathError): Buffer {
  const err = Buffer.concat([
    explicit(0, integer(e.errorCode)),
    ...(e.httpStatusCode != null ? [explicit(1, integer(e.httpStatusCode))] : []),
    ...(e.wsaLastError != null ? [explicit(2, integer(e.wsaLastError))] : []),
    ...(e.tlsAlertCode != null ? [explicit(3, integer(e.tlsAlertCode))] : []),
  ]);
  return tlv(SEQUENCE, Buffer.concat([explicit(0, integer(RDCLEANPATH_VERSION)), explicit(1, tlv(SEQUENCE, err))]));
}

/** For tests: the request as IronRDP's client builds it. */
export function encodeRDCleanPathRequest(o: { destination: string; proxyAuth: string; x224: Buffer; serverAuth?: string }): Buffer {
  return tlv(
    SEQUENCE,
    Buffer.concat([
      explicit(0, integer(RDCLEANPATH_VERSION)),
      explicit(2, tlv(UTF8, Buffer.from(o.destination, 'utf8'))),
      explicit(3, tlv(UTF8, Buffer.from(o.proxyAuth, 'utf8'))),
      ...(o.serverAuth ? [explicit(4, tlv(UTF8, Buffer.from(o.serverAuth, 'utf8')))] : []),
      explicit(6, tlv(OCTETS, o.x224)),
    ]),
  );
}

/** For tests: what a response or error says. */
export function decodeRDCleanPathResponse(buf: Buffer): { error: RDCleanPathError | null; x224: Buffer | null; certChain: Buffer[]; serverAddr: string | null } {
  const outer = readTlv(buf);
  if (!outer || outer.tag !== SEQUENCE) throw new Error('RDCleanPath: not a response');
  const out = { error: null as RDCleanPathError | null, x224: null as Buffer | null, certChain: [] as Buffer[], serverAddr: null as string | null };
  for (const c of children(outer.value)) {
    const inner = children(c.value)[0]!;
    switch (c.tag & 0x1f) {
      case 1: {
        const e: RDCleanPathError = { errorCode: 0 };
        for (const f of children(inner.value)) {
          const v = readInteger(children(f.value)[0]!);
          const k = f.tag & 0x1f;
          if (k === 0) e.errorCode = v;
          else if (k === 1) e.httpStatusCode = v;
          else if (k === 2) e.wsaLastError = v;
          else if (k === 3) e.tlsAlertCode = v;
        }
        out.error = e;
        break;
      }
      case 6:
        out.x224 = Buffer.from(inner.value);
        break;
      case 7:
        out.certChain = children(inner.value).map((n) => Buffer.from(n.value));
        break;
      case 9:
        out.serverAddr = readString(inner);
        break;
    }
  }
  return out;
}
