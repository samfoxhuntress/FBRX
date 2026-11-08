import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nfsPath, smbPath, type FilesBackup, type FilesStatus } from '@fbrx/shared';
import { SimulatedApplier } from '@fbrx/gate/node';
import { loadConfig } from '../src/config';
import { buildServer, type BuiltVirtual } from '../src/server';
import { FilesService, renderShares } from '../src/files/service';
import { cifsCredentials, LinuxFilesSystem, pruneKept, rsyncStats, SimulatedFilesSystem, type Runner } from '../src/files/system';
import { filesPriorityNft, memoryNft } from '../src/files/priority';

// FBRX Server with the virtual and files roles, on the simulated hypervisor; nft kept in memory.
let dir: string;
let s: BuiltVirtual;
let admin = '';
let operator = '';
let viewer = '';
const nft = memoryNft();
let system: SimulatedFilesSystem;

const req = async (method: string, url: string, token: string, payload?: unknown) => {
  const r = await s.app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${token}`, host: 'files-box:9443' }, payload: payload as never });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const status = async () => (await req('GET', '/v1/files', viewer)).body as FilesStatus;
/** Until the backup is no longer copying. */
async function settled(id: string): Promise<FilesBackup> {
  for (let i = 0; i < 200; i++) {
    const b = (await status()).backups.find((x) => x.id === id)!;
    if (b.last && b.last.state !== 'running') return b;
    await wait(15);
  }
  throw new Error('The backup did not finish');
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fbrx-files-'));
  const config = loadConfig({
    FBRX_V_DATA_DIR: dir,
    FBRX_V_ROLES: 'virtual,files',
    FBRX_V_DRIVER: 'simulated',
    FBRX_V_FILES: 'simulated',
    FBRX_V_TLS: 'off',
    FBRX_V_LOG_LEVEL: 'silent',
    FBRX_V_SYS_ROOT: join(dir, 'no-sysfs'),
    FBRX_V_ADMIN_USER: 'sam',
    FBRX_V_ADMIN_PASSWORD: 'correct horse battery',
    FBRX_V_CORE_TOKEN_FILE: join(dir, 'none.token'),
  });
  system = new SimulatedFilesSystem(join(dir, 'files'));
  s = await buildServer(config, { nft, filesSystem: system });
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

describe('the file server', () => {
  it('serves shares from this server, with accounts of their own', async () => {
    expect((await status()).mode).toBe('off');
    expect((await req('PUT', '/v1/files/mode', operator, { mode: 'host' })).status).toBe(403);
    expect((await req('PUT', '/v1/files/mode', admin, { mode: 'host' })).status).toBe(200);
    expect((await req('POST', '/v1/files/accounts', admin, { name: 'alice', password: 'short' })).status).toBe(400);
    expect((await req('POST', '/v1/files/accounts', admin, { name: 'root', password: 'long enough pass' })).status).toBe(400);
    expect((await req('POST', '/v1/files/accounts', admin, { name: 'alice', password: 'long enough pass' })).status).toBe(200);
    expect((await req('POST', '/v1/files/accounts', admin, { name: 'bob', password: 'another long one' })).status).toBe(200);
    expect((await req('POST', '/v1/files/accounts', admin, { name: 'alice', password: 'long enough pass' })).status).toBe(409);
    expect((await req('POST', '/v1/files/shares', admin, { name: 'Office Docs' })).status).toBe(400);
    expect((await req('POST', '/v1/files/shares', admin, { name: 'fbrx-time' })).status).toBe(400);
    expect((await req('POST', '/v1/files/shares', admin, { name: 'office', comment: 'Shared\n[evil]', accounts: ['carol'] })).status).toBe(400);
    expect((await req('POST', '/v1/files/shares', admin, { name: 'office', comment: 'Shared\n[evil]' })).status).toBe(200);
    expect((await req('POST', '/v1/files/shares', admin, { name: 'archive', readOnly: true, accounts: ['alice'] })).status).toBe(200);
    expect(system.shares).toContain('[office]');
    expect(system.shares).toContain('valid users = @fbrx-files');
    expect(system.shares).toContain('comment = Shared evil');
    expect(system.shares).not.toContain('[evil]');
    expect(system.shares).toMatch(/\[archive\][^[]*valid users = alice[^[]*read only = yes/);
    expect([...system.accounts.keys()].sort()).toEqual(['alice', 'bob']);

    writeFileSync(join(system.root, 'office', 'plan.txt'), 'twelve bytes');
    const st = await status();
    expect(st.shares.map((x) => x.name)).toEqual(['office', 'archive']);
    expect(st.host).toMatchObject({ ready: true, address: 'files-box' });
    // Removing an account takes it off the shares it was on.
    expect((await req('DELETE', '/v1/files/accounts/alice', admin)).status).toBe(200);
    expect(system.shares).toMatch(/\[archive\][^[]*valid users = @fbrx-files/);
    expect((await req('PUT', '/v1/files/accounts/bob/password', admin, { password: 'a new long password' })).status).toBe(200);
  });

  it('gives the shares’ traffic priority, and follows the virtual machine when one is the file server', async () => {
    expect((await req('PUT', '/v1/files/priority', admin, { enabled: true })).status).toBe(200);
    expect(nft.tables.get('inet fbrx_files')).toContain('tcp sport { 445, 2049 } ip dscp set af31');
    expect((await status()).priority).toMatchObject({ enabled: true, trafficClass: 'af31', applied: true });

    const vm = await s.ctx.hv.createVm({ name: 'nas-01', os: 'linux', cpus: 2, memoryMb: 2048, diskGb: 20, network: { kind: 'network', source: 'default' }, firmware: 'bios', startNow: true }, null);
    const ip = (await s.ctx.hv.getVm(vm.id)).ip!;
    expect(ip).toMatch(/^192\.168\.122\./);
    expect((await req('PUT', '/v1/files/mode', admin, { mode: 'vm', vmId: vm.id, address: 'not an address' })).status).toBe(400);
    expect((await req('PUT', '/v1/files/mode', admin, { mode: 'vm', vmId: vm.id })).status).toBe(200);
    // The shares stop being served from the host; their files stay.
    expect(system.shares).not.toContain('[office]');
    expect(existsSync(join(system.root, 'office', 'plan.txt'))).toBe(true);
    const inet = nft.tables.get('inet fbrx_files')!;
    expect(inet).toContain(`ip saddr ${ip} tcp sport { 445, 2049 } ip dscp set af31`);
    expect(inet).not.toContain('hook output');
    expect(nft.tables.get('bridge fbrx_files')).toContain(`ip daddr ${ip} tcp dport { 445, 2049 } ip dscp set af31`);
    const st = await status();
    expect(st.vm).toMatchObject({ name: 'nas-01', address: ip, running: true, addressSet: false });
    expect(st.priority.applied).toBe(true);
    expect((await req('PUT', '/v1/files/vm/autostart', admin, { on: true })).status).toBe(200);
    expect((await status()).vm?.autostart).toBe(true);

    // A typed address wins over the one it reports.
    expect((await req('PUT', '/v1/files/mode', admin, { mode: 'vm', vmId: vm.id, address: '192.168.1.20' })).status).toBe(200);
    expect(nft.tables.get('inet fbrx_files')).toContain('ip saddr 192.168.1.20');
    expect((await req('PUT', '/v1/files/priority', admin, { enabled: false })).status).toBe(200);
    expect(nft.tables.has('inet fbrx_files')).toBe(false);
    expect(nft.tables.has('bridge fbrx_files')).toBe(false);
    expect((await req('PUT', '/v1/files/mode', admin, { mode: 'host' })).status).toBe(200);
    expect(system.shares).toContain('[office]');
  });

  it('backs a share up to a NAS, keeping what changed or went', async () => {
    const office = join(system.root, 'office');
    writeFileSync(join(office, 'keep.txt'), 'stays the same');
    mkdirSync(join(office, 'sub'), { recursive: true });
    writeFileSync(join(office, 'sub', 'notes.txt'), 'first notes');
    const body = { name: 'Office nightly', source: { kind: 'share', share: 'office' }, destination: { kind: 'smb', path: '\\\\nas\\backups', user: 'backup', password: 'nas password 1' }, schedule: 'daily', time: '01:30', day: 0, keepDays: 30 };
    expect((await req('POST', '/v1/files/backups', admin, { ...body, destination: { kind: 'smb', path: 'nas/backups', user: 'x', password: 'y' } })).status).toBe(400);
    expect((await req('POST', '/v1/files/backups', admin, { ...body, destination: { kind: 'smb', path: '\\\\nas\\backups', user: 'backup' } })).status).toBe(400);
    expect((await req('POST', '/v1/files/backups', operator, body)).status).toBe(403);
    const made = await req('POST', '/v1/files/backups', admin, body);
    expect(made.status).toBe(200);
    const b = made.body.backup as FilesBackup;
    expect(b.destination).toEqual({ kind: 'smb', path: '//nas/backups', user: 'backup', hasPassword: true });
    expect(b.nextAt).toBeTruthy();
    // The password is sealed: not in what comes back, not in the database.
    expect(JSON.stringify(await status())).not.toContain('nas password 1');
    expect(JSON.stringify(s.ctx.db.all('SELECT value FROM settings'))).not.toContain('nas password 1');
    expect((await req('POST', '/v1/files/backups', admin, body)).status).toBe(409);
    // Renamed onto another backup's folder on the same device: refused too.
    const other = (await req('POST', '/v1/files/backups', admin, { ...body, name: 'Office weekly', destination: { ...body.destination } })).body.backup as FilesBackup;
    expect((await req('PUT', `/v1/files/backups/${other.id}`, admin, { name: 'office NIGHTLY' })).status).toBe(409);
    expect((await req('DELETE', `/v1/files/backups/${other.id}`, admin)).status).toBe(200);

    expect((await req('POST', `/v1/files/backups/${b.id}/run`, viewer)).status).toBe(403);
    expect((await req('POST', `/v1/files/backups/${b.id}/run`, operator)).status).toBe(200);
    const first = await settled(b.id);
    expect(first.last).toMatchObject({ state: 'ok', files: 3 });
    const nas = join(system.device('//nas/backups'), 'office-nightly');
    expect(readFileSync(join(nas, 'current', 'sub', 'notes.txt'), 'utf8')).toBe('first notes');

    // A change and a deletion: the old copies go to kept/<today>.
    writeFileSync(join(office, 'sub', 'notes.txt'), 'second notes, longer');
    rmSync(join(office, 'plan.txt'));
    await req('POST', `/v1/files/backups/${b.id}/run`, operator);
    const second = await settled(b.id);
    expect(second.last).toMatchObject({ state: 'ok', files: 1 });
    const today = new Date().toISOString().slice(0, 10);
    expect(readFileSync(join(nas, 'current', 'sub', 'notes.txt'), 'utf8')).toBe('second notes, longer');
    expect(readFileSync(join(nas, 'kept', today, 'sub', 'notes.txt'), 'utf8')).toBe('first notes');
    expect(existsSync(join(nas, 'kept', today, 'plan.txt'))).toBe(true);
    expect(existsSync(join(nas, 'current', 'plan.txt'))).toBe(false);

    // A share a backup copies cannot be removed from under it.
    expect((await req('DELETE', '/v1/files/shares/office', admin)).status).toBe(409);
    // Editing without the password keeps it; a wrong one fails the copy, in words.
    expect((await req('PUT', `/v1/files/backups/${b.id}`, admin, { keepDays: 7 })).status).toBe(200);
    expect((await req('PUT', `/v1/files/backups/${b.id}`, admin, { destination: { kind: 'smb', path: '\\\\nas\\backups', user: 'backup', password: 'wrong' } })).status).toBe(200);
    await req('POST', `/v1/files/backups/${b.id}/run`, operator);
    const failed = await settled(b.id);
    expect(failed.last?.state).toBe('failed');
    expect(failed.last?.detail).toMatch(/sign-in was refused/);
    expect((await req('DELETE', `/v1/files/backups/${b.id}`, admin)).status).toBe(200);
    expect((await req('DELETE', '/v1/files/shares/office', admin)).status).toBe(200);
  });

  it('runs a backup when it falls due, and asks this server’s AI about one that fails', async () => {
    const asked: string[] = [];
    const svc = new FilesService({
      db: s.ctx.db,
      hv: s.ctx.hv,
      system,
      nft: memoryNft(),
      key: randomBytes(32),
      log: () => undefined,
      gate: () => null,
      advise: async (prompt) => (asked.push(prompt), { answer: 'Check the NAS account can write to backups.', model: 'local' }),
    });
    const b = svc.createBackup({ name: 'Archive to NFS', source: { kind: 'remote', place: { kind: 'smb', path: '//nas-01/data', user: 'reader', password: 'wrong-Zq9x' } }, destination: { kind: 'nfs', path: 'nas:/export/backups' }, schedule: 'daily', time: '02:00', day: 0, keepDays: 14 });
    // Not due until 02:00 comes round after it was made.
    const made = new Date(b.createdAt);
    await svc.tick(new Date(made.getTime() + 60_000));
    const tomorrow = new Date(made);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(2, 1, 0, 0);
    await svc.tick(tomorrow);
    for (let i = 0; i < 100 && !(svc.backup(b.id).last?.advice); i++) await wait(10);
    const last = svc.backup(b.id).last!;
    expect(last.state).toBe('failed');
    expect(last.advice).toBe('Check the NAS account can write to backups.');
    expect(asked[0]).toContain('Archive to NFS');
    expect(asked[0]).toContain('\\\\nas-01\\data');
    expect(asked[0]).not.toContain('Zq9x');
    svc.deleteBackup(b.id);
    svc.stop();
  });
});

describe('the file server on a gate', () => {
  let g: BuiltVirtual;
  let gdir: string;
  beforeAll(async () => {
    gdir = mkdtempSync(join(tmpdir(), 'fbrx-files-gate-'));
    const config = loadConfig({
      FBRX_V_DATA_DIR: gdir,
      FBRX_V_ROLES: 'gate,files',
      FBRX_V_GATE: 'simulated',
      FBRX_V_GATE_WAN: 'eno1',
      FBRX_V_GATE_LAN: 'eno2',
      FBRX_V_GATE_FIRST: 'commit',
      FBRX_V_FILES: 'simulated',
      FBRX_V_TLS: 'off',
      FBRX_V_LOG_LEVEL: 'silent',
      FBRX_V_SYS_ROOT: join(gdir, 'no-sysfs'),
      FBRX_V_ADMIN_USER: 'sam',
      FBRX_V_ADMIN_PASSWORD: 'correct horse battery',
      FBRX_V_CORE_TOKEN_FILE: join(gdir, 'none.token'),
    });
    g = await buildServer(config, { gateApplier: new SimulatedApplier(), nft: memoryNft() });
  });
  afterAll(async () => {
    await g.close();
    rmSync(gdir, { recursive: true, force: true });
  });

  it('adds firewall rules for every network to what is being edited, for a commit with What If', async () => {
    const token = (await g.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'sam', password: 'correct horse battery' } })).json().token as string;
    const call = async (method: string, url: string) => {
      const r = await g.app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${token}` } });
      return { status: r.statusCode, body: r.json() };
    };
    expect((await call('GET', '/v1/files')).body.gate).toEqual({ present: true, open: false });
    expect((await call('POST', '/v1/files/gate')).body).toEqual({ added: 1 });
    expect((await call('POST', '/v1/files/gate')).body).toEqual({ added: 0 });
    const rules = g.ctx.gate!.engine.candidate().firewall.rules.filter((r) => r.id.startsWith('fbrx-files-'));
    expect(rules).toEqual([expect.objectContaining({ from: 'lan', to: 'gate', proto: 'tcp', ports: '445', action: 'accept' })]);
    // Nothing changes on the network until the commit.
    expect((await call('GET', '/v1/files')).body.gate.open).toBe(false);
    await g.ctx.gate!.engine.commit({ by: 'sam', comment: 'File server' });
    expect((await call('GET', '/v1/files')).body.gate.open).toBe(true);
  });
});

