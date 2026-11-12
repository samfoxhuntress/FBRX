// Bundles the control plane into a single ESM file (no native modules → runs on any Node 22.13+ host).
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
// FBRX Command carries the version of the FBRX release it is built from (the same as FBRX OS).
const version = process.env.FBRX_CP_VERSION ?? JSON.parse(readFileSync(join(here, '../desktop/package.json'), 'utf8')).version ?? pkg.version;
mkdirSync(join(here, 'dist'), { recursive: true });
await build({
  entryPoints: [join(here, 'src/main.ts')],
  outfile: join(here, 'dist/server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  legalComments: 'none',
  define: { 'process.env.FBRX_CP_VERSION': JSON.stringify(version) },
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
const consoleDist = join(here, '../admin-console/dist');
if (existsSync(join(consoleDist, 'index.html'))) {
  cpSync(consoleDist, join(here, 'dist/admin-console'), { recursive: true });
  console.log('Bundled admin console into dist/admin-console');
}
writeFileSync(join(here, 'dist/package.json'), JSON.stringify({ name: 'fbrx-control-plane', version, type: 'module', private: true }, null, 2));
console.log(`Built control plane ${version} → dist/server.mjs`);
