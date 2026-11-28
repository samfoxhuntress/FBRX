import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TimeDrive } from '@fbrx/shared';
import { mountPlace, run, unmountPlace, type MountPlace, type Runner } from '../files/system';

/**
 * Copies of FBRX Time's images off the server: a shared folder on a NAS (SMB), an NFS export, or a drive plugged into
 * the server. Images stay on the server (boot checks and restores use them there); each new one is also copied out,
 * and the place keeps as many of each machine or computer as asked. At the place, everything is in one folder:
 *
 *   FBRX Time/<machine or computer>/<when>-<id>/   the image's files and image.json (what it is)
 *
 * A copy is made under a .part name and renamed when complete, so a half-made copy never looks like an image.
 */

export const COPY_FOLDER = 'FBRX Time';

export interface TimeCopier {
  readonly kind: 'linux' | 'simulated';
  /** Drives plugged into the server that copies could go to (not the server's own disks). */
  drives(): Promise<TimeDrive[]>;
  /** Opens the place, writes and removes a small file there, and closes it: throws, in words, when it cannot. */
  test(place: MountPlace, signal: AbortSignal): Promise<void>;
  /** Copies an image's folder to the place as <subject>/<name>, then keeps the newest `keep` there. */
  copy(place: MountPlace, from: string, subject: string, name: string, manifest: unknown, keep: number, signal: AbortSignal): Promise<{ pruned: number }>;
}

/** Keeps the newest `keep` image folders of a subject (their names start with when they were made); drops leftovers. */
export function pruneCopies(dir: string, keep: number): number {
  let names: string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return 0;
  }
  // A .part folder is a copy that never finished (the server stopped, the drive went away).
  for (const n of names.filter((n) => n.endsWith('.part'))) rmSync(join(dir, n), { recursive: true, force: true });
  const done = names.filter((n) => !n.endsWith('.part') && /^\d{4}-\d{2}-\d{2}T\d{6}-/.test(n)).sort().reverse();
  for (const n of done.slice(Math.max(1, keep))) rmSync(join(dir, n), { recursive: true, force: true });
  return Math.max(0, done.length - Math.max(1, keep));
}

const FILE_SYSTEMS = new Set(['ext4', 'ext3', 'ext2', 'xfs', 'btrfs', 'exfat', 'ntfs', 'ntfs3', 'vfat']);

interface LsblkDevice {
  name?: string;
  uuid?: string | null;
  label?: string | null;
  size?: number | string | null;
  fstype?: string | null;
  tran?: string | null;
  hotplug?: boolean | string | null;
  mountpoint?: string | null;
  model?: string | null;
  children?: LsblkDevice[];
}

/** The drives in `lsblk -J -b -o NAME,UUID,LABEL,SIZE,FSTYPE,TRAN,HOTPLUG,MOUNTPOINT,MODEL` that copies could go to. */
export function parseDrives(json: string): TimeDrive[] {
  let tree: { blockdevices?: LsblkDevice[] };
  try {
    tree = JSON.parse(json) as { blockdevices?: LsblkDevice[] };
  } catch {
    return [];
  }
  const out: TimeDrive[] = [];
  const yes = (v: unknown) => v === true || v === '1' || v === 1;
  for (const disk of tree.blockdevices ?? []) {
    // Only drives that can be plugged in and out (USB and the like): never the disks the server runs on.
    if (!(yes(disk.hotplug) || disk.tran === 'usb')) continue;
    for (const p of [disk, ...(disk.children ?? [])]) {
      if (!p.uuid || !p.fstype || !FILE_SYSTEMS.has(p.fstype)) continue;
      if (p.mountpoint && /^\/(boot|efi)?$|^\[SWAP\]$/.test(p.mountpoint)) continue;
      out.push({ uuid: p.uuid, label: (p.label ?? '').slice(0, 60), sizeBytes: Number(p.size) || 0, fileSystem: p.fstype, model: (disk.model ?? '').trim().slice(0, 60), mountedAt: p.mountpoint ?? null });
    }
  }
  return out;
}

export interface LinuxCopierOptions {
  /** Scratch space for mount points and credentials files (root only). */
  workDir: string;
  run?: Runner;
}

export class LinuxTimeCopier implements TimeCopier {
  readonly kind = 'linux' as const;
  private readonly run: Runner;

  constructor(private readonly o: LinuxCopierOptions) {
    this.run = o.run ?? run;
  }

