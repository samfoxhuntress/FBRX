/**
 * Signs an offline FBRX license key with the private key from `npm run keys:generate`, no FBRX Command needed.
 * Paste the printed key into FBRX Endpoint under Settings → License. --edition is the most it unlocks (Pro, Ultra, or
 * Black Hole Edition, which works only in an organization's FBRX Command); like FBRX Command's, the key carries every
 * service, and the edition decides what people see.
 *
 *   npm run license:issue -- --customer "Acme Ltd" [--edition pro|ultra|black-hole-edition] [--seats 25]
 *                            [--vertical education|home] [--expires 2027-12-31] [--max-major 2]
 *                            [--key .fbrx-keys/license-signing.pem]
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
import { LICENSE_TIERS, TIER_NAMES, featuresFor, newId, parseTier, type LicensePayload, type Tier } from '../packages/shared/src';
import { publicKeyFromPrivate, signLicense, verifyLicense } from '../packages/shared/src/node';

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(2);
};

const customer = opt('--customer') ?? fail('Usage: npm run license:issue -- --customer "Name" [--edition pro|ultra|black-hole-edition] [--seats 0] [--expires YYYY-MM-DD]');
// --tier is the older spelling of --edition (basic is Pro).
const wanted = opt('--edition') ?? opt('--tier') ?? 'ultra';
const tier = parseTier(wanted) as (typeof LICENSE_TIERS)[number] | null;
if (!tier || !LICENSE_TIERS.includes(tier)) fail(`--edition must be pro, ultra or black-hole-edition (not ${wanted})`);
const edition = 'enterprise' as const;
const seats = Number(opt('--seats') ?? 0);
if (!Number.isInteger(seats) || seats < 0) fail('--seats must be a whole number (0 = not counted)');
const expires = opt('--expires');
const expiresAt = expires ? new Date(`${expires}T23:59:59Z`) : null;
if (expiresAt && Number.isNaN(expiresAt.getTime())) fail('--expires must be a date like 2027-12-31');
const maxMajor = opt('--max-major');
const vertical = opt('--vertical') as 'education' | 'home' | undefined;
if (vertical && !['education', 'home'].includes(vertical)) fail('--vertical must be education or home');
const commandUrl = opt('--command-url');
const enrollToken = opt('--enroll-token');
if (!!commandUrl !== !!enrollToken) fail('--command-url and --enroll-token go together');
if (commandUrl && !/^https?:\/\//.test(commandUrl)) fail('--command-url must start with https://');
if (argv.includes('--feature')) fail('--feature is gone: every key carries every service, and --edition decides what people see');
const features: string[] = [];

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
  tier: tier!,
  ...(vertical ? { vertical } : {}),
  ...(commandUrl && enrollToken ? { command: { url: commandUrl, enrollmentToken: enrollToken } } : {}),
};
const key = signLicense(payload, privateKeyPem!);
const check = verifyLicense(key, [publicKeyFromPrivate(privateKeyPem!)]);
if (!check.ok) fail(`Signed key failed verification: ${check.error}`);

console.log(`\nUp to ${TIER_NAMES[tier as Tier]}${vertical ? ` (${vertical})` : ''} · ${customer} · ${seats ? `${seats} seat(s)` : 'seats not counted'} · ${payload.expiresAt ? `expires ${expires}` : 'perpetual'}`);
if (commandUrl) console.log(`Joins the FBRX Command tenant at ${commandUrl}`);
console.log(`Services: ${featuresFor(payload).join(', ')}\n`);
console.log(key);
console.log('\nPaste this into FBRX Endpoint → Settings → License.');
