#!/usr/bin/env node
/**
 * Builds the FBRX Server bundle on Linux, macOS or Windows: FBRX Virtual (server + web console), the FBRX core for the
 * "ai" role, the installer, the fbrx-server command and the systemd units.
 *
 *   node scripts/server/bundle.mjs               → dist/fbrx-server-<version>/ and dist/fbrx-server-<version>.tar.gz
 *   node scripts/server/bundle.mjs --with-node   also packs Node.js for Linux (the ISO installs without reaching nodejs.org)
 *   node scripts/server/bundle.mjs --skip-build  uses the FBRX Virtual build already in apps/virtual/dist
 *
 * The archive is written here (not with a tar program) so that install.sh and fbrx-server stay executable even when
 * the bundle is made on Windows.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
for (const a of args) if (!['--with-node', '--skip-build'].includes(a)) fail(`Unknown option ${a}`);
const WITH_NODE = args.includes('--with-node');
const SKIP_BUILD = args.includes('--skip-build');

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

/** Runs a Node.js script with this same Node.js (no npm needed: the setup wizard brings its own private Node.js). */
function node(script, scriptArgs, cwd = ROOT) {
  const r = spawnSync(process.execPath, [script, ...scriptArgs], { cwd, stdio: 'inherit' });
  if (r.status !== 0) fail(`${script} ${scriptArgs.join(' ')} failed`);
}

const VERSION = JSON.parse(readFileSync(join(ROOT, 'apps/virtual/package.json'), 'utf8')).version;
const NAME = `fbrx-server-${VERSION}`;
const DIST = join(ROOT, 'dist');
const OUT = join(DIST, NAME);
const VDIST = join(ROOT, 'apps/virtual/dist');

if (!SKIP_BUILD) {
  // The same as npm run build in apps/virtual-console (vite build) and apps/virtual (node build.mjs).
  node(join(ROOT, 'node_modules/vite/bin/vite.js'), ['build'], join(ROOT, 'apps/virtual-console'));
  node('build.mjs', [], join(ROOT, 'apps/virtual'));
}
if (!existsSync(join(VDIST, 'server.mjs')) || !existsSync(join(VDIST, 'virtual-console/index.html'))) fail('Build FBRX Virtual and its console first');

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'fbrx-virtual'), { recursive: true });
for (const f of ['server.mjs', 'cli.mjs', 'package.json']) cpSync(join(VDIST, f), join(OUT, 'fbrx-virtual', f));
cpSync(join(VDIST, 'virtual-console'), join(OUT, 'fbrx-virtual/virtual-console'), { recursive: true, filter: (src) => !src.endsWith('.map') });
// The FBRX core (ai role): the agent, FBRX Mesh and Mesh Assist, headless.
node(join(ROOT, 'scripts/server/build-core.mjs'), [join(OUT, 'fbrx-core')]);
for (const f of ['install.sh', 'fbrx-server', 'fbrx-virtual.service', 'fbrx-core.service']) cpSync(join(ROOT, 'scripts/server', f), join(OUT, f));
writeFileSync(join(OUT, 'VERSION'), `${VERSION}\n`);
const EXECUTABLE = new Set(['install.sh', 'fbrx-server']);
if (process.platform !== 'win32') for (const f of EXECUTABLE) chmodSync(join(OUT, f), 0o755);

if (WITH_NODE) {
  const base = 'https://nodejs.org/dist/latest-v22.x';
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const line = sums.split('\n').find((l) => /\snode-v22\.\d+\.\d+-linux-x64\.tar\.xz$/.test(l));
  if (!line) fail('Node.js 22 for Linux was not found on nodejs.org');
  const [sum, file] = line.trim().split(/\s+/);
  const res = await fetch(`${base}/${file}`);
  if (!res.ok) fail(`Downloading ${file} failed (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (createHash('sha256').update(buf).digest('hex') !== sum) fail(`${file} does not match nodejs.org's checksum`);
  writeFileSync(join(OUT, file), buf);
  writeFileSync(join(OUT, `${file}.sha256`), `${line.trim()}\n`);
  console.log(`Packed ${file}`);
}

// ------------------------------------------------------------------------------------------------- tar.gz

/** One ustar header block. */
function header(name, size, mode, type, mtime) {
  const h = Buffer.alloc(512);
  let prefix = '';
  let short = name;
  if (Buffer.byteLength(name) > 100) {
    const i = name.lastIndexOf('/', 154);
    if (i <= 0 || Buffer.byteLength(name.slice(i + 1)) > 100) fail(`Path too long for the archive: ${name}`);
    prefix = name.slice(0, i);
    short = name.slice(i + 1);
  }
  const put = (s, off, len) => h.write(s, off, len, 'utf8');
  const oct = (n, len) => `${n.toString(8).padStart(len - 1, '0')}\0`;
  put(short, 0, 100);
  put(oct(mode, 8), 100, 8);
  put(oct(0, 8), 108, 8);
  put(oct(0, 8), 116, 8);
  put(oct(size, 12), 124, 12);
  put(oct(mtime, 12), 136, 12);
  put('        ', 148, 8);
  put(type, 156, 1);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  put('root', 265, 32);
  put('root', 297, 32);
  put(prefix, 345, 155);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return h;
}

const parts = [];
const mtime = Math.floor(Date.now() / 1000);
function add(abs) {
  const rel = relative(DIST, abs).split(sep).join('/');
  const st = statSync(abs);
  if (st.isDirectory()) {
    parts.push(header(`${rel}/`, 0, 0o755, '5', mtime));
    for (const e of readdirSync(abs).sort()) add(join(abs, e));
    return;
  }
  const data = readFileSync(abs);
  const base = rel.slice(rel.lastIndexOf('/') + 1);
  const mode = rel.split('/').length === 2 && EXECUTABLE.has(base) ? 0o755 : 0o644;
  parts.push(header(rel, data.length, mode, '0', mtime), data);
  const pad = (512 - (data.length % 512)) % 512;
  if (pad) parts.push(Buffer.alloc(pad));
}
add(OUT);
parts.push(Buffer.alloc(1024));
const archive = join(DIST, `${NAME}.tar.gz`);
writeFileSync(archive, gzipSync(Buffer.concat(parts), { level: 9 }));
console.log(`Built dist/${NAME}.tar.gz (${(statSync(archive).size / 1024 / 1024).toFixed(1)} MB)`);
