// Development: Vite dev server for the renderer + Electron pointed at it.
import { spawn, execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const root = join(app, '..', '..');
execFileSync(process.execPath, [join(app, 'scripts/build.mjs')], { stdio: 'inherit', env: { ...process.env, FBRX_SKIP_RENDERER: '1' } });
const vite = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--config', join(app, 'vite.config.ts'), '--port', '5175', '--strictPort'], { cwd: app, stdio: 'inherit' });
setTimeout(() => {
  const electron = spawn(join(root, 'node_modules/.bin/electron'), ['.'], { cwd: app, stdio: 'inherit', env: { ...process.env, FBRX_RENDERER_URL: 'http://localhost:5175/', FBRX_DEV_MODE: '1' } });
  electron.on('exit', () => {
    vite.kill();
    process.exit(0);
  });
}, 2500);
