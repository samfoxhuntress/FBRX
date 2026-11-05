import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeTimeCode, encodeTimeCode } from '@fbrx/shared';
import { ImageBackupService, readStatusFile, removeScript, runnerScript, setupScript, targetProblem, type ImageBackupDeps } from '../src/time/image-backup';

// FBRX Time on a computer: the scheduled task's scripts, and what FBRX makes of the files the task leaves behind.

let dir: string;
let ps: string[];
let elevated: string[];
let audit: Array<[string, string]>;
let psAnswer: { code: number; out: string; err: string };

const service = (platform: NodeJS.Platform = 'win32') =>
  new ImageBackupService({
    platform,
    dir,
    ps: async (script) => (ps.push(script), psAnswer),
    elevated: async (script) => (elevated.push(script), { ok: true, output: /Unregister/.test(script) ? 'removed' : 'set up' }),
    audit: (action, outcome) => audit.push([action, outcome]),
    log: { info: () => {}, warn: () => {} },
  } satisfies ImageBackupDeps);

const writeJob = (job: object) => writeFileSync(join(dir, 'job.json'), '\uFEFF' + JSON.stringify(job));
const writeStatus = (st: object) => writeFileSync(join(dir, 'status.json'), '\uFEFF' + JSON.stringify(st));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fbrx-time-'));
  mkdirSync(dir, { recursive: true });
  ps = [];
  elevated = [];
  audit = [];
  psAnswer = { code: 0, out: 'started', err: '' };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('Where an image may go', () => {
  it('takes another drive or a network folder, never the drive Windows is on', () => {
    expect(targetProblem('E:')).toBeNull();
    expect(targetProblem('e:')).toBeNull();
    expect(targetProblem('C:')).toMatch(/another drive/);
    expect(targetProblem('\\\\nas\\backups')).toBeNull();
    expect(targetProblem('\\\\fbrx-server\\fbrx-time')).toBeNull();
    expect(targetProblem('\\\\nas\\backups\\pcs')).toBeNull();
    expect(targetProblem('E:\\Backups')).toMatch(/drive letter/);
    expect(targetProblem('\\\\nas')).toMatch(/network folder/);
    expect(targetProblem('nas\\share')).toMatch(/drive letter/);
  });
});

describe('The scheduled task', () => {
  it('makes the image Windows can put back, and says how it went', () => {
    const r = runnerScript();
    expect(r).toContain('wbadmin.exe start backup "-backupTarget:$($job.target)" -allCritical "-include:$($env:SystemDrive)" -quiet');
    expect(r).toContain('wbadmin.exe get versions');
    expect(r).toContain("Save @{ state = 'running'");
    expect(r).toMatch(/net\.exe use \$job\.target \$pw "\/user:\$\(\$job\.user\)" \/persistent:no/);
    expect(r).toContain('/delete /y');
  });

  it('runs as the system on its schedule, catches up, and lets the people here start it', () => {
    const s = setupScript({ target: '\\\\nas\\backups', user: 'NAS\\backup', schedule: 'weekly', time: '21:30', day: 5 }, "it's secret");
    expect(s).toContain("New-ScheduledTaskTrigger -Weekly -DaysOfWeek Friday -At '21:30'");
    expect(s).toContain("New-ScheduledTaskPrincipal -UserId 'SYSTEM'");
    expect(s).toContain('-StartWhenAvailable');
    expect(s).toContain('-MultipleInstances IgnoreNew');
    expect(s).toContain("TaskPath = '\\FBRX\\'; TaskName = 'Image backup'");
    expect(s).toContain('(A;;GRGX;;;AU)');
    // The password: in a file only the system and administrators can read, quoted for PowerShell.
    expect(s).toContain("Set-Content -Path $secret -Value 'it''s secret' -NoNewline");
    expect(s).toContain('SetAccessRuleProtection($true, $false)');
    expect(s).toContain("'NT AUTHORITY\\SYSTEM', 'BUILTIN\\Administrators'");
    expect(s).toContain('"user":"NAS\\\\backup"');

    const daily = setupScript({ target: 'E:', user: '', schedule: 'daily', time: '02:00', day: 0 }, null);
    expect(daily).toContain("New-ScheduledTaskTrigger -Daily -At '02:00'");
    expect(daily).toContain('Remove-Item -Force -ErrorAction SilentlyContinue $secret');

    const byHand = setupScript({ target: 'E:', user: '', schedule: 'off', time: '12:00', day: 0 }, undefined);
    expect(byHand).toContain('$trigger = $null');
    expect(byHand).not.toContain('$secret -Value');
    expect(byHand).not.toContain('Remove-Item -Force -ErrorAction SilentlyContinue $secret');
    expect(removeScript()).toContain("Unregister-ScheduledTask -TaskPath '\\FBRX\\' -TaskName 'Image backup'");
  });

  it('reads what PowerShell wrote, byte-order mark and all', () => {
    expect(readStatusFile('\uFEFF{"state":"done","ok":true}')).toEqual({ state: 'done', ok: true });
    expect(readStatusFile('half a file {')).toBeNull();
  });
});

