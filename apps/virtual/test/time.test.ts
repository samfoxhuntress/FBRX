import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeTimeCode, type TimeImage, type TimeTask } from '@fbrx/shared';
import { loadConfig } from '../src/config';
import { buildServer, type BuiltVirtual } from '../src/server';
import { checkDomainXml, judgeCheck, SimulatedTimeDriver } from '../src/time/driver';
import { lookAt, readPpm, samplePicture, toPng } from '../src/time/png';

// FBRX Server with the virtual and time roles, on the simulated hypervisor.
let dir: string;
let s: BuiltVirtual;
let admin = '';
let operator = '';
let viewer = '';
const driver = new SimulatedTimeDriver({ delayMs: 0 });

const req = async (method: string, url: string, token: string, payload?: unknown) => {
  const r = await s.app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${token}`, host: 'backup-box:9443' }, payload: payload as never });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Until nothing is queued or running. */
async function settle(): Promise<TimeTask[]> {
  for (let i = 0; i < 200; i++) {
    const tasks = (await req('GET', '/v1/time', viewer)).body.tasks as TimeTask[];
    if (!tasks.some((t) => t.state === 'queued' || t.state === 'running')) return tasks;
    await wait(20);
  }
  throw new Error('FBRX Time did not settle');
}
const images = async (subject?: string) => (await req('GET', `/v1/time/images${subject ? `?subject=${subject}` : ''}`, viewer)).body.images as TimeImage[];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fbrx-time-'));
  const shareFile = join(dir, 'share.env');
  writeFileSync(shareFile, 'SHARE_NAME=fbrx-time\nSHARE_USER=fbrx-time\nSHARE_PASSWORD="s3cret pass"\n');
  const config = loadConfig({
    FBRX_V_DATA_DIR: dir,
    FBRX_V_ROLES: 'virtual,time',
    FBRX_V_DRIVER: 'simulated',
    FBRX_V_TIME_SHARE_FILE: shareFile,
    FBRX_V_TLS: 'off',
    FBRX_V_LOG_LEVEL: 'silent',
    FBRX_V_SYS_ROOT: join(dir, 'no-sysfs'),
    FBRX_V_ADMIN_USER: 'sam',
    FBRX_V_ADMIN_PASSWORD: 'correct horse battery',
    FBRX_V_CORE_TOKEN_FILE: join(dir, 'none.token'),
  });
  s = await buildServer(config, { timeDriver: driver });
  const login = async (username: string, password: string) => (await s.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username, password } })).json().token as string;
  admin = await login('sam', 'correct horse battery');
  await req('POST', '/v1/users', admin, { username: 'olly', password: 'operator password', role: 'operator' });
  await req('POST', '/v1/users', admin, { username: 'vic', password: 'viewer password', role: 'viewer' });
  operator = await login('olly', 'operator password');
  viewer = await login('vic', 'viewer password');
});
afterAll(async () => {
  await s.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('FBRX Time on FBRX Server', () => {
  it('shows the backup folder for computers, its password and connection code to administrators only', async () => {
    const v = (await req('GET', '/v1/time', viewer)).body;
    expect(v).toMatchObject({ enabled: true, canBoot: true, share: { path: '\\\\backup-box\\fbrx-time', user: 'fbrx-time', password: null, code: null }, settings: { verifyComputers: true, checkSeconds: 180 } });
    const a = (await req('GET', '/v1/time', admin)).body;
    expect(a.share.password).toBe('s3cret pass');
    expect(decodeTimeCode(a.share.code)).toEqual({ share: '\\\\backup-box\\fbrx-time', user: 'fbrx-time', password: 's3cret pass', server: 'backup-box' });
    expect(decodeTimeCode('fbrx-time:not json')).toBeNull();
  });

  it('backs up a virtual machine on a job, checks the image by booting it, and keeps the newest ones', async () => {
    const vm = (await req('GET', '/v1/vms', viewer)).body.vms.find((x: { name: string }) => x.name === 'files-01');
    const body = { vmId: vm.id, schedule: 'daily', time: '21:30', day: 1, verify: true, keep: 2 };
    expect((await req('POST', '/v1/time/jobs', operator, body)).status).toBe(403);
    expect((await req('POST', '/v1/time/jobs', admin, { ...body, time: '25:00' })).status).toBe(400);
    const job = (await req('POST', '/v1/time/jobs', admin, body)).body.job;
    expect(job).toMatchObject({ name: 'Back up files-01', vmName: 'files-01', enabled: true, lastRunAt: null, nextRunAt: expect.any(String) });

    expect((await req('POST', `/v1/time/jobs/${job.id}/run`, viewer)).status).toBe(403);
    const run = (await req('POST', `/v1/time/jobs/${job.id}/run`, operator)).body.task;
    expect(run).toMatchObject({ kind: 'backup', subject: 'files-01' });
    const tasks = await settle();
    expect(tasks.find((t) => t.kind === 'backup')).toMatchObject({ state: 'done', detail: expect.stringContaining('boot check next') });
    expect(tasks.find((t) => t.kind === 'check')).toMatchObject({ state: 'done', detail: expect.stringContaining('guest agent answered') });

    const [img] = await images('files-01');
    expect(img).toMatchObject({ source: 'vm', jobId: job.id, os: 'linux', firmware: 'uefi', consistency: 'quiesced', check: { state: 'passed', agent: true, screenshot: expect.stringMatching(/^check-.+\.png$/) } });
    expect(img.disks[0]).toMatchObject({ format: 'qcow2', file: expect.stringMatching(/\.qcow2$/) });
    const shot = (await req('GET', `/v1/time/images/${img.id}/screenshot`, viewer)).body.dataUrl as string;
    expect(shot.startsWith('data:image/png;base64,iVBORw0KGgo')).toBe(true);
    expect((await req('GET', '/v1/time/jobs', viewer)).body.jobs[0]).toMatchObject({ lastOk: true, lastRunAt: expect.any(String) });

    // Three more: only the newest two stay.
    for (let i = 0; i < 3; i++) {
      await req('POST', `/v1/time/jobs/${job.id}/run`, operator);
      await settle();
    }
    expect(await images('files-01')).toHaveLength(2);
    expect((await req('POST', `/v1/time/jobs/${job.id}/run`, operator)).status).toBe(200);
    expect((await req('POST', `/v1/time/jobs/${job.id}/run`, operator)).status).toBe(409);
    await settle();
  });

  it('starts jobs at their time, and a machine that was off then catches up', async () => {
    const vm = (await req('GET', '/v1/vms', viewer)).body.vms.find((x: { name: string }) => x.name === 'win11-lab');
    const job = (await req('POST', '/v1/time/jobs', admin, { vmId: vm.id, schedule: 'weekly', time: '02:00', day: 0, verify: false, keep: 3 })).body.job;
    const time = s.ctx.time!;
    const before = (await images('win11-lab')).length;
    const created = new Date(job.createdAt);
    await time.tick(new Date(created.getTime() + 60_000));
    expect(time.tasks().some((t) => t.subject === 'win11-lab' && (t.state === 'queued' || t.state === 'running'))).toBe(false);
    // Eight days later it is due (it missed its Sunday).
    await time.tick(new Date(created.getTime() + 8 * 86400_000));
    await settle();
    const after = await images('win11-lab');
    expect(after).toHaveLength(before + 1);
    expect(after[0]).toMatchObject({ os: 'windows', consistency: 'offline', check: { state: 'none' } });
    // Ran now: not again until its next time.
    await time.tick(new Date(created.getTime() + 8 * 86400_000 + 120_000));
    await settle();
    expect(await images('win11-lab')).toHaveLength(before + 1);
    await req('PUT', `/v1/time/jobs/${job.id}`, admin, { enabled: false });
    expect((await req('GET', '/v1/time/jobs', viewer)).body.jobs.find((j: { id: string }) => j.id === job.id)).toMatchObject({ enabled: false, nextRunAt: null });
  });

  it('says so when an image does not start, and restores an image as a new machine', async () => {
    const [img] = await images('files-01');
    driver.outcome = 'stops';
    await req('POST', `/v1/time/images/${img.id}/check`, operator);
    const tasks = await settle();
    expect(tasks.find((t) => t.kind === 'check' && t.imageId === img.id)).toMatchObject({ state: 'failed', detail: expect.stringContaining('stopped by itself') });
    expect((await images('files-01'))[0].check).toMatchObject({ state: 'failed', screenshot: null });
    driver.outcome = 'text';
    await req('POST', `/v1/time/images/${img.id}/check`, operator);
    await settle();
    expect((await images('files-01'))[0].check).toMatchObject({ state: 'warning', detail: expect.stringContaining('only text') });
    driver.outcome = 'passed';

    expect((await req('POST', `/v1/time/images/${img.id}/restore`, operator, { name: 'files-restored' })).status).toBe(403);
    expect((await req('POST', `/v1/time/images/${img.id}/restore`, admin, { name: 'bad name!' })).status).toBe(400);
    await req('POST', `/v1/time/images/${img.id}/restore`, admin, { name: 'files-restored' });
    const tasks2 = await settle();
    expect(tasks2.find((t) => t.kind === 'restore')).toMatchObject({ state: 'done', detail: expect.stringContaining('New virtual machine files-restored') });
    expect(driver.restored).toEqual([{ name: 'files-restored', from: img.id }]);
  });

  it('keeps computers’ backups from the backup folder, checks them, and puts one back for a restore', async () => {
    const pc = join(s.ctx.config.time.dir, 'incoming', 'WindowsImageBackup', 'SAM-PC');
    const backup = join(pc, 'Backup 2026-10-12 210000');
    mkdirSync(backup, { recursive: true });
    mkdirSync(join(pc, 'Catalog'), { recursive: true });
    writeFileSync(join(backup, '{1f2e}.vhdx'), 'disk'.repeat(5000));
    writeFileSync(join(backup, '{9a9a}.vhdx'), 'efi');
    writeFileSync(join(backup, 'BackupSpecs.xml'), '<x/>');
    writeFileSync(join(pc, 'Catalog', 'GlobalCatalog'), 'c');
    // Still being written: left alone.
    expect((await req('POST', '/v1/time/computers/scan', operator)).body.kept).toBe(0);
    expect((await req('GET', '/v1/time', viewer)).body.computers).toEqual([{ name: 'SAM-PC', images: 0, lastImageAt: null, receiving: true }]);
    const old = new Date(Date.now() - 3600_000);
    for (const f of [join(backup, '{1f2e}.vhdx'), join(backup, '{9a9a}.vhdx'), join(backup, 'BackupSpecs.xml'), join(pc, 'Catalog', 'GlobalCatalog')]) utimesSync(f, old, old);
    expect((await req('POST', '/v1/time/computers/scan', operator)).body.kept).toBe(1);
    await settle();
    expect((await req('POST', '/v1/time/computers/scan', operator)).body.kept).toBe(0);
    const [img] = await images('SAM-PC');
    expect(img).toMatchObject({ source: 'computer', os: 'windows', consistency: 'computer', createdAt: '2026-10-12T21:00:00.000Z', check: { state: 'passed', agent: false } });
    expect(img.disks.map((d) => [d.target, d.format, d.bus])).toEqual([
      ['sda', 'vhdx', 'sata'],
      ['sdb', 'vhdx', 'sata'],
    ]);
    expect((await req('GET', '/v1/time', viewer)).body.computers[0]).toMatchObject({ name: 'SAM-PC', images: 1, receiving: false });

    await req('POST', `/v1/time/images/${img.id}/restore`, admin, {});
    const tasks = await settle();
    expect(tasks.find((t) => t.kind === 'restore' && t.subject === 'SAM-PC')?.detail).toContain('System Image Recovery');
    const restoreDir = join(s.ctx.config.time.dir, 'incoming', 'Restore');
    expect(readdirSync(join(restoreDir, readdirSync(restoreDir)[0]!, 'WindowsImageBackup', 'SAM-PC', 'Backup 2026-10-12 210000'))).toContain('{1f2e}.vhdx');

    expect((await req('DELETE', `/v1/time/images/${img.id}`, operator)).status).toBe(403);
    expect((await req('DELETE', `/v1/time/images/${img.id}`, admin)).status).toBe(200);
    expect(await images('SAM-PC')).toHaveLength(0);
    expect(existsSync(join(s.ctx.config.time.dir, 'images', 'SAM-PC'))).toBe(true);
    expect(readdirSync(join(s.ctx.config.time.dir, 'images', 'SAM-PC'))).toHaveLength(0);
  });

  it('changes its settings for administrators, within limits', async () => {
    expect((await req('PUT', '/v1/time/settings', operator, { checkSeconds: 60 })).status).toBe(403);
    expect((await req('PUT', '/v1/time/settings', admin, { checkSeconds: 5 })).status).toBe(400);
    expect((await req('PUT', '/v1/time/settings', admin, { checkSeconds: 300, verifyComputers: false })).body.settings).toEqual({ verifyComputers: false, checkSeconds: 300, keepComputer: 7 });
  });
});

describe('Boot checks, in pieces', () => {
  it('turns the screen into a PNG and tells a picture from text and from nothing', () => {
    const pic = samplePicture(320, 200);
    const ppm = Buffer.concat([Buffer.from('P6\n# from virsh\n320 200\n255\n'), pic.rgb]);
    const back = readPpm(ppm);
    expect([back.width, back.height]).toEqual([320, 200]);
    const png = toPng(back);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(lookAt(back)).toMatchObject({ blank: false, graphical: true });
    expect(lookAt({ width: 10, height: 10, rgb: Buffer.alloc(300) })).toMatchObject({ blank: true, graphical: false });
    expect(() => readPpm(Buffer.from('P3 1 1 255 0 0 0'))).toThrow(/Not a PPM/);
  });

  it('judges what it saw in plain words', () => {
    const at = '2026-10-12T00:00:00Z';
    expect(judgeCheck({ ranSeconds: 180, stoppedEarly: null, agent: true, screen: null, screenshot: null, at })).toMatchObject({ state: 'passed', detail: expect.stringContaining('3 minutes') });
    expect(judgeCheck({ ranSeconds: 90, stoppedEarly: null, agent: null, screen: { blank: true, colors: 1, graphical: false }, screenshot: 'x.png', at }).state).toBe('warning');
    expect(judgeCheck({ ranSeconds: 9, stoppedEarly: 'crashed', agent: null, screen: null, screenshot: null, at })).toMatchObject({ state: 'failed', detail: expect.stringContaining('9 seconds (crashed)') });
  });

  it('opens the image with no network card, behind scratch disks', () => {
    const image = { id: 'i', source: 'vm', subject: 'files-01', jobId: null, createdAt: 'now', bytes: 1, disks: [], os: 'linux', firmware: 'uefi', consistency: 'offline', check: {} as never, note: '' } as TimeImage;
    const xml = checkDomainXml({ name: 'fbrx-time-check-i', uuid: '00000000-0000-0000-0000-000000000001', image, overlays: [{ path: '/lab/t/vda.qcow2', target: 'vda', bus: 'virtio' }], memoryMb: 2048, cpus: 2, domainType: 'kvm' });
    expect(xml).toContain("<source file='/lab/t/vda.qcow2'/>");
    expect(xml).toContain("firmware='efi'");
    expect(xml).toContain('org.qemu.guest_agent.0');
    expect(xml).not.toContain('<interface');
  });
});
