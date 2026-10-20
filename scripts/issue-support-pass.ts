/**
 * Signs an FBRX **support pass** with the same private key as `npm run license:issue`, no FBRX Command needed. A
 * support pass lets an FBRX support engineer get full access to one computer's FBRX apps for troubleshooting: it is
 * tied to that computer's install id and runs out on its own. Paste the printed pass into the computer after typing
 * `418teapotadmin` (in a license box, Spotlight, FBRX/1, or the browser's address bar). The resume phrase
 * `refusetobrew`, or the pass expiring, puts the computer back to what it was.
 *
 *   npm run support:pass -- --install-id <the computer's install id> [--hours 4] [--tier blackhole|ultra|basic]
 *                           [--note "Ticket 1234"] [--by name@fbrx] [--key .fbrx-keys/license-signing.pem]
 *
 * Find the install id on the computer: Settings → License shows it, or the FBRX/1 command `show system` prints it.
 * Keep passes short; they cannot be revoked once signed, only wait out.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { LICENSE_TIERS, SUPPORT_PASS_MAX_HOURS, TIER_NAMES, type SupportPass } from '../packages/shared/src';
import { signSupportPass, verifySupportPass, publicKeyFromPrivate } from '../packages/shared/src/node';

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const fail = (msg: string): never => {
  console.error(msg);
  process.exit(2);
};

const installId = opt('--install-id') ?? fail('Usage: npm run support:pass -- --install-id <id> [--hours 4] [--tier blackhole] [--note "..."] [--by you@fbrx]');
const hours = Number(opt('--hours') ?? 4);
if (!Number.isInteger(hours) || hours < 1 || hours > SUPPORT_PASS_MAX_HOURS) fail(`--hours must be a whole number from 1 to ${SUPPORT_PASS_MAX_HOURS}`);
const tier = (opt('--tier') ?? 'blackhole') as (typeof LICENSE_TIERS)[number];
if (!LICENSE_TIERS.includes(tier)) fail(`--tier must be one of ${LICENSE_TIERS.join(', ')}`);
const note = opt('--note') ?? '';
const issuedBy = opt('--by') ?? 'FBRX support';

const keyFile = resolve(opt('--key') ?? [resolve('.fbrx-keys/license-signing.pem'), join(homedir(), '.fbrx-keys', 'license-signing.pem')].find((f) => existsSync(f)) ?? '.fbrx-keys/license-signing.pem');
let privateKeyPem: string;
try {
  privateKeyPem = readFileSync(keyFile, 'utf8');
} catch {
  fail(`Could not read the signing key at ${keyFile}. Run "npm run keys:generate" first, or pass --key.`);
}

const now = Date.now();
const payload: SupportPass = {
  v: 1,
  installId,
  tier,
  scope: 'endpoint',
  note: note.slice(0, 200),
  issuedBy: issuedBy.slice(0, 200),
  issuedAt: new Date(now).toISOString(),
  expiresAt: new Date(now + hours * 3_600_000).toISOString(),
};
const pass = signSupportPass(payload, privateKeyPem!);
// Prove it verifies against the matching public key before handing it over.
const check = verifySupportPass(pass, [publicKeyFromPrivate(privateKeyPem!)]);
if (!check.ok) fail(`Internal error: the pass did not verify (${check.error}).`);

console.log(`\nSupport pass for computer ${installId}`);
console.log(`Runs as ${TIER_NAMES[tier]} for ${hours} hour(s), until ${payload.expiresAt}`);
if (note) console.log(`Note: ${note}`);
console.log('\nGive this to the computer after typing 418teapotadmin:\n');
console.log(pass);
console.log('\nOn the computer, "refusetobrew" ends support early; otherwise it ends on its own.\n');
