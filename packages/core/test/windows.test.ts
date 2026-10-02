import { describe, expect, it } from 'vitest';
import { IS_WIN, ps, psJson, psq, requireWindows } from '../src/windows/ps';
import * as storage from '../src/windows/storage';
import * as security from '../src/windows/security';
import * as troubleshoot from '../src/windows/troubleshoot';
import * as updates from '../src/windows/updates';
import * as lab from '../src/windows/lab';
import { NetDiag } from '../src/network/netdiag';
import { makeKernel, waitFor } from './helpers';
import { EventBus } from '../src/events';
import { TerminalSessions } from '../src/system/files';

// Real PowerShell on a Windows machine (the CI Windows runner). Read-only checks only: nothing here changes the PC.
describe.runIf(IS_WIN)('Windows integration', () => {
  it('passes any text through PowerShell safely', async () => {
    const tricky = `a'b"c $env:USERNAME \`whoami\` ; Write-Output pwned ’ é 中`;
    const r = await ps(`Write-Output ${psq(tricky)}`);
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe(tricky);
    const rows = await psJson<{ n: number }>("1..3 | ForEach-Object { [pscustomobject]@{ n = $_ } }");
    expect(rows.map((x) => x.n)).toEqual([1, 2, 3]);
  });

  it('finds the shells and runs a command in each (PowerShell 7 when installed)', async () => {
    const events = new EventBus();
    const term = new TerminalSessions(events, () => process.env.USERPROFILE!);
    const shells = await term.shells();
    const ids = shells.map((x) => x.id);
    expect(ids).toEqual(expect.arrayContaining(['powershell', 'cmd']));
    expect(shells.find((x) => x.id === 'powershell')!.version).toMatch(/^5\.1\./);
    // GitHub's Windows runners have PowerShell 7: it becomes the default.
    if (ids.includes('pwsh')) expect(shells.find((x) => x.default)!.id).toBe('pwsh');
    const run = async (command: string, shell: 'pwsh' | 'powershell' | 'cmd') => {
      let out = '';
      let code: number | null | undefined;
      const offOut = events.on('terminal.output', (e) => (out += e.text));
      const offExit = events.on('terminal.exit', (e) => (code = e.code));
      await term.run(command, undefined, shell);
      await waitFor(() => code !== undefined, 30_000);
      offOut();
      offExit();
      return { out: out.trim(), code };
    };
    expect(await run('Write-Output $PSVersionTable.PSVersion.Major', 'powershell')).toEqual({ out: '5', code: 0 });
    if (ids.includes('pwsh')) expect(await run('Write-Output $PSVersionTable.PSVersion.Major', 'pwsh')).toEqual({ out: '7', code: 0 });
    expect((await run('echo %OS% & ver', 'cmd')).out).toContain('Windows_NT');
  }, 90_000);

  it('reads drives, cleanup sizes and a folder analysis', async () => {
    const drives = await storage.drives();
    expect(drives.some((d) => d.letter.toUpperCase() === 'C:' && d.size > 0)).toBe(true);
    const clean = await storage.cleanupInfo();
    expect(clean.temp.length).toBeGreaterThan(0);
    expect(typeof clean.recycleBin).toBe('number');
    const usage = await storage.analyzeFolder(process.env.USERPROFILE!, 4000);
    expect(usage.total).toBeGreaterThanOrEqual(0);
  });

  it('reads firewall profiles, listening ports and the startup list', async () => {
    const fw = await security.firewall();
    expect(fw.map((p) => p.name).sort()).toEqual(['Domain', 'Private', 'Public']);
    const ports = await security.listeningPorts();
    expect(ports.length).toBeGreaterThan(0);
    expect(Array.isArray(await security.startupAudit())).toBe(true);
  });

  it('scans the event log and lists repairs', async () => {
    const r = await troubleshoot.bugScan(1);
    expect(r.days).toBe(1);
    expect(Array.isArray(r.events)).toBe(true);
    expect(troubleshoot.fixes().map((f) => f.id)).toContain('sfc');
  }, 180_000);

  it('lists installed updates and virtualization status', async () => {
    expect(Array.isArray(await updates.hotfixes())).toBe(true);
    const st = await lab.labStatus();
    expect(st.edition).toMatch(/Windows/);
  }, 120_000);

  it('reports network adapters and pings the loopback address', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      const net = kernel.net as NetDiag;
      const adapters = await net.adapters();
      expect(adapters.length).toBeGreaterThan(0);
      const p = await net.ping('127.0.0.1', 2);
      expect(p.received).toBe(2);
    } finally {
      await cleanup();
    }
  });
});

describe.runIf(!IS_WIN)('Windows-only features elsewhere', () => {
  it('report that they need Windows', async () => {
    expect(() => requireWindows('Hyper-V')).toThrow(/available on Windows/);
    await expect(security.defenderStatus()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    await expect(lab.labStatus()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect((await troubleshoot.bugScan(1)).events).toEqual([]);
  });
});
