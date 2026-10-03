// Builds the desktop app: main (ESM) + preload (CJS) with esbuild, renderer with Vite, icons and the plugin worker.
import { build } from 'esbuild';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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
execFileSync(process.execPath, [join(app, 'scripts', 'make-vendors.mjs')], { stdio: 'inherit' });

const ESM_BANNER = "import { createRequire as __fbrxRequire } from 'node:module'; import { fileURLToPath as __fbrxPath } from 'node:url'; const require = __fbrxRequire(import.meta.url); const __filename = __fbrxPath(import.meta.url); const __dirname = __fbrxPath(new URL('.', import.meta.url));";
const common = { bundle: true, platform: 'node', target: 'node22', sourcemap: true, logLevel: 'info', legalComments: 'none' };
await build({
  ...common,
  entryPoints: [join(app, 'src/main/index.ts')],
  outfile: join(app, 'dist/main/index.mjs'),
  format: 'esm',
  // ssh2's optional native speed-ups: without them it uses its pure-JavaScript code.
  external: ['electron', 'bufferutil', 'utf-8-validate', 'cpu-features', '*.node'],
  define: { __FBRX_LICENSE_PUBKEYS__: JSON.stringify(keys), 'process.env.FBRX_APP_VERSION': JSON.stringify(pkg.version) },
  // CommonJS dependencies (ssh2 among them) expect require, __filename and __dirname.
  banner: { js: ESM_BANNER },
});
await build({
  ...common,
  entryPoints: [join(app, 'src/preload/index.ts')],
  outfile: join(app, 'dist/preload/index.cjs'),
  format: 'cjs',
  external: ['electron'],
});
copyFileSync(join(root, 'packages/core/src/plugins/plugin-worker.mjs'), join(app, 'dist/main/plugin-worker.mjs'));
// MCP bridge for other AI apps: a self-contained Node script run by the app executable (ELECTRON_RUN_AS_NODE).
await build({
  ...common,
  entryPoints: [join(root, 'packages/core/src/aicoord/mcp-shim.ts')],
  outfile: join(app, 'dist/main/fbrx-mcp.mjs'),
  format: 'esm',
  // CommonJS dependencies (ssh2 among them) expect require, __filename and __dirname.
  banner: { js: ESM_BANNER },
});
// FBRX Mobile (phone web app) plus the NaCl library it uses for end-to-end encryption.
const mobileOut = join(app, 'dist/main/mobile');
mkdirSync(mobileOut, { recursive: true });
const mobileSrc = join(root, 'packages/core/mobile');
for (const f of readdirSync(mobileSrc)) copyFileSync(join(mobileSrc, f), join(mobileOut, f));
copyFileSync(join(root, 'node_modules/tweetnacl/nacl-fast.min.js'), join(mobileOut, 'nacl.min.js'));
copyFileSync(join(app, 'build', 'icon.png'), join(mobileOut, 'icon.png'));

// Voice input's speech engine (ONNX Runtime for WebAssembly), served to the app from fbrx-voice://ort/ so nothing
// is fetched from a CDN. It must be the exact build the bundled transformers.js expects.
const ortOut = join(app, 'dist/ort');
mkdirSync(ortOut, { recursive: true });
for (const f of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) copyFileSync(join(root, 'node_modules/onnxruntime-web/dist', f), join(ortOut, f));
// The natural voices' pronunciation dictionary (CMU dictionary in Kokoro phonemes, from HeadTTS), served from
// fbrx-voice://assets/.
const voiceAssets = join(app, 'dist/voice-assets');
mkdirSync(voiceAssets, { recursive: true });
copyFileSync(join(app, 'src/renderer/voice/kokoro/en-us.txt.gz'), join(voiceAssets, 'en-us.txt.gz'));

execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build', '--config', join(app, 'vite.config.ts')], { stdio: 'inherit', cwd: app });
// Vite also emits ONNX Runtime's wasm next to the worker; the worker loads it from fbrx-voice://ort/ instead.
const assets = join(app, 'dist/renderer/assets');
for (const f of readdirSync(assets)) if (/^ort-wasm.*\.wasm$/.test(f)) rmSync(join(assets, f));
console.log(`Built FBRX OS desktop ${pkg.version}`);
