import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function hmacSha256Hex(key: string | Uint8Array, data: string | Uint8Array): string {
  return createHmac('sha256', key).update(data).digest('hex');
}

export function b64u(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

export function fromB64u(s: string): Buffer {
  return Buffer.from(s, 'base64url');
}

/** Opaque bearer token: `<prefix>_<43 chars>` (256 bits). Store only `sha256Hex(token)` server-side. */
export function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}_${randomBytes(bytes).toString('base64url')}`;
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export interface KdfParams {
  N: number;
  r: number;
  p: number;
}

/** Interactive-strength parameters for passphrase-derived keys (≈64 MiB, ~150-300 ms). */
export const KDF_STRONG: KdfParams = { N: 2 ** 16, r: 8, p: 1 };
/** Lighter parameters for server-side password hashing under load. */
export const KDF_PASSWORD: KdfParams = { N: 2 ** 14, r: 8, p: 1 };

export function scryptKey(secret: string | Uint8Array, salt: Uint8Array, params: KdfParams = KDF_STRONG, keyLen = 32): Promise<Buffer> {
  const opts: ScryptOptions = { N: params.N, r: params.r, p: params.p, maxmem: 256 * 1024 * 1024 };
  return new Promise((resolve, reject) => {
    scryptCb(secret, salt, keyLen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

export interface GcmSealed {
  iv: Buffer;
  tag: Buffer;
  ciphertext: Buffer;
}

export function aesGcmEncrypt(key: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): GcmSealed {
  if (key.length !== 32) throw new Error('AES-256-GCM requires a 32-byte key');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (aad) cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ciphertext };
}

export function aesGcmDecrypt(key: Uint8Array, sealed: GcmSealed, aad?: Uint8Array): Buffer {
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.iv);
  if (aad) decipher.setAAD(aad);
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
}

/** Compact string envelope: `v1.<iv>.<tag>.<ciphertext>` (base64url parts). */
export function sealString(key: Uint8Array, plaintext: string | Uint8Array, aad?: string): string {
  const data = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
  const s = aesGcmEncrypt(key, data, aad ? Buffer.from(aad) : undefined);
  return `v1.${b64u(s.iv)}.${b64u(s.tag)}.${b64u(s.ciphertext)}`;
}

export function openBytes(key: Uint8Array, envelope: string, aad?: string): Buffer {
  const parts = envelope.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Unsupported envelope format');
  return aesGcmDecrypt(
    key,
    { iv: fromB64u(parts[1]), tag: fromB64u(parts[2]), ciphertext: fromB64u(parts[3]) },
    aad ? Buffer.from(aad) : undefined,
  );
}

export function openString(key: Uint8Array, envelope: string, aad?: string): string {
  return openBytes(key, envelope, aad).toString('utf8');
}

/** Password hash string: `scrypt$N$r$p$salt$hash`. */
export async function hashPassword(password: string, params: KdfParams = KDF_PASSWORD): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptKey(password, salt, params, 32);
  return `scrypt$${params.N}$${params.r}$${params.p}$${b64u(salt)}$${b64u(key)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const params = { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]) };
  const expected = fromB64u(parts[5]);
  const key = await scryptKey(password, fromB64u(parts[4]), params, expected.length);
  return key.length === expected.length && timingSafeEqual(key, expected);
}
