import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

type Proc = { pid: number; exe: string; args: string[]; main?: boolean };
type LinuxQuit = {
  appProcesses: () => Proc[];
  runtimeProcesses: (dataRoot?: string) => Proc[];
  quitLinuxApp: (o: { dataRoot?: string; waitMs?: number }) => Promise<{ wasRunning: boolean; left: Proc[] }>;
};

const PYTHON = ['/usr/bin/python3', '/usr/local/bin/python3'].find((p) => existsSync(p));
const dir = mkdtempSync(join(tmpdir(), 'fbrx-quit-'));
const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) c.kill('SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

// Stand-ins for FBRX OS's main process, an Electron helper and the AI runtime: copies of Python under the names the
// real ones have, which write down every signal they get.
const MAIN = `
import signal, subprocess, sys, time
log = sys.argv[1]
note = lambda s: open(log, 'a').write(s + '\\n')
helper = subprocess.Popen([sys.argv[2], '-c', sys.argv[3], log, '--type=renderer'])
def term(*_):
    note('main:TERM')
    helper.send_signal(signal.SIGUSR1)
    helper.wait()
    sys.exit(0)
signal.signal(signal.SIGTERM, term)
note('main:up')
while True: time.sleep(0.05)
`;
const HELPER = `
import signal, sys, time
log = sys.argv[1]
note = lambda s: open(log, 'a').write(s + '\\n')
signal.signal(signal.SIGTERM, lambda *_: note('helper:TERM'))
signal.signal(signal.SIGUSR1, lambda *_: sys.exit(0))
note('helper:up')
while True: time.sleep(0.05)
`;

describe.runIf(process.platform === 'linux' && !!PYTHON)('Closing FBRX OS on Linux', () => {
  it('asks only the main process to quit (not its helpers), finds an arm64 build, and stops a left-behind AI runtime', async () => {
    const lq = (await import(pathToFileURL(join(__dirname, '../../../scripts/setup/linux-quit.mjs')).href)) as LinuxQuit;
    const app = join(dir, 'release', '2.3.3', 'linux-arm64-unpacked');
    mkdirSync(join(app, 'resources', 'runtime'), { recursive: true });
    const exe = join(app, 'fbrx-os');
    const runtime = join(app, 'resources', 'runtime', 'llama-server');
    copyFileSync(PYTHON!, exe);
    copyFileSync(PYTHON!, runtime);
    const log = join(dir, 'signals.log');
    children.push(spawn(exe, ['-c', MAIN, log, exe, HELPER], { stdio: 'ignore' }));
    // The runtime as if FBRX OS had not stopped it.
    children.push(spawn(runtime, ['-c', 'import time; time.sleep(600)'], { stdio: 'ignore' }));
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 50));
      return ok();
    };
    expect(await until(() => existsSync(log) && readFileSync(log, 'utf8').includes('helper:up'))).toBe(true);
    expect(await until(() => lq.runtimeProcesses().length === 1)).toBe(true);

    const found = lq.appProcesses();
    expect(found.map((p) => p.main).sort()).toEqual([false, true]);

    const r = await lq.quitLinuxApp({ waitMs: 3000 });
    expect(r).toEqual({ wasRunning: true, left: [] });
    const signals = readFileSync(log, 'utf8');
    expect(signals).toContain('main:TERM');
    // The helper closed because the main process closed it, not because the uninstaller signalled it.
    expect(signals).not.toContain('helper:TERM');
    expect(lq.runtimeProcesses()).toEqual([]);
    // Nothing running: nothing to do.
    expect(await lq.quitLinuxApp({ waitMs: 500 })).toEqual({ wasRunning: false, left: [] });
  });

  it('is what the installer and the uninstaller use (no pkill -f over every FBRX OS process)', () => {
    const wizard = readFileSync(join(__dirname, '../../../scripts/setup/wizard.mjs'), 'utf8');
    expect(wizard).toContain("from './linux-quit.mjs'");
    expect(wizard).not.toMatch(/pkill['", -9]+-f/);
  });
});
