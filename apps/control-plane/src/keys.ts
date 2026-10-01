import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { generateSigningKeyPair, publicKeyFromPrivate } from '@fbrx/shared/node';

export interface Keys {
  /** HMAC key for admin session JWTs. */
  jwt: Uint8Array;
  /** AES-256 key encrypting secrets, MFA seeds and webhook secrets at rest. */
  master: Buffer;
  /** Ed25519 key that signs customer licenses. Its public half is embedded in desktop builds. */
  licensePrivatePem: string;
  licensePublicPem: string;
}

function readOrCreate(file: string, create: () => string): string {
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const v = create();
  writeFileSync(file, v, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    /* windows */
  }
  return v;
}

/**
 * Loads (or creates on first boot) the control plane's key material under `<data>/keys`. Environment
 * variables take precedence so keys can come from a secrets manager in production.
 */
export function loadKeys(dataDir: string, env: NodeJS.ProcessEnv = process.env): Keys {
  const dir = join(dataDir, 'keys');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const jwt = Buffer.from(env.FBRX_CP_JWT_SECRET ?? readOrCreate(join(dir, 'jwt.key'), () => randomBytes(64).toString('base64')), 'base64');
  const master = Buffer.from(env.FBRX_CP_MASTER_KEY ?? readOrCreate(join(dir, 'master.key'), () => randomBytes(32).toString('base64')), 'base64');
  if (master.length !== 32) throw new Error('FBRX_CP_MASTER_KEY must be 32 bytes, base64-encoded');
  const licensePrivatePem = (env.FBRX_LICENSE_PRIVATE_KEY?.replace(/\\n/g, '\n') ?? readOrCreate(join(dir, 'license-signing.pem'), () => generateSigningKeyPair().privateKeyPem)).trim() + '\n';
  return { jwt, master, licensePrivatePem, licensePublicPem: publicKeyFromPrivate(licensePrivatePem) };
}
