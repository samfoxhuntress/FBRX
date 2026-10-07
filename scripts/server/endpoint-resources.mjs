#!/usr/bin/env node
/**
 * Gathers the FBRX Server resources that ship inside the FBRX Endpoint installer (for now, until they have their own
 * download page): the FBRX Server ISO, the server bundle for a Debian 13 server you already have, and the guides.
 * The desktop app lists them under FBRX Server, and the installers carry them (macOS and Linux as app resources,
 * Windows Setup once for both processor types; see apps/desktop/build/installer.nsh).
 *
 *   node scripts/server/endpoint-resources.mjs [--iso <file.iso | artifact.zip>] [--no-iso] [--out <dir>]
 *
 * The ISO is taken from --iso, $FBRX_SERVER_ISO, dist/fbrx-server-*-amd64.iso (scripts/server/build-iso.sh), or the
 * "fbrx-server-iso" download from GitHub Actions in your Downloads folder (the zip as downloaded, or unpacked). Without
 * one, everything else is still gathered and the app says where to get the ISO. The bundle is built when missing.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (n) => {
  const i = args.indexOf(n);
  return i === -1 ? undefined : args[i + 1];
};
const OUT = resolve(opt('--out') ?? join(ROOT, 'apps/desktop/resources/server'));
const VERSION = JSON.parse(readFileSync(join(ROOT, 'apps/virtual/package.json'), 'utf8')).version;
const log = (s) => console.log(s);

const sha256 = (file) =>
  new Promise((res, rej) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => res(h.digest('hex')))
      .on('error', rej);
  });

/** Unpacks the .iso out of a GitHub Actions artifact zip with the system's own tools. */
function unzipIso(zip) {
  const dir = mkdtempSync(join(tmpdir(), 'fbrx-iso-'));
  const unzip = ['unzip', ['-o', '-q', zip, '-d', dir]];
  const tries =
    process.platform === 'win32'
      ? [
          // Windows' own tar reads zip files (a tar from Git for Windows earlier on the PATH would not).
          [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dir]],
          ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dir.replace(/'/g, "''")}' -Force`]],
          unzip,
        ]
      : process.platform === 'darwin'
        ? [['tar', ['-xf', zip, '-C', dir]], unzip]
        : [unzip];
  for (const [cmd, a] of tries) {
    if (spawnSync(cmd, a, { stdio: 'ignore' }).status === 0) {
      const iso = readdirSync(dir).find((f) => /^fbrx-server-.*\.iso$/.test(f));
      if (iso) return { iso: join(dir, iso), tmp: dir };
    }
  }
  rmSync(dir, { recursive: true, force: true });
  return null;
}

function findIso() {
  if (args.includes('--no-iso')) return null;
  const given = opt('--iso') ?? process.env.FBRX_SERVER_ISO;
  const candidates = given ? [resolve(given)] : [];
  const dist = join(ROOT, 'dist');
  if (existsSync(dist)) for (const f of readdirSync(dist).sort().reverse()) if (/^fbrx-server-.*-amd64\.iso$/.test(f)) candidates.push(join(dist, f));
  const downloads = join(homedir(), 'Downloads');
  if (existsSync(downloads)) {
    const found = readdirSync(downloads)
      .filter((f) => /^fbrx-server.*\.(iso|zip)$/i.test(f) || f === 'fbrx-server-iso')
      .map((f) => join(downloads, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const f of found) {
      if (statSync(f).isDirectory()) {
        const iso = readdirSync(f).find((x) => /\.iso$/.test(x));
        if (iso) candidates.push(join(f, iso));
      } else candidates.push(f);
    }
  }
  for (const c of candidates) {
    if (!existsSync(c)) continue;
    if (c.endsWith('.zip')) {
      const u = unzipIso(c);
      if (u) return { ...u, from: c };
      log(`  ${basename(c)} has no FBRX Server ISO in it`);
      continue;
    }
    return { iso: c, tmp: null, from: c };
  }
  return null;
}

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) rmSync(join(OUT, f), { recursive: true, force: true });
const files = [];

// The bundle (for a Debian 13 server you already have), built when missing or older than the sources.
const bundle = join(ROOT, 'dist', `fbrx-server-${VERSION}.tar.gz`);
const newest = (dir) => {
  let t = 0;
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === 'dist') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else t = Math.max(t, statSync(p).mtimeMs);
    }
  };
  walk(dir);
  return t;
};
const sources = Math.max(newest(join(ROOT, 'apps/virtual/src')), newest(join(ROOT, 'apps/virtual-console/src')), newest(join(ROOT, 'packages/core/src')), newest(join(ROOT, 'scripts/server')));
if (!existsSync(bundle) || statSync(bundle).mtimeMs < sources) {
  log('Building the FBRX Server bundle');
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/server/bundle.mjs'), '--with-node'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
copyFileSync(bundle, join(OUT, basename(bundle)));
files.push({ name: basename(bundle), kind: 'bundle', title: 'FBRX Server bundle', description: 'For a Debian 13 server you already have: unpack it and run sudo bash install.sh.' });

const found = findIso();
if (found) {
  const name = basename(found.iso);
  log(`Adding ${name} (from ${found.from})`);
  copyFileSync(found.iso, join(OUT, name));
  const expected = [found.iso + '.sha256', join(dirname(found.iso), `${name}.sha256`)].find(existsSync);
  const sum = await sha256(join(OUT, name));
  if (expected) {
    const want = readFileSync(expected, 'utf8').trim().split(/\s+/)[0];
    if (want && want !== sum) {
      console.error(`${name} does not match its checksum file: it was damaged on the way. Download it again.`);
      process.exit(1);
    }
  }
  files.push({ name, kind: 'iso', title: 'FBRX Server installer ISO', description: 'Boot a server from it (USB stick, or the iDRAC virtual CD) and pick Install FBRX Server. It erases the disk you choose.', sha256: sum });
  if (found.tmp) rmSync(found.tmp, { recursive: true, force: true });
} else {
  log('No FBRX Server ISO found: the installer carries the bundle and guides only.');
  log('  To include it, put the "fbrx-server-iso" download from GitHub Actions in your Downloads folder, or pass --iso <file>.');
}

// The guides.
mkdirSync(join(OUT, 'docs'), { recursive: true });
const GUIDES = {
  'SERVER.md': 'FBRX Server and FBRX Virtual',
  'MESH.md': 'FBRX Mesh, Mesh Assist and Prefer Mesh',
  'GATE.md': 'FBRX Gate',
  'MINIDOME.md': 'FBRX MiniDome',
  'LINEUP.md': 'The FBRX lineup',
};
for (const [d, title] of Object.entries(GUIDES)) {
  const src = join(ROOT, 'docs', d);
  if (!existsSync(src)) continue;
  copyFileSync(src, join(OUT, 'docs', d));
  files.push({ name: `docs/${d}`, kind: 'doc', title, description: null });
}

writeFileSync(
  join(OUT, 'README.txt'),
  [
    `FBRX Server ${VERSION} · powered by FBRX OS`,
    '',
    'These came with FBRX Endpoint so you can set up FBRX Server from here.',
    '',
    found
      ? `${basename(found.iso)}\n  The installer for a whole server (it erases the disk you choose). Write it to a USB stick with any image\n  writer, or on a Dell PowerEdge mount it through the iDRAC: Virtual Console > Virtual Media > Map CD/DVD,\n  then boot once from the virtual CD (F11). Pick "Install FBRX Server".`
      : 'No installer ISO is included in this copy. Get it from the "FBRX Server ISO" workflow in GitHub Actions.',
    '',
    `${basename(bundle)}\n  For a Debian 13 server you already have:\n    tar -xzf ${basename(bundle)}\n    sudo bash fbrx-server-${VERSION}/install.sh`,
    '',
    'docs/SERVER.md  everything else: roles, the web console on port 9443, Mesh & AI, Prefer Mesh.',
    '',
  ].join('\n'),
);

for (const f of files) {
  const p = join(OUT, f.name);
  f.size = statSync(p).size;
  f.sha256 ??= await sha256(p);
}
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify({ product: 'FBRX Server', version: VERSION, builtAt: new Date().toISOString(), files }, null, 2));
const total = files.reduce((n, f) => n + f.size, 0);
log(`FBRX Server resources for the Endpoint installer → ${OUT} (${(total / 1024 / 1024).toFixed(0)} MB${found ? ', with the ISO' : ', no ISO'})`);
