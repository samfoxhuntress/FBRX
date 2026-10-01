import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import nacl from 'tweetnacl';

/**
 * Mesh cryptography. Every device has a long-term X25519 key pair. Requests between paired devices are sealed with
 * NaCl `box` (XSalsa20-Poly1305 with the sender's secret key and the recipient's public key), so a message proves
 * who sent it and only the recipient can read it. Pairing is authenticated with a short-lived one-time code: both
 * sides prove knowledge of the code with an HMAC over both public keys, which defeats a machine-in-the-middle.
 *
 * The phone app implements the same construction in the browser (tweetnacl + HMAC-SHA512 built on nacl.hash).
 */

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32: no I, L, O, U
export const PAIR_CODE_LENGTH = 20; // 100 bits

export const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64');
export const unb64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(String(s ?? ''), 'base64'));

export interface KeyPair {
  publicKey: string;
  secretKey: string;
}

export function generateKeyPair(): KeyPair {
  const kp = nacl.box.keyPair();
  return { publicKey: b64(kp.publicKey), secretKey: b64(kp.secretKey) };
}

/** Stable device id / fingerprint derived from a public key (shown to people to compare). */
export function fingerprint(publicKey: string): string {
  return createHash('sha512').update(unb64(publicKey)).digest('hex').slice(0, 32);
}

export function formatFingerprint(fp: string): string {
  return fp.slice(0, 16).toUpperCase().match(/.{4}/g)!.join(' ');
}

export function newPairingCode(): string {
  const bytes = randomBytes(PAIR_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < PAIR_CODE_LENGTH; i++) out += ALPHABET[bytes[i] & 31];
  return out;
}

/** Uppercases, strips separators and maps look-alike characters, so "abcd-efgh…" and "ABCDEFGH…" match. */
export function normalizeCode(code: string): string {
  return String(code ?? '')
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/U/g, 'V');
}

export function groupCode(code: string): string {
  return code.match(/.{1,4}/g)!.join('-');
}

/** HMAC-SHA512(code, label | a | b), base64. */
export function pairingMac(code: string, label: string, ...parts: string[]): string {
  return createHmac('sha512', Buffer.from(normalizeCode(code), 'utf8')).update([label, ...parts].join('|'), 'utf8').digest('base64');
}

export function macEquals(a: string, b: string): boolean {
  const x = Buffer.from(String(a ?? ''), 'base64');
  const y = Buffer.from(String(b ?? ''), 'base64');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

export interface Envelope {
  /** Sender's device id (fingerprint of its public key). */
  from: string;
  nonce: string;
  box: string;
}

export function seal(payload: unknown, recipientPublicKey: string, senderSecretKey: string, from: string): Envelope {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const msg = new TextEncoder().encode(JSON.stringify(payload));
  return { from, nonce: b64(nonce), box: b64(nacl.box(msg, nonce, unb64(recipientPublicKey), unb64(senderSecretKey))) };
}

export function open<T = unknown>(env: Pick<Envelope, 'nonce' | 'box'>, senderPublicKey: string, recipientSecretKey: string): T | null {
  try {
    const nonce = unb64(env.nonce);
    if (nonce.length !== nacl.box.nonceLength) return null;
    const out = nacl.box.open(unb64(env.box), nonce, unb64(senderPublicKey), unb64(recipientSecretKey));
    return out ? (JSON.parse(new TextDecoder().decode(out)) as T) : null;
  } catch {
    return null;
  }
}

/** Remembers request ids for a while so a captured request cannot be replayed. */
export class ReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly windowMs = 120_000,
    private readonly max = 20_000,
  ) {}

  /** True when the request is fresh (timestamp within the window and id not seen before). */
  check(key: string, ts: number, now = Date.now()): boolean {
    if (!Number.isFinite(ts) || Math.abs(now - ts) > this.windowMs) return false;
    if (this.seen.has(key)) return false;
    if (this.seen.size >= this.max) {
      for (const [k, t] of this.seen) if (now - t > this.windowMs * 2) this.seen.delete(k);
      if (this.seen.size >= this.max) this.seen.clear();
    }
    this.seen.set(key, now);
    return true;
  }
}
