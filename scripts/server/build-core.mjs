// Bundles the FBRX core (headless: agent, mesh, Mesh Assist, Local API) for FBRX Server's "ai" role.
//   node scripts/server/build-core.mjs <out-dir>    → <out-dir>/core.mjs, plugin-worker.mjs, mobile/
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(process.argv[2] ?? join(root, 'dist/fbrx-core'));
const version = JSON.parse(readFileSync(join(root, 'apps/desktop/package.json'), 'utf8')).version;
mkdirSync(out, { recursive: true });
await build({
  entryPoints: [join(root, 'packages/core/bin/fbrx-headless.ts')],
  outfile: join(out, 'core.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  legalComments: 'none',
  // ssh2's optional native speed-ups: without them it uses its pure-JavaScript code.
  external: ['electron', 'bufferutil', 'utf-8-validate', 'cpu-features', '*.node'],
  define: { 'process.env.FBRX_APP_VERSION': JSON.stringify(version) },
  banner: {
    js: "import { createRequire as __fbrxRequire } from 'node:module'; import { fileURLToPath as __fbrxPath } from 'node:url'; const require = __fbrxRequire(import.meta.url); const __filename = __fbrxPath(import.meta.url); const __dirname = __fbrxPath(new URL('.', import.meta.url));",
  },
  logLevel: 'warning',
});
copyFileSync(join(root, 'packages/core/src/plugins/plugin-worker.mjs'), join(out, 'plugin-worker.mjs'));
// FBRX Mobile, which the mesh serves to paired phones.
mkdirSync(join(out, 'mobile'), { recursive: true });
for (const f of readdirSync(join(root, 'packages/core/mobile'))) copyFileSync(join(root, 'packages/core/mobile', f), join(out, 'mobile', f));
copyFileSync(join(root, 'node_modules/tweetnacl/nacl-fast.min.js'), join(out, 'mobile', 'nacl.min.js'));
console.log(`Built the FBRX core ${version} for FBRX Server → ${out}`);
