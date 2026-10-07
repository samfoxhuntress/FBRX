// Bundles FBRX Virtual into a single ESM file (runs on any Node 22.13+ server; FBRX Server ships its own Node).
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, 'package.json'), 'utf8'));
mkdirSync(join(here, 'dist'), { recursive: true });
const common = {
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  legalComments: 'none',
  define: { 'process.env.FBRX_V_VERSION': JSON.stringify(process.env.FBRX_V_VERSION ?? pkg.version) },
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
};
await build({ ...common, entryPoints: [join(here, 'src/main.ts')], outfile: join(here, 'dist/server.mjs') });
// Helpers run on the server itself (fbrx-server reset-password …).
await build({ ...common, entryPoints: [join(here, 'src/cli.ts')], outfile: join(here, 'dist/cli.mjs'), sourcemap: false });
// FBRX Gate's command line (fbrx-gate), for the gate role.
await build({ ...common, entryPoints: [join(here, 'src/gate-cli.ts')], outfile: join(here, 'dist/gate-cli.mjs'), sourcemap: false });
const consoleDist = join(here, '../virtual-console/dist');
if (existsSync(join(consoleDist, 'index.html'))) {
  cpSync(consoleDist, join(here, 'dist/virtual-console'), { recursive: true });
  console.log('Bundled the FBRX Virtual console into dist/virtual-console');
}
writeFileSync(join(here, 'dist/package.json'), JSON.stringify({ name: 'fbrx-virtual', version: pkg.version, type: 'module', private: true }, null, 2));
console.log(`Built FBRX Virtual ${pkg.version} → dist/server.mjs`);
