#!/usr/bin/env node
/**
 * Creates the Ed25519 key pair that signs FBRX OS licenses.
 *
 *   npm run keys:generate                       # new key pair
 *   npm run keys:generate -- --from <pem file>  # derive the public key from an existing private key
 *                                               # (e.g. <control-plane data>/keys/license-signing.pem)
 *   options: --out <dir> (default .fbrx-keys)  --force
 *
 * The PRIVATE key belongs only to your control plane (FBRX_LICENSE_PRIVATE_KEY or <data>/keys/license-signing.pem).
 * The PUBLIC key is written to apps/desktop/build/license-public-key.pem and embedded into every desktop build so
 * installed copies can verify licenses offline. Keep the private key out of git and back it up: losing it means
 * every license you issued can no longer be re-issued under the same trust root.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const force = args.includes('--force');
const outDir = resolve(opt('--out') ?? join(root, '.fbrx-keys'));
const from = opt('--from');
const publicOut = join(root, 'apps/desktop/build/license-public-key.pem');

let privatePem;
if (from) {
  privatePem = readFileSync(resolve(from), 'utf8').trim() + '\n';
  const key = createPrivateKey(privatePem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${from} is not an Ed25519 private key`);
} else {
  const privFile = join(outDir, 'license-signing.pem');
  if (existsSync(privFile) && !force) {
    console.error(`${relative(process.cwd(), privFile)} already exists. Re-run with --force to replace it (licenses signed with the old key will stop verifying in new builds).`);
    process.exit(1);
  }
  const { privateKey } = generateKeyPairSync('ed25519');
  privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  writeFileSync(privFile, privatePem, { mode: 0o600 });
  try {
    chmodSync(privFile, 0o600);
  } catch {
    /* windows */
  }
  console.log(`Private key  → ${relative(process.cwd(), privFile)}  (secret: give it only to the control plane)`);
}

const publicPem = createPublicKey(createPrivateKey(privatePem)).export({ type: 'spki', format: 'pem' }).toString();
mkdirSync(dirname(publicOut), { recursive: true });
writeFileSync(publicOut, publicPem);
console.log(`Public key   → ${relative(process.cwd(), publicOut)}  (embedded in desktop builds; safe to commit)`);
console.log(`
Next steps
  1. Control plane: set FBRX_LICENSE_PRIVATE_KEY to the private key (newlines may be written as \\n),
     or copy the file to <FBRX_CP_DATA_DIR>/keys/license-signing.pem before first start.
  2. CI: store the public key as the FBRX_LICENSE_PUBLIC_KEY secret (or commit the .pem above).
  3. Rebuild the desktop app so the new public key is embedded.`);
