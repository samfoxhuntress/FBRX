/**
 * Signs an offline FBRX license key with the private key from `npm run keys:generate`, no FBRX Command needed.
 * Paste the printed key into FBRX Endpoint under Settings → License: Community runs Endpoint Basic, Pro and
 * Enterprise run Endpoint Ultra (or pick one with --tier).
 *
 *   npm run license:issue -- --customer "Acme Ltd" [--edition enterprise|pro|community] [--seats 25]
 *                            [--tier basic|ultra] [--expires 2027-12-31] [--max-major 2]
 *                            [--feature fleet --feature plugins] [--key .fbrx-keys/license-signing.pem]
 *                            [--command-url https://command.example.com --enroll-token fbrx_enr_…]
 *
 * With --command-url and --enroll-token (a token from FBRX Command → Deploy & enroll), computers that activate the
 * key join that tenant on their own.
 *
 * The desktop build must embed the matching public key (keys:generate writes it to
 * apps/desktop/build/license-public-key.pem; rebuild after generating). Offline keys cannot be revoked remotely,
 * so prefer expiry dates for anything you sell.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { ALL_FEATURES, EDITIONS, TIERS, TIER_NAMES, featuresFor, newId, tierFor, type Edition, type LicensePayload, type Tier } from '../packages/shared/src';
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
const tier = opt('--tier') as Tier | undefined;
if (tier && !TIERS.includes(tier)) fail(`--tier must be one of ${TIERS.join(', ')}`);
const commandUrl = opt('--command-url');
const enrollToken = opt('--enroll-token');
if (!!commandUrl !== !!enrollToken) fail('--command-url and --enroll-token go together');
if (commandUrl && !/^https?:\/\//.test(commandUrl)) fail('--command-url must start with https://');
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
  ...(tier ? { tier } : {}),
  ...(commandUrl && enrollToken ? { command: { url: commandUrl, enrollmentToken: enrollToken } } : {}),
};
const key = signLicense(payload, privateKeyPem!);
const check = verifyLicense(key, [publicKeyFromPrivate(privateKeyPem!)]);
if (!check.ok) fail(`Signed key failed verification: ${check.error}`);

console.log(`\n${TIER_NAMES[tierFor(edition, tier)]} · ${customer} · ${edition} · ${seats || 'unlimited'} seat(s) · ${payload.expiresAt ? `expires ${expires}` : 'perpetual'}`);
if (commandUrl) console.log(`Joins the FBRX Command tenant at ${commandUrl}`);
console.log(`Features: ${featuresFor(payload).join(', ')}\n`);
console.log(key);
console.log('\nPaste this into FBRX Endpoint → Settings → License.');
