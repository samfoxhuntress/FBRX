// Builds the desktop app: main (ESM) + preload (CJS) with esbuild, renderer with Vite, icons and the plugin worker.
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(app, '..', '..');
const watch = process.argv.includes('--watch');
const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));

// Trusted license-signing public keys are compiled in so licenses cannot be forged with a private server.
const keys = [];
if (process.env.FBRX_LICENSE_PUBLIC_KEY) keys.push(process.env.FBRX_LICENSE_PUBLIC_KEY.replace(/\\n/g, '\n'));
const keyFile = join(app, 'build', 'license-public-key.pem');
if (existsSync(keyFile)) keys.push(readFileSync(keyFile, 'utf8'));
if (!keys.length) console.warn('⚠ No license public key embedded (set FBRX_LICENSE_PUBLIC_KEY or add build/license-public-key.pem). Packaged builds will run as Community edition unless enrolled.');

if (!watch) rmSync(join(app, 'dist'), { recursive: true, force: true });
mkdirSync(join(app, 'dist', 'main'), { recursive: true });
execFileSync(process.execPath, [join(app, 'scripts', 'make-icons.mjs')], { stdio: 'inherit' });

const common = { bundle: true, platform: 'node', target: 'node22', sourcemap: true, logLevel: 'info', legalComments: 'none' };
await build({
  ...common,
  entryPoints: [join(app, 'src/main/index.ts')],
  outfile: join(app, 'dist/main/index.mjs'),
  format: 'esm',
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  define: { __FBRX_LICENSE_PUBKEYS__: JSON.stringify(keys), 'process.env.FBRX_APP_VERSION': JSON.stringify(pkg.version) },
  banner: { js: "import { createRequire as __fbrxRequire } from 'node:module'; const require = __fbrxRequire(import.meta.url);" },
});
await build({
  ...common,
  entryPoints: [join(app, 'src/preload/index.ts')],
  outfile: join(app, 'dist/preload/index.cjs'),
  format: 'cjs',
  external: ['electron'],
});
copyFileSync(join(root, 'packages/core/src/plugins/plugin-worker.mjs'), join(app, 'dist/main/plugin-worker.mjs'));

execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--config', join(app, 'vite.config.ts')], { stdio: 'inherit', cwd: app });
console.log(`Built FBRX OS desktop ${pkg.version}`);