  async drives(): Promise<TimeDrive[]> {
    const r = await this.run('lsblk', ['-J', '-b', '-o', 'NAME,UUID,LABEL,SIZE,FSTYPE,TRAN,HOTPLUG,MOUNTPOINT,MODEL'], { timeoutMs: 20_000 });
    return r.code === 0 ? parseDrives(r.out) : [];
  }

  /** Opens the place for `fn` and always closes it again (a drive can be unplugged between copies). */
  private async open<T>(place: MountPlace, signal: AbortSignal, fn: (root: string) => Promise<T> | T): Promise<T> {
    // A drive the system already mounted (a desktop did) is used where it is.
    if (place.kind === 'drive') {
      const there = (await this.drives()).find((d) => d.uuid === place.uuid)?.mountedAt;
      if (there) return fn(there);
    }
    mkdirSync(this.o.workDir, { recursive: true, mode: 0o700 });
    const work = mkdtempSync(join(this.o.workDir, 'time-'));
    const at = join(work, 'dst');
    let mounted = false;
    try {
      await mountPlace(this.run, place, at, work, false, signal);
      mounted = true;
      return await fn(at);
    } finally {
      if (mounted) await unmountPlace(this.run, at);
      // Never recursive: a folder still mounted is the other device's files.
      for (const d of [at, work]) {
        try {
          rmdirSync(d);
        } catch {
          /* not made, or still mounted */
        }
      }
    }
  }

  async test(place: MountPlace, signal: AbortSignal): Promise<void> {
    await this.open(place, signal, (root) => {
      const probe = join(root, `.fbrx-time-test-${process.pid}`);
      try {
        writeFileSync(probe, 'FBRX Time can write here\n');
      } catch (e) {
        throw new Error(`It opened, but FBRX Time cannot write there: ${(e as Error).message}`);
      }
      rmSync(probe, { force: true });
    });
  }

  async copy(place: MountPlace, from: string, subject: string, name: string, manifest: unknown, keep: number, signal: AbortSignal): Promise<{ pruned: number }> {
    return this.open(place, signal, async (root) => {
      const dir = join(root, COPY_FOLDER, subject);
      const part = join(dir, `${name}.part`);
      mkdirSync(part, { recursive: true });
      // SMB devices keep no links and round times to two seconds.
      const r = await this.run('rsync', [place.kind === 'smb' ? '-rt' : '-rlt', '--modify-window=2', `${from.replace(/\/+$/, '')}/`, `${part}/`], { timeoutMs: 24 * 3600_000, signal });
      if (r.code !== 0) throw new Error(r.code === -1 ? 'rsync is not installed (sudo apt install rsync)' : `The copy stopped: ${(r.err || r.out).trim().split('\n').slice(-2).join(' ').slice(0, 300)}`);
      writeFileSync(join(part, 'image.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      rmSync(join(dir, name), { recursive: true, force: true });
      renameSync(part, join(dir, name));
      return { pruned: pruneCopies(dir, keep) };
    });
  }
}

/** Development and tests: each place is a folder under `root`, and a copy is a plain copy. */
export class SimulatedTimeCopier implements TimeCopier {
  readonly kind = 'simulated' as const;
  constructor(private readonly root: string) {}

  private folder(place: MountPlace) {
    const key = place.kind === 'drive' ? `drive-${place.uuid}` : `${place.kind}-${place.path}`;
    return join(this.root, key.replace(/[^A-Za-z0-9._-]+/g, '_'));
  }

  async drives(): Promise<TimeDrive[]> {
    return [{ uuid: '6F2A-91C4', label: 'BACKUP', sizeBytes: 2 * 1024 ** 4, fileSystem: 'exfat', model: 'USB drive (simulated)', mountedAt: null }];
  }

  async test(place: MountPlace): Promise<void> {
    if (place.kind === 'drive' && !(await this.drives()).some((d) => d.uuid === place.uuid)) throw new Error('The drive could not be opened (is it plugged in?)');
    if (place.kind === 'smb' && place.password === 'wrong') throw new Error(`${place.path} could not be opened: the account or password is wrong`);
    mkdirSync(this.folder(place), { recursive: true });
  }

  async copy(place: MountPlace, from: string, subject: string, name: string, manifest: unknown, keep: number): Promise<{ pruned: number }> {
    const dir = join(this.folder(place), COPY_FOLDER, subject);
    mkdirSync(dir, { recursive: true });
    if (existsSync(join(dir, name))) rmSync(join(dir, name), { recursive: true, force: true });
    cpSync(from, join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, 'image.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return { pruned: pruneCopies(dir, keep) };
  }
}
