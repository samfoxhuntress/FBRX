import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: string, counter: number, digits = 6): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = mac[mac.length - 1] & 0xf;
  const code = ((mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits).toString();
  return code.padStart(digits, '0');
}

/** RFC 6238 TOTP (30-second step, SHA-1, 6 digits) — compatible with every authenticator app. */
export function totp(secret: string, at = Date.now()): string {
  return hotp(secret, Math.floor(at / 30_000));
}

export function verifyTotp(secret: string, code: string, at = Date.now(), window = 1): boolean {
  const c = String(code).replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  const step = Math.floor(at / 30_000);
  for (let w = -window; w <= window; w++) {
    const expected = Buffer.from(hotp(secret, step + w));
    if (timingSafeEqual(expected, Buffer.from(c))) return true;
  }
  return false;
}

export function otpauthUrl(secret: string, account: string, issuer = 'FBRX OS'): string {
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${account}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}
