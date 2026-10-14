import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';

/**
 * Test certificates shaped like the App Store's signing chain: a root, an intermediate with Apple's WWDR marker
 * extension, and a leaf with the receipt-signing marker, all ECDSA P-256. (A minimal DER writer, as in selfsigned.ts.)
 */
export interface TestCert {
  der: Buffer;
  key: KeyObject;
  pem: string;
}

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const tlv = (tag: number, c: Buffer) => Buffer.concat([Buffer.from([tag]), length(c.length), c]);
const seq = (...i: Buffer[]) => tlv(0x30, Buffer.concat(i));
const set = (...i: Buffer[]) => tlv(0x31, Buffer.concat(i));
function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  const out = [40 * parts[0]! + parts[1]!];
  for (const p of parts.slice(2)) {
    const chunk: number[] = [p & 0x7f];
    for (let v = Math.floor(p / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}
const utc = (d: Date) => tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z', 'ascii'));
const name = (cn: string) => seq(set(seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn)))));
const ext = (id: string, value: Buffer, critical = false) => seq(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, value));

export function makeCert(opts: { cn: string; issuer?: TestCert & { cn: string }; ca: boolean; markerOid?: string }): TestCert & { cn: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const alg = seq(oid('1.2.840.10045.4.3.2'));
  const serial = randomBytes(12);
  serial[0] = (serial[0]! & 0x7f) | 0x10;
  const exts = [ext('2.5.29.19', seq(...(opts.ca ? [tlv(0x01, Buffer.from([0xff]))] : [])), true), ...(opts.markerOid ? [ext(opts.markerOid, tlv(0x05, Buffer.alloc(0)))] : [])];
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, serial),
    alg,
    name(opts.issuer?.cn ?? opts.cn),
    seq(utc(new Date(Date.now() - 86_400_000)), utc(new Date(Date.now() + 365 * 86_400_000))),
    name(opts.cn),
    publicKey.export({ type: 'spki', format: 'der' }),
    tlv(0xa3, seq(...exts)),
  );
  const sig = sign('sha256', tbs, { key: opts.issuer?.key ?? privateKey, dsaEncoding: 'der' });
  const der = seq(tbs, alg, tlv(0x03, Buffer.concat([Buffer.from([0]), sig])));
  const pem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
  return { der, key: privateKey, pem, cn: opts.cn };
}

/** A root, an intermediate and a leaf like the App Store's. */
export function appleLikeChain() {
  const root = makeCert({ cn: 'Test Root CA - G3', ca: true });
  const intermediate = makeCert({ cn: 'Test WWDR', issuer: root, ca: true, markerOid: '1.2.840.113635.100.6.2.1' });
  const leaf = makeCert({ cn: 'Test App Store Signing', issuer: intermediate, ca: false, markerOid: '1.2.840.113635.100.6.11.1' });
  return { root, intermediate, leaf };
}

/** A JWS (ES256) with the chain in its header, as the App Store signs transactions and notifications. */
export function signJws(payload: unknown, chain: ReturnType<typeof appleLikeChain>): string {
  const b64u = (b: Buffer) => b.toString('base64url');
  const header = b64u(Buffer.from(JSON.stringify({ alg: 'ES256', x5c: [chain.leaf, chain.intermediate, chain.root].map((c) => c.der.toString('base64')) })));
  const body = b64u(Buffer.from(JSON.stringify(payload)));
  const sig = sign('sha256', Buffer.from(`${header}.${body}`), { key: chain.leaf.key, dsaEncoding: 'ieee-p1363' });
  return `${header}.${body}.${b64u(sig)}`;
}
