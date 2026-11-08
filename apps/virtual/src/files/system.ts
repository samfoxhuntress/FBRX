import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { nfsPath, smbPath } from '@fbrx/shared';

/**
 * What the file server needs from the system: Samba's shares file and accounts, the share folders, and copying a
 * backup to another device. On FBRX Server it is Linux (Samba, mount.cifs and NFS, rsync); in development and tests a
 * simulated one keeps everything in a folder and copies with a small mirror of its own.
 */

/** A folder a backup reads from or writes to, with its sign-in. */
export type BackupPlace = { kind: 'folder'; path: string } | { kind: 'smb'; path: string; user: string; password: string } | { kind: 'nfs'; path: string };

export interface BackupJob {
  /** The backup's folder at the destination: <slug>/current, <slug>/kept/<date>. */
  slug: string;
  source: BackupPlace;
  destination: Exclude<BackupPlace, { kind: 'folder' }>;
  keepDays: number;
  /** YYYY-MM-DD: where today's changed and deleted files are kept. */
  today: string;
}

export interface BackupResult {
  files: number;
  bytes: number;
  detail: string;
}

export interface FilesSystem {
  readonly kind: 'linux' | 'simulated';
  /** Where the share folders are. */
  readonly root: string;
  /** Samba is there and running. */
  ready(): Promise<{ ready: boolean; why: string | null }>;
  makeFolder(name: string): Promise<void>;
  sizeOf(name: string): Promise<number | null>;
  /** Writes the shares file and has Samba read it again. */
  writeShares(text: string): Promise<void>;
  /** Adds an account, or sets its password when it is there. */
  setAccount(name: string, password: string): Promise<void>;
  removeAccount(name: string): Promise<void>;
  backup(job: BackupJob, signal: AbortSignal): Promise<BackupResult>;
}

const GECOS = 'FBRX file server';
export const FILES_GROUP = 'fbrx-files';

export interface RunResult {
  code: number;
  out: string;
  err: string;
}
export type Runner = (cmd: string, args: string[], o?: { input?: string; timeoutMs?: number; signal?: AbortSignal }) => Promise<RunResult>;

/** Runs a command without a shell; a missing command is code -1. Output is capped (rsync on a big share talks a lot). */
export const run: Runner = (cmd, args, o = {}) =>
  new Promise((resolve) => {
    let out = '';
    let err = '';
    const cap = (s: string, add: Buffer) => (s.length > 400_000 ? s : s + add.toString());
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], timeout: o.timeoutMs ?? 60_000, signal: o.signal, env: { ...process.env, LC_ALL: 'C' } });
    child.stdout.on('data', (b: Buffer) => (out = cap(out, b)));
    child.stderr.on('data', (b: Buffer) => (err = cap(err, b)));
    child.on('error', (e: NodeJS.ErrnoException) => resolve({ code: e.code === 'ENOENT' ? -1 : 1, out, err: e.code === 'ENOENT' ? `${cmd} is not installed` : e.name === 'AbortError' ? 'Stopped' : e.message }));
    child.on('close', (code, sig) => resolve({ code: code ?? (sig ? 128 : 1), out, err: sig && !err ? `stopped (${sig})` : err }));
    if (o.input !== undefined) child.stdin.end(o.input);
    else child.stdin.end();
  });

const tail = (s: string, n = 400) => s.trim().split('\n').slice(-6).join(' ').slice(-n);

/** rsync's --stats: files copied and their size. */
export function rsyncStats(out: string): { files: number; bytes: number } {
  const num = (re: RegExp) => Number((re.exec(out)?.[1] ?? '0').replace(/[,.]/g, '')) || 0;
  return { files: num(/Number of regular files transferred:\s*([\d,.]+)/), bytes: num(/Total transferred file size:\s*([\d,.]+)/) };
}

/** Kept folders (YYYY-MM-DD) older than keepDays, deleted. */
export function pruneKept(dir: string, today: string, keepDays: number): number {
  if (!existsSync(dir)) return 0;
  const cutoff = new Date(`${today}T00:00:00Z`).getTime() - keepDays * 86_400_000;
  let n = 0;
  for (const name of readdirSync(dir)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
    if (new Date(`${name}T00:00:00Z`).getTime() < cutoff) {
      rmSync(join(dir, name), { recursive: true, force: true });
      n++;
    }
  }
  return n;
}

