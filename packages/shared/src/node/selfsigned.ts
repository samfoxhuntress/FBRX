import { X509Certificate, createPrivateKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * A self-signed TLS certificate for FBRX Command on a home or school network, where there is no domain name to get a
 * public certificate for. Computers trust it by its SHA-256 fingerprint (pinning), so the names in it only matter to
 * browsers. Written with node:crypto alone: an ECDSA P-256 key and a minimal DER encoder for one X.509 v3 certificate.
 */
export interface SelfSignedCertificate {
  certPem: string;
  keyPem: string;
  /** "AB:CD:…", as Node's TLS reports it (getPeerCertificate().fingerprint256). */
  fingerprint: string;
  notAfter: string;
}

export function createSelfSignedCertificate(opts: { commonName: string; names?: string[]; days?: number; organization?: string }): SelfSignedCertificate {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const days = opts.days ?? 3650;
  const notBefore = new Date(Date.now() - 60 * 60_000);
  const notAfter = new Date(notBefore.getTime() + days * 86400_000);
  const names = [...new Set([opts.commonName, ...(opts.names ?? [])].map((n) => n.trim()).filter(Boolean))];

  const serial = randomBytes(16);
  serial[0] = (serial[0]! & 0x7f) | 0x40; // positive, no leading zero byte
  const name = seq(
    set(seq(oid('2.5.4.10'), utf8(opts.organization ?? 'FBRX Command'))),
    set(seq(oid('2.5.4.3'), utf8(opts.commonName))),
  );
  const ecdsaSha256 = seq(oid('1.2.840.10045.4.3.2'));
  const san = seq(
    ...names.map((n) => {
      const v = isIP(n);
      if (v === 4) return tlv(0x87, Buffer.from(n.split('.').map(Number)));
      if (v === 6) return tlv(0x87, ipv6Bytes(n));
      return tlv(0x82, Buffer.from(n, 'ascii'));
    }),
  );
  const extensions = tlv(
    0xa3,
    seq(
      extension('2.5.29.19', true, seq()), // basicConstraints: not a CA
      extension('2.5.29.15', true, tlv(0x03, Buffer.from([0x07, 0x80]))), // keyUsage: digitalSignature
      extension('2.5.29.37', false, seq(oid('1.3.6.1.5.5.7.3.1'))), // extKeyUsage: serverAuth
      extension('2.5.29.17', false, san), // subjectAltName
    ),
  );
  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))), // v3
    integer(serial),
    ecdsaSha256,
    name,
    seq(time(notBefore), time(notAfter)),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
    extensions,
  );
  const signature = sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
  const der = seq(tbs, ecdsaSha256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const certPem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----\n`;
  const keyPem = (privateKey as KeyObject).export({ type: 'pkcs8', format: 'pem' }).toString();
  return { certPem, keyPem, fingerprint: new X509Certificate(certPem).fingerprint256, notAfter: notAfter.toISOString() };
}

/** The fingerprint of a PEM certificate, and whether the key belongs to it. */
export function certificateInfo(certPem: string, keyPem?: string): { fingerprint: string; selfSigned: boolean; notAfter: string; names: string[]; matchesKey: boolean } {
  const c = new X509Certificate(certPem);
  return {
    fingerprint: c.fingerprint256,
    selfSigned: c.issuer === c.subject && c.verify(c.publicKey),
    notAfter: new Date(c.validTo).toISOString(),
    names: (c.subjectAltName ?? '').split(/,\s*/).map((s) => s.replace(/^(DNS|IP Address):/, '')).filter(Boolean),
    matchesKey: keyPem ? c.checkPrivateKey(createPrivateKey(keyPem)) : false,
  };
}

// ------------------------------------------------------------------------------------------------ DER

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
}
const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
const integer = (b: Buffer) => tlv(0x02, b);
const utf8 = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));
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
function time(d: Date): Buffer {
  const p = (n: number) => String(n).padStart(2, '0');
  const body = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  const y = d.getUTCFullYear();
  // UTCTime up to 2049, GeneralizedTime after (RFC 5280 4.1.2.5).
  return y < 2050 ? tlv(0x17, Buffer.from(`${p(y % 100)}${body}`, 'ascii')) : tlv(0x18, Buffer.from(`${y}${body}`, 'ascii'));
}
function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return seq(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), tlv(0x04, value));
}
function ipv6Bytes(addr: string): Buffer {
  const [head, tail] = addr.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return Buffer.from(groups.flatMap((g) => [(parseInt(g, 16) >> 8) & 0xff, parseInt(g, 16) & 0xff]));
}
