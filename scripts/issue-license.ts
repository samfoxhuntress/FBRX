/**
 * Signs an offline FBRX OS license key with the private key from `npm run keys:generate`, no control plane needed.
 * Paste the printed key into the desktop app under Settings → License.
 *
 *   npm run license:issue -- --customer "Acme Ltd" [--edition enterprise|pro|community] [--seats 25]
 *                            [--expires 2027-12-31] [--max-major 2] [--feature fleet --feature plugins]
 *                            [--key .fbrx-keys/license-signing.pem]
 *
 * The desktop build must embed the matching public key (keys:generate writes it to
 * apps/desktop/build/license-public-key.pem; rebuild after generating). Offline keys cannot be revoked remotely,
 * so prefer expiry dates for anything you sell.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ALL_FEATURES, EDITIONS, featuresFor, newId, type Edition, type LicensePayload } from '../packages/shared/src';
import { publicKeyFromPrivate, signLicense, verifyLicense } from '../packages/shared/src/node';

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const all = (name: string) => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(2);
};

const customer = opt('--customer') ?? fail('Usage: npm run license:issue -- --customer "Name" [--edition enterprise] [--seats 0] [--expires YYYY-MM-DD]');
const edition = (opt('--edition') ?? 'enterprise') as Edition;
if (!EDITIONS.includes(edition)) fail(`--edition must be one of ${EDITIONS.join(', ')}`);
const seats = Number(opt('--seats') ?? 0);
if (!Number.isInteger(seats) || seats < 0) fail('--seats must be a whole number (0 = unlimited)');
const expires = opt('--expires');
const expiresAt = expires ? new Date(`${expires}T23:59:59Z`) : null;
if (expiresAt && Number.isNaN(expiresAt.getTime())) fail('--expires must be a date like 2027-12-31');
const maxMajor = opt('--max-major');
const features = all('--feature');
const unknown = features.filter((f) => !(ALL_FEATURES as string[]).includes(f));
if (unknown.length) fail(`Unknown feature(s): ${unknown.join(', ')}. Known: ${ALL_FEATURES.join(', ')}`);

// The setup wizard keeps a copy in ~/.fbrx-keys, so a fresh copy of the folder can still sign.
const keyFile = resolve(opt('--key') ?? [resolve('.fbrx-keys/license-signing.pem'), join(homedir(), '.fbrx-keys', 'license-signing.pem')].find((f) => existsSync(f)) ?? '.fbrx-keys/license-signing.pem');
let privateKeyPem: string;
try {
  privateKeyPem = readFileSync(keyFile, 'utf8');
} catch {
  fail(`No private key at ${keyFile}. Run "npm run keys:generate" first (or pass --key).`);
}

const payload: LicensePayload = {
  v: 1,
  lid: newId('lic'),
  tenantId: 'offline',
  customer,
  edition,
  seats,
  features,
  issuedAt: new Date().toISOString(),
  expiresAt: expiresAt ? expiresAt.toISOString() : null,
  maxMajorVersion: maxMajor ? Number(maxMajor) : null,
};
const key = signLicense(payload, privateKeyPem!);
const check = verifyLicense(key, [publicKeyFromPrivate(privateKeyPem!)]);
if (!check.ok) fail(`Signed key failed verification: ${check.error}`);

console.log(`\n${customer} · ${edition} · ${seats || 'unlimited'} seat(s) · ${payload.expiresAt ? `expires ${expires}` : 'perpetual'}`);
console.log(`Features: ${featuresFor(payload).join(', ')}\n`);
console.log(key);
console.log('\nPaste this into FBRX OS → Settings → License.');
