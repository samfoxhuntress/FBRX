#!/usr/bin/env node
/**
 * Packs an FBRX OS plugin folder into an installable .tgz.
 *
 *   node scripts/pack-plugin.mjs <plugin dir> [--out <dir>] [--bundle]
 *
 * The package can be installed from the desktop app (Tools → Install plugin), pushed to a whole fleet from the
 * admin console (Plugins → Upload plugin, then Deploy), or through the Local API (plugins.install).
 *
 * --bundle (implied when `main` is TypeScript) bundles the entry point and its npm dependencies into a single
 * index.mjs with esbuild, so the plugin needs no node_modules on the target machine. Without it, the files listed
 * in package.json "files" are packed (or the whole folder minus build/test clutter when there is no list).
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import * as tar from 'tar';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const dir = resolve(args.find((a, i) => !a.startsWith('--') && !['--out'].includes(args[i - 1])) ?? '.');
const outDir = resolve(opt('--out') ?? join(dir, 'dist-plugin'));

const fail = (msg) => {
  console.error(`✖ ${msg}`);
  process.exit(1);
};

const manifestPath = join(dir, 'fbrx-plugin.json');
if (!existsSync(manifestPath)) fail(`No fbrx-plugin.json in ${dir}`);
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (err) {
  fail(`fbrx-plugin.json is not valid JSON: ${err.message}`);
}

// Mirrors validateManifest() in @fbrx/plugin-sdk so problems surface before the package is shipped.
const errors = [];
if (!/^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(manifest.id ?? '')) errors.push('id must be reverse-DNS, e.g. com.acme.weather');
if (!manifest.name) errors.push('name is required');
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(manifest.version ?? '')) errors.push('version must be semver');
if (!/^[a-z][a-z0-9_]{1,31}$/.test(manifest.namespace ?? '')) errors.push('namespace must match [a-z][a-z0-9_]{1,31}');
if (!manifest.main) errors.push('main is required');
if (manifest.permissions && !Array.isArray(manifest.permissions)) errors.push('permissions must be an array');
if (errors.length) fail(`Invalid manifest:\n  - ${errors.join('\n  - ')}`);
if (!existsSync(join(dir, manifest.main))) fail(`Entry file ${manifest.main} not found`);

const bundle = args.includes('--bundle') || /\.(c|m)?tsx?$/.test(manifest.main);
const staging = mkdtempSync(join(tmpdir(), 'fbrx-pack-'));
const pkgRoot = join(staging, 'package');
mkdirSync(pkgRoot);

const IGNORE = new Set(['node_modules', '.git', 'dist-plugin', 'test', 'tests', '__tests__', '.DS_Store', 'package-lock.json', 'tsconfig.json']);
try {
  if (bundle) {
    const { build } = await import('esbuild');
    await build({
      entryPoints: [join(dir, manifest.main)],
      outfile: join(pkgRoot, 'index.mjs'),
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      // CommonJS dependencies may call require(); give the ESM bundle one.
      banner: { js: "import { createRequire as __fbrxCreateRequire } from 'node:module'; const require = __fbrxCreateRequire(import.meta.url);" },
      logLevel: 'warning',
    });
    manifest.main = 'index.mjs';
    for (const extra of ['README.md', 'LICENSE', 'assets']) if (existsSync(join(dir, extra))) cpSync(join(dir, extra), join(pkgRoot, extra), { recursive: true });
  } else {
    const pkgJson = existsSync(join(dir, 'package.json')) ? JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) : {};
    const listed = Array.isArray(pkgJson.files) ? pkgJson.files : null;
    const entries = listed ? [...new Set([...listed, manifest.main, 'package.json', 'README.md', 'LICENSE'])] : readdirSync(dir).filter((n) => !IGNORE.has(n) && !n.endsWith('.tgz'));
    for (const e of entries) {
      const src = join(dir, e);
      if (!existsSync(src) || relative(dir, src).startsWith('..')) continue;
      cpSync(src, join(pkgRoot, e), { recursive: true, filter: (p) => !IGNORE.has(basename(p)) });
    }
    if (pkgJson.dependencies && Object.keys(pkgJson.dependencies).length && !existsSync(join(pkgRoot, 'node_modules')))
      console.warn('⚠ package.json declares dependencies but node_modules is not packed. Re-run with --bundle so the plugin works on machines without them.');
  }
  writeFileSync(join(pkgRoot, 'fbrx-plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`);

  mkdirSync(outDir, { recursive: true });
  const outFile = join(outDir, `${manifest.id}-${manifest.version}.tgz`);
  await tar.c({ gzip: true, file: outFile, cwd: staging, portable: true, noMtime: true }, ['package']);
  const data = readFileSync(outFile);
  const sha256 = createHash('sha256').update(data).digest('hex');
  console.log(`✔ ${manifest.name} ${manifest.version} (${manifest.id})`);
  console.log(`  ${relative(process.cwd(), outFile)}  ${(statSync(outFile).size / 1024).toFixed(1)} KB${bundle ? '  [bundled]' : ''}`);
  console.log(`  sha256 ${sha256}`);
  console.log(`  permissions: ${(manifest.permissions ?? []).join(', ') || 'none'}`);
} finally {
  rmSync(staging, { recursive: true, force: true });
}