/** "DOMAIN\user" or "user@domain" into what mount.cifs's credentials file takes. */
export function cifsCredentials(user: string, password: string): string {
  const bad = /[\r\n]/;
  if (bad.test(user) || bad.test(password)) throw new Error('The sign-in has a line break in it');
  const m = /^([^\\]+)\\(.+)$/.exec(user);
  return m ? `username=${m[2]}\npassword=${password}\ndomain=${m[1]}\n` : `username=${user}\npassword=${password}\n`;
}

// ------------------------------------------------------------------------------------------------ Linux

export interface LinuxFilesOptions {
  root: string;
  /** The shares file Samba includes (/etc/samba/fbrx-files.conf). */
  smbConf: string;
  /** Samba's own configuration, which must include it. */
  mainConf?: string;
  /** Scratch space for mount points and credentials files (root only). */
  workDir: string;
  run?: Runner;
}

export class LinuxFilesSystem implements FilesSystem {
  readonly kind = 'linux' as const;
  readonly root: string;
  private readonly run: Runner;

  constructor(private readonly o: LinuxFilesOptions) {
    this.root = o.root;
    this.run = o.run ?? run;
  }

  async ready() {
    if (!existsSync('/usr/sbin/smbd')) return { ready: false, why: 'Samba is not installed: add the files role again (Roles in this console, or sudo fbrx-server roles add files)' };
    const r = await this.run('systemctl', ['is-active', 'smbd']);
    if (r.code !== 0) return { ready: false, why: 'Samba is not running (sudo systemctl restart smbd; journalctl -u smbd says why)' };
    return { ready: true, why: null };
  }

  private async must(cmd: string, args: string[], o?: Parameters<Runner>[2]) {
    const r = await this.run(cmd, args, o);
    if (r.code !== 0) throw new Error(`${cmd}: ${tail(r.err || r.out) || `failed (${r.code})`}`);
    return r;
  }

  private async group() {
    if ((await this.run('getent', ['group', FILES_GROUP])).code !== 0) await this.must('groupadd', ['--system', FILES_GROUP]);
  }

  async makeFolder(name: string) {
    await this.group();
    const dir = join(this.root, name);
    mkdirSync(dir, { recursive: true });
    await this.must('chown', [`root:${FILES_GROUP}`, this.root, dir]);
    await this.must('chmod', ['0750', this.root]);
    // Set-group: what people put in it stays the file server's group, so everyone with access can open it.
    await this.must('chmod', ['2770', dir]);
  }

  async sizeOf(name: string) {
    const r = await this.run('du', ['-sb', join(this.root, name)], { timeoutMs: 20_000 });
    const n = Number(r.out.split(/\s/)[0]);
    return r.code === 0 && Number.isFinite(n) ? n : null;
  }

  async writeShares(text: string) {
    mkdirSync(dirname(this.o.smbConf), { recursive: true });
    writeFileSync(this.o.smbConf, text, { mode: 0o644 });
    const main = this.o.mainConf ?? '/etc/samba/smb.conf';
    if (existsSync(main) && !readFileSync(main, 'utf8').includes(`include = ${this.o.smbConf}`)) {
      writeFileSync(main, `${readFileSync(main, 'utf8').replace(/\n*$/, '\n')}\n# FBRX file server\ninclude = ${this.o.smbConf}\n`);
    }
    const r = await this.run('smbcontrol', ['smbd', 'reload-config']);
    if (r.code !== 0) await this.must('systemctl', ['reload-or-restart', 'smbd']);
  }

  /** The account's entry: null when there is none, else whether the file server made it. */
  private async owned(name: string): Promise<boolean | null> {
    const r = await this.run('getent', ['passwd', name]);
    if (r.code !== 0) return null;
    return r.out.split(':')[4] === GECOS;
  }

