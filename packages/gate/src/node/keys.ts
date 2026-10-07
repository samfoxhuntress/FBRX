import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';

const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex');

/** A WireGuard key pair (X25519, base64 as wg prints them). */
export function wgKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const d = privateKey.export({ format: 'jwk' }).d!;
  const x = publicKey.export({ format: 'jwk' }).x!;
  return { privateKey: Buffer.from(d, 'base64url').toString('base64'), publicKey: Buffer.from(x, 'base64url').toString('base64') };
}

/** The public key that belongs to a WireGuard private key. */
export function wgPublicKey(privateKey: string): string {
  const raw = Buffer.from(privateKey.trim(), 'base64');
  if (raw.length !== 32) throw new Error('Not a WireGuard private key');
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: 'der', type: 'pkcs8' });
  return Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x!, 'base64url').toString('base64');
}
