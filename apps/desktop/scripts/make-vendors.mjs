// Builds dist/main/oui-vendors.tsv.gz, the IEEE MAC vendor registry (MA-L, MA-M, MA-S and IAB blocks) that ships with
// FBRX OS, from the oui-data package (the IEEE lists as JSON). Format: see packages/core/src/network/vendors.ts.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const data = JSON.parse(readFileSync(require.resolve('oui-data'), 'utf8'));

/** Same tidy-up as the app: "XEROX CORPORATION" → "Xerox Corporation". */
const tidy = (name) => {
  const n = name.replace(/\s+/g, ' ').trim();
  return /[a-z]/.test(n) ? n : n.replace(/[A-Z][A-Z0-9&'.-]*/g, (w) => (w.length <= 3 ? w : w[0] + w.slice(1).toLowerCase()));
};

const lines = [`# ${new Date().toISOString().slice(0, 10)}`];
for (const [prefix, value] of Object.entries(data)) {
  const org = String(value).split('\n')[0];
  if (/^[0-9A-F]{6,9}$/i.test(prefix) && org) lines.push(`${prefix.toUpperCase()}\t${tidy(org).replace(/\t/g, ' ')}`);
}
const out = join(app, 'dist', 'main', 'oui-vendors.tsv.gz');
mkdirSync(dirname(out), { recursive: true });
const gz = gzipSync(lines.join('\n'), { level: 9 });
writeFileSync(out, gz);
console.log(`MAC vendor registry: ${lines.length - 1} blocks, ${(gz.length / 1024).toFixed(0)} KB`);
