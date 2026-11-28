import { createHmac } from 'node:crypto';

/**
 * 2-step codes (TOTP, RFC 6238): the six-digit codes an authenticator app shows, made from a site's secret key and the
 * time. A sign-in in the password keeper can keep the key, so FBRX shows the code beside the password.
 */

export interface TotpSpec {
  secret: Buffer;
  digits: number;
  period: number;
  algorithm: 'sha1' | 'sha256' | 'sha512';
}

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(text: string): Buffer | null {
  const clean = text.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (clean.length < 8 || /[^A-Z2-7]/.test(clean)) return null;
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of clean) {
    value = (value << 5) | BASE32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Reads a site's 2-step key: the base32 key itself, or the otpauth:// address its QR code holds. */
export function parseTotp(input: string): TotpSpec | null {
  const text = input.trim();
  if (!/^otpauth:/i.test(text)) {
    const secret = base32(text);
    return secret ? { secret, digits: 6, period: 30, algorithm: 'sha1' } : null;
  }
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return null;
  }
  if (u.host.toLowerCase() !== 'totp') return null;
  const secret = base32(u.searchParams.get('secret') ?? '');
  const digits = Number(u.searchParams.get('digits') ?? 6);
  const period = Number(u.searchParams.get('period') ?? 30);
  const algorithm = (u.searchParams.get('algorithm') ?? 'SHA1').toLowerCase();
  if (!secret || ![6, 7, 8].includes(digits) || !Number.isInteger(period) || period < 1 || period > 300) return null;
  if (algorithm !== 'sha1' && algorithm !== 'sha256' && algorithm !== 'sha512') return null;
  return { secret, digits, period, algorithm };
}

/** The code for a moment (now by default), and how many more seconds it is good for. */
export function totpCode(spec: TotpSpec, at = Date.now()): { code: string; remaining: number; period: number } {
  const seconds = Math.floor(at / 1000);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(seconds / spec.period)));
  const mac = createHmac(spec.algorithm, spec.secret).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const n = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** spec.digits;
  return { code: String(n).padStart(spec.digits, '0'), remaining: spec.period - (seconds % spec.period), period: spec.period };
}
