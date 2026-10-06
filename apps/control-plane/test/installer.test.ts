import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..', '..');

describe('the Windows launchers', () => {
  it('are the same file apart from which product they install', () => {
    const body = (name: string) =>
      readFileSync(join(ROOT, name), 'latin1')
        .split('\r\n')
        .filter((l) => !/^rem |^set "FBRX_(PRODUCT|LAUNCHER|SETUP_SCRIPT)=/.test(l));
    const os = readFileSync(join(ROOT, 'Install FBRX OS.cmd'), 'latin1');
    const command = readFileSync(join(ROOT, 'Install FBRX Command.cmd'), 'latin1');
    // Windows batch files need CRLF line endings.
    expect(os.replace(/\r\n/g, '')).not.toContain('\n');
    expect(command.replace(/\r\n/g, '')).not.toContain('\n');
    expect(body('Install FBRX Command.cmd')).toEqual(body('Install FBRX OS.cmd'));
    expect(command).toContain('set "FBRX_SETUP_SCRIPT=scripts\\setup\\command.mjs"');
    expect(os).toContain('set "FBRX_SETUP_SCRIPT=scripts\\setup\\wizard.mjs"');
  });
});

/** The launcher installed next to FBRX Command: start, status, stop and open, here with a stand-in server. */
describe('the FBRX Command launcher', () => {
  // The real path: on macOS the temp folder is reached through a link (/var → /private/var).
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'fbrx-command-home-')));
  const app = join(home, 'app');
  const launcher = join(app, 'launcher.mjs');
  const run = (action: string) => spawnSync(process.execPath, [launcher, action], { encoding: 'utf8', timeout: 60_000 });

  afterAll(() => {
    run('stop');
    rmSync(home, { recursive: true, force: true });
  });

  it('starts FBRX Command in the background, reports it, and stops it', async () => {
    const port = await new Promise<number>((r) => {
      const s = createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as { port: number }).port;
        s.close(() => r(p));
      });
    });
    mkdirSync(app, { recursive: true });
    copyFileSync(join(ROOT, 'scripts', 'setup', 'command-launcher.mjs'), launcher);
    // A stand-in for server.mjs that answers like FBRX Command and records the settings it was started with.
    writeFileSync(
      join(app, 'server.mjs'),
      `import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(home, 'env.json'))}, JSON.stringify(process.env));
createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(req.url === '/healthz' ? { ok: true, version: '9.9.9' } : { needsSetup: true }));
}).listen(Number(process.env.FBRX_CP_PORT), process.env.FBRX_CP_HOST);
process.on('SIGTERM', () => process.exit(0));
`,
    );
    writeFileSync(join(app, 'install.json'), JSON.stringify({ home }));
    writeFileSync(join(home, 'config.json'), JSON.stringify({ mode: 'local', port, localPort: null, publicUrl: `http://localhost:${port}`, setupToken: 'tok-123' }));

    expect(run('start').status).toBe(0);
    const status = JSON.parse(run('status').stdout);
    expect(status).toMatchObject({ running: true, version: '9.9.9', needsSetup: true, local: `http://127.0.0.1:${port}`, network: null });
    const env = JSON.parse(readFileSync(join(home, 'env.json'), 'utf8'));
    expect(env).toMatchObject({ FBRX_CP_DATA_DIR: join(home, 'data'), FBRX_CP_HOST: '127.0.0.1', FBRX_CP_PORT: String(port), FBRX_CP_SETUP_TOKEN: 'tok-123', FBRX_ADMIN_CONSOLE_DIR: join(app, 'admin-console') });
    expect(env.FBRX_CP_TLS).toBeUndefined();

    expect(run('stop').status).toBe(0);
    expect(JSON.parse(run('status').stdout).running).toBe(false);
  });
});