  async setAccount(name: string, password: string) {
    if (/[\r\n]/.test(password)) throw new Error('A password cannot have a line break in it');
    const mine = await this.owned(name);
    if (mine === false) throw new Error(`This server already has an account named ${name} that is not a file server account: pick another name`);
    if (mine === null) {
      await this.group();
      await this.must('useradd', ['--system', '--no-create-home', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', '--gid', FILES_GROUP, '--comment', GECOS, name]);
    }
    await this.must('smbpasswd', ['-s', '-a', name], { input: `${password}\n${password}\n` });
    await this.run('smbpasswd', ['-e', name]);
  }

  async removeAccount(name: string) {
    const mine = await this.owned(name);
    if (mine === false) throw new Error(`${name} is not a file server account`);
    await this.run('smbpasswd', ['-x', name]);
    if (mine) await this.must('userdel', [name]);
  }

  private async mount(place: Exclude<BackupPlace, { kind: 'folder' }>, at: string, work: string, readOnly: boolean, signal: AbortSignal) {
    mkdirSync(at, { recursive: true });
    if (place.kind === 'smb') {
      const share = smbPath(place.path);
      if (!share) throw new Error(`${place.path} is not a shared folder's path (\\\\device\\folder)`);
      const cred = join(work, `${at.split('/').pop()}.cred`);
      writeFileSync(cred, cifsCredentials(place.user, place.password), { mode: 0o600 });
      try {
        const r = await this.run('mount', ['-t', 'cifs', share, at, '-o', `credentials=${cred},iocharset=utf8,${readOnly ? 'ro' : 'rw,file_mode=0660,dir_mode=0770'}`], { timeoutMs: 60_000, signal });
        if (r.code !== 0) throw new Error(`${place.path} could not be opened: ${mountWords(tail(r.err || r.out))}`);
      } finally {
        unlinkSync(cred);
      }
    } else {
      const exp = nfsPath(place.path);
      if (!exp) throw new Error(`${place.path} is not an NFS export (device:/folder)`);
      const r = await this.run('mount', ['-t', 'nfs', exp, at, '-o', readOnly ? 'ro' : 'rw'], { timeoutMs: 60_000, signal });
      if (r.code !== 0) throw new Error(`${place.path} could not be opened: ${mountWords(tail(r.err || r.out))}`);
    }
  }

  private async unmount(at: string) {
    if ((await this.run('umount', [at], { timeoutMs: 60_000 })).code !== 0) await this.run('umount', ['-l', at], { timeoutMs: 30_000 });
  }

  async backup(job: BackupJob, signal: AbortSignal): Promise<BackupResult> {
    mkdirSync(this.o.workDir, { recursive: true, mode: 0o700 });
    const work = mkdtempSync(join(this.o.workDir, `${job.slug}-`));
    const mounted: string[] = [];
    try {
      const dst = join(work, 'dst');
      await this.mount(job.destination, dst, work, false, signal);
      mounted.push(dst);
      let src: string;
      if (job.source.kind === 'folder') src = job.source.path;
      else {
        src = join(work, 'src');
        await this.mount(job.source, src, work, true, signal);
        mounted.push(src);
      }
      const current = join(dst, job.slug, 'current');
      const kept = join(dst, job.slug, 'kept');
      mkdirSync(current, { recursive: true });
      // SMB devices keep no links and round times to two seconds.
      const args = [job.destination.kind === 'smb' ? '-rt' : '-rlt', '--modify-window=2', '--delete', '--backup', `--backup-dir=${join(kept, job.today)}`, '--stats', `${src.replace(/\/+$/, '')}/`, `${current}/`];
      const r = await this.run('rsync', args, { timeoutMs: 24 * 3600_000, signal });
      // 24: files vanished while copying (people were working): the rest is copied.
      if (r.code !== 0 && r.code !== 24) throw new Error(r.code === -1 ? 'rsync is not installed: add the files role again (sudo fbrx-server roles add files)' : `The copy stopped: ${tail(r.err || r.out)}`);
      const s = rsyncStats(r.out);
      const pruned = pruneKept(kept, job.today, job.keepDays);
      return { ...s, detail: `${s.files} file${s.files === 1 ? '' : 's'} copied${r.code === 24 ? ' (some changed while copying: they go next time)' : ''}${pruned ? `; ${pruned} old day${pruned === 1 ? '' : 's'} of kept files removed` : ''}` };
    } finally {
      for (const m of mounted.reverse()) await this.unmount(m);
      // Never recursive: a folder still mounted is the other device's files.
      for (const d of ['src', 'dst']) {
        try {
          rmdirSync(join(work, d));
        } catch {
          /* not made, or still mounted */
        }
      }
      try {
        rmdirSync(work);
      } catch {
        /* left for a look */
      }
    }
  }
}

/** mount's errors, in words. */
function mountWords(err: string): string {
  if (/Permission denied|error\(13\)|access denied/i.test(err)) return 'the sign-in was refused (check the account and password, and that it may write there)';
  if (/No such file|error\(2\)|does not exist/i.test(err)) return 'there is no such folder on the device';
  if (/Host is down|No route|timed out|error\(112\)|error\(113\)|Connection refused/i.test(err)) return 'the device does not answer (is it on, and is the address right?)';
  if (/wrong fs type|bad option|helper program/i.test(err)) return 'this server cannot open that kind of folder yet (cifs-utils or nfs-common missing: add the files role again)';
  return err || 'it failed';
}

// -------------------------------------------------------------------------------------------- simulated

/**
 * Pretend: shares are folders under root, other devices are folders under devices/ (one per path), accounts are only
 * remembered, and a backup is a small mirror with the same layout as the real one.
 */
export class SimulatedFilesSystem implements FilesSystem {
  readonly kind = 'simulated' as const;
  readonly root: string;
  readonly devices: string;
  readonly accounts = new Map<string, string>();
  shares = '';

  constructor(dir: string) {
    this.root = join(dir, 'shares');
    this.devices = join(dir, 'devices');
    mkdirSync(this.root, { recursive: true });
    mkdirSync(this.devices, { recursive: true });
  }

  async ready() {
    return { ready: true, why: null };
  }

  async makeFolder(name: string) {
    mkdirSync(join(this.root, name), { recursive: true });
  }

  async sizeOf(name: string) {
    return sizeOfTree(join(this.root, name));
  }

  async writeShares(text: string) {
    this.shares = text;
  }

  async setAccount(name: string, password: string) {
    this.accounts.set(name, password.length ? '*' : '');
  }

  async removeAccount(name: string) {
    this.accounts.delete(name);
  }

  /** The folder standing in for a device's path. */
  device(path: string): string {
    return join(this.devices, path.replace(/[\\/:]+/g, '_').replace(/^_+/, ''));
  }

  async backup(job: BackupJob, signal: AbortSignal): Promise<BackupResult> {
    const placeDir = (p: BackupPlace) => (p.kind === 'folder' ? p.path : this.device(p.path));
    for (const p of [job.source, job.destination]) if (p.kind === 'smb' && p.password.startsWith('wrong')) throw new Error(`${p.path} could not be opened: the sign-in was refused (check the account and password, and that it may write there)`);
    const src = placeDir(job.source);
    if (!existsSync(src)) throw new Error(`${job.source.kind === 'folder' ? 'The share' : job.source.path} could not be opened: there is no such folder on the device`);
    const dst = join(placeDir(job.destination), job.slug);
    const s = mirror(src, join(dst, 'current'), join(dst, 'kept', job.today), signal);
    const pruned = pruneKept(join(dst, 'kept'), job.today, job.keepDays);
    return { ...s, detail: `${s.files} file${s.files === 1 ? '' : 's'} copied${pruned ? `; ${pruned} old day${pruned === 1 ? '' : 's'} of kept files removed` : ''}` };
  }
}

function sizeOfTree(dir: string): number | null {
  if (!existsSync(dir)) return null;
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += sizeOfTree(join(dir, e.name)) ?? 0;
    else if (e.isFile()) n += statSync(join(dir, e.name)).size;
  }
  return n;
}

function files(dir: string, base = dir, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files(p, base, out);
    else if (e.isFile()) out.push(relative(base, p));
  }
  return out;
}

/** rsync -rt --delete --backup in a few lines: what changed or went is moved to kept first. */
export function mirror(src: string, dst: string, kept: string, signal?: AbortSignal): { files: number; bytes: number } {
  mkdirSync(dst, { recursive: true });
  const keep = (rel: string) => {
    const to = join(kept, rel);
    mkdirSync(dirname(to), { recursive: true });
    renameSync(join(dst, rel), to);
  };
  const have = new Set(files(src));
  let count = 0;
  let bytes = 0;
  for (const rel of have) {
    if (signal?.aborted) throw new Error('Stopped');
    const a = statSync(join(src, rel));
    const to = join(dst, rel);
    if (existsSync(to)) {
      const b = statSync(to);
      if (b.size === a.size && Math.abs(b.mtimeMs - a.mtimeMs) < 2000) continue;
      keep(rel);
    }
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(join(src, rel), to);
    utimesSync(to, a.atime, a.mtime);
    count++;
    bytes += a.size;
  }
  for (const rel of files(dst)) if (!have.has(rel)) keep(rel);
  return { files: count, bytes };
}