describe('Image backups on this computer', () => {
  it('are made on Windows', async () => {
    const s = service('darwin');
    expect(s.status()).toMatchObject({ supported: false, reason: expect.stringContaining('Windows'), configured: false });
    expect(s.summary()).toBeNull();
    await expect(s.run('user')).rejects.toThrow(/Windows/);
  });

  it('are set up once, as administrator, with what makes sense', async () => {
    const s = service();
    expect(s.status()).toMatchObject({ supported: true, configured: false, last: null, nextAt: null });
    await expect(s.configure({ target: 'C:', user: '', schedule: 'daily', time: '21:00', day: 0 }, null)).rejects.toThrow(/another drive/);
    await expect(s.configure({ target: 'E:', user: '', schedule: 'daily', time: '9pm', day: 0 }, null)).rejects.toThrow(/time like/);
    await expect(s.configure({ target: 'E:', user: 'me', schedule: 'daily', time: '21:00', day: 0 }, 'pw')).rejects.toThrow(/needs no account/);
    expect(elevated).toHaveLength(0);

    await s.configure({ target: ' E: ', user: '', schedule: 'daily', time: '21:00', day: 0 }, undefined);
    expect(elevated).toHaveLength(1);
    // A drive keeps no password, even one saved for a network folder before.
    expect(elevated[0]).toContain('Remove-Item -Force -ErrorAction SilentlyContinue $secret');
    expect(elevated[0]).toContain('"target":"E:"');
    expect(audit).toContainEqual(['imageBackup.configure', 'success']);
  });

  it('read the job and how the last image went', () => {
    writeJob({ target: '\\\\nas\\backups', user: 'backup', schedule: 'weekly', time: '21:30', day: 5 });
    writeStatus({ state: 'done', startedAt: '2026-10-09T19:30:00Z', finishedAt: '2026-10-09T20:10:00Z', target: '\\\\nas\\backups', ok: true, detail: 'The backup operation successfully completed.', versions: ['10/02/2026-19:30', '10/09/2026-19:30'] });
    const now = new Date(2026, 9, 12, 12, 0);
    const st = service().status(now);
    expect(st).toMatchObject({
      configured: true,
      config: { target: '\\\\nas\\backups', user: 'backup', schedule: 'weekly', time: '21:30', day: 5 },
      running: false,
      last: { ok: true, at: '2026-10-09T19:30:00Z', finishedAt: '2026-10-09T20:10:00Z' },
      versions: ['10/09/2026-19:30', '10/02/2026-19:30'],
    });
    const next = new Date(st.nextAt!);
    expect([next.getDay(), next.getHours(), next.getMinutes()]).toEqual([5, 21, 30]);
    expect(service().summary()).toEqual({ configured: true, lastAt: '2026-10-09T19:30:00Z', ok: true, running: false });

    // PowerShell writes a single version as a plain string.
    writeStatus({ state: 'failed', startedAt: '2026-10-10T19:30:00Z', ok: false, detail: 'There is not enough disk space', versions: '10/02/2026-19:30' });
    expect(service().status(now)).toMatchObject({ last: { ok: false, detail: 'There is not enough disk space' }, versions: ['10/02/2026-19:30'] });
  });

  it('know one is being made, until a run that never finished is a day old', () => {
    writeJob({ target: 'E:', user: null, schedule: 'off', time: '12:00', day: 0 });
    writeStatus({ state: 'running', startedAt: '2026-10-12T10:00:00Z' });
    expect(service().status(new Date('2026-10-12T11:00:00Z'))).toMatchObject({ running: true, startedAt: '2026-10-12T10:00:00Z', last: null, nextAt: null });
    expect(service().status(new Date('2026-10-14T11:00:00Z')).running).toBe(false);

    // The task keeps the last result beside the new run, so it still shows while the next image is made.
    writeStatus({ state: 'running', startedAt: '2026-10-12T10:00:00Z', previous: { state: 'done', startedAt: '2026-10-05T10:00:00Z', ok: true, detail: 'ok', versions: ['a', 'b'] } });
    expect(service().status(new Date('2026-10-12T11:00:00Z'))).toMatchObject({ running: true, last: { at: '2026-10-05T10:00:00Z', ok: true }, versions: ['b', 'a'] });
    expect(runnerScript()).toContain("$previous = $(if ($old.state -eq 'running') { $old.previous } else { $old })");
  });

  it('start the task now, for the person here and for FBRX Command', async () => {
    const s = service();
    await expect(s.run('user')).rejects.toThrow(/not set up/);
    writeJob({ target: 'E:', user: null, schedule: 'off', time: '12:00', day: 0 });
    const st = await s.run('user');
    expect(ps[0]).toBe("Start-ScheduledTask -TaskPath '\\FBRX\\' -TaskName 'Image backup'; 'started'");
    expect(st.running).toBe(true);
    expect(elevated).toHaveLength(0);

    // Windows says no: the person here is asked once more; FBRX Command gets the reason.
    psAnswer = { code: 1, out: '', err: 'Access is denied.' };
    await s.run('user');
    expect(elevated).toHaveLength(1);
    await expect(s.run('control-plane')).rejects.toThrow(/Access is denied/);

    writeStatus({ state: 'running', startedAt: new Date().toISOString() });
    await expect(s.run('control-plane')).rejects.toThrow(/being made now/);
  });

  it('stop, and leave the images where they are', async () => {
    writeJob({ target: 'E:', user: null, schedule: 'off', time: '12:00', day: 0 });
    await service().remove();
    expect(elevated[0]).toContain('Unregister-ScheduledTask');
    expect(elevated[0]).not.toContain('wbadmin');
    expect(audit).toContainEqual(['imageBackup.remove', 'success']);
  });
});

describe('The connection code from an FBRX Server', () => {
  it('carries the folder and its account in one line', () => {
    const code = encodeTimeCode({ share: '\\\\fbrx-server\\fbrx-time', user: 'fbrx-time', password: 'p@ss wörd', server: 'fbrx-server' });
    expect(code.startsWith('fbrx-time:')).toBe(true);
    expect(code).not.toMatch(/[+/=]/);
    expect(decodeTimeCode(`  ${code}\n`)).toEqual({ share: '\\\\fbrx-server\\fbrx-time', user: 'fbrx-time', password: 'p@ss wörd', server: 'fbrx-server' });
    expect(decodeTimeCode('fbrx-time:not-json')).toBeNull();
    expect(decodeTimeCode('hello')).toBeNull();
  });
});