describe('the file server’s parts', () => {
  it('reads SMB and NFS paths, and refuses ones that climb out', () => {
    expect(smbPath('\\\\nas\\backups')).toBe('//nas/backups');
    expect(smbPath('//nas.lan/backups/server/')).toBe('//nas.lan/backups/server');
    expect(smbPath('\\\\nas\\..\\etc')).toBeNull();
    expect(smbPath('nas\\backups')).toBeNull();
    expect(nfsPath('nas:/export/backups/')).toBe('nas:/export/backups');
    expect(nfsPath('nas:/export/../etc')).toBeNull();
    expect(nfsPath('/export/backups')).toBeNull();
    // Never something mount would take for an option.
    expect(nfsPath('-oremount:/')).toBeNull();
    expect(smbPath('//-o/x')).toBeNull();
  });

  it('writes Samba shares and the priority tables', () => {
    expect(renderShares([], '/srv/fbrx-files')).not.toContain('[');
    const t = filesPriorityNft('af41', null);
    expect(t.inet).toContain('hook output');
    expect(t.bridge).toBeNull();
    expect(filesPriorityNft('af41', 'nope').bridge).toBeNull();
  });

  it('reads rsync’s numbers, mount.cifs sign-ins, and drops old kept days', () => {
    expect(rsyncStats('Number of files: 1,204 (reg: 1,100, dir: 104)\nNumber of regular files transferred: 1,042\nTotal transferred file size: 3,221,225,472 bytes\n')).toEqual({ files: 1042, bytes: 3221225472 });
    expect(cifsCredentials('OFFICE\\backup', 'p w')).toBe('username=backup\npassword=p w\ndomain=OFFICE\n');
    expect(() => cifsCredentials('a', 'b\nusername=root')).toThrow();
    const kept = mkdtempSync(join(tmpdir(), 'fbrx-kept-'));
    for (const d of ['2026-10-01', '2026-11-01', '2026-11-07', 'notes']) mkdirSync(join(kept, d));
    expect(pruneKept(kept, '2026-11-08', 14)).toBe(1);
    expect(existsSync(join(kept, '2026-10-01'))).toBe(false);
    expect(existsSync(join(kept, '2026-11-01')) && existsSync(join(kept, 'notes'))).toBe(true);
    rmSync(kept, { recursive: true, force: true });
  });

  it('on Linux: refuses to take over an account it did not make, and never deletes a folder still mounted', async () => {
    const work = mkdtempSync(join(tmpdir(), 'fbrx-files-linux-'));
    const calls: string[][] = [];
    let umountWorks = true;
    const fake: Runner = async (cmd, args, o) => {
      calls.push([cmd, ...args]);
      if (cmd === 'getent' && args[0] === 'passwd') return args[1] === 'sam' ? { code: 0, out: 'sam:x:1000:1000:Sam,,,:/home/sam:/bin/bash\n', err: '' } : { code: 2, out: '', err: '' };
      if (cmd === 'smbpasswd' && args.includes('-a')) expect(o?.input).toBe('pass word 1\npass word 1\n');
      if (cmd === 'mount') {
        const opts = args[args.indexOf('-o') + 1]!;
        const cred = /credentials=([^,]+)/.exec(opts)?.[1];
        if (cred) expect(readFileSync(cred, 'utf8')).toBe('username=backup\npassword=secret\n');
        writeFileSync(join(args[3]!, 'on-the-nas.txt'), 'the NAS’s own file');
      }
      if (cmd === 'umount') return { code: umountWorks ? 0 : 32, out: '', err: umountWorks ? '' : 'target is busy' };
      if (cmd === 'rsync') return { code: 0, out: 'Number of regular files transferred: 3\nTotal transferred file size: 99 bytes\n', err: '' };
      return { code: 0, out: '', err: '' };
    };
    const linux = new LinuxFilesSystem({ root: join(work, 'srv'), smbConf: join(work, 'fbrx-files.conf'), mainConf: join(work, 'smb.conf'), workDir: join(work, 'run'), run: fake });
    await expect(linux.setAccount('sam', 'pass word 1')).rejects.toThrow(/not a file server account/);
    await linux.setAccount('alice', 'pass word 1');
    expect(calls.find((c) => c[0] === 'useradd')).toEqual(expect.arrayContaining(['--shell', '/usr/sbin/nologin', '--comment', 'FBRX file server', 'alice']));
    writeFileSync(join(work, 'smb.conf'), '[global]\n   workgroup = WORKGROUP\n');
    await linux.writeShares('# none\n');
    expect(readFileSync(join(work, 'smb.conf'), 'utf8')).toContain(`include = ${join(work, 'fbrx-files.conf')}`);

    const job = { slug: 'office', source: { kind: 'folder' as const, path: join(work, 'srv', 'office') }, destination: { kind: 'smb' as const, path: '\\\\nas\\backups', user: 'backup', password: 'secret' }, keepDays: 30, today: '2026-11-08' };
    const r = await linux.backup(job, new AbortController().signal);
    expect(r).toMatchObject({ files: 3, bytes: 99 });
    const rsync = calls.find((c) => c[0] === 'rsync')!;
    expect(rsync).toContain('-rt');
    expect(rsync).toContain('--delete');
    expect(rsync.find((a) => a.startsWith('--backup-dir='))).toMatch(/office\/kept\/2026-11-08$/);
    expect(calls.find((c) => c[0] === 'mount')).toEqual(expect.arrayContaining(['-t', 'cifs', '//nas/backups']));
    // The credentials file is gone once mounted.
    expect(existsSync(join(work, 'run'))).toBe(true);

    // When the NAS will not let go, its folder (and files) are left alone.
    umountWorks = false;
    await linux.backup(job, new AbortController().signal);
    const left = calls.filter((c) => c[0] === 'mount').at(-1)![4]!;
    expect(readFileSync(join(left, 'on-the-nas.txt'), 'utf8')).toBe('the NAS’s own file');
    rmSync(work, { recursive: true, force: true });
  });
});
