import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LinuxTimeCopier, parseDrives, pruneCopies } from '../src/time/copy-out';
import type { Runner } from '../src/files/system';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), 'fbrx-copy-'));
  dirs.push(d);
  return d;
};

const LSBLK = JSON.stringify({
  blockdevices: [
    { name: 'nvme0n1', hotplug: false, tran: 'nvme', model: 'Server SSD', children: [{ name: 'nvme0n1p2', uuid: 'aaaa-root', fstype: 'ext4', size: 1e12, mountpoint: '/' }] },
    { name: 'sda', hotplug: true, tran: 'usb', model: 'Portable Drive ', children: [{ name: 'sda1', uuid: '6F2A-91C4', label: 'BACKUP', fstype: 'exfat', size: 2e12, mountpoint: null }] },
    { name: 'sdb', hotplug: '1', tran: 'usb', model: 'Stick', children: [{ name: 'sdb1', uuid: null, fstype: null, size: 8e9 }] },
  ],
});

describe('copies of images off the server', () => {
  it('offers only drives that can be plugged in, with a file system', () => {
    expect(parseDrives(LSBLK)).toEqual([{ uuid: '6F2A-91C4', label: 'BACKUP', sizeBytes: 2e12, fileSystem: 'exfat', model: 'Portable Drive', mountedAt: null }]);
    expect(parseDrives('not json')).toEqual([]);
  });

  it('keeps the newest copies of a machine and clears copies that never finished', () => {
    const d = temp();
    for (const n of ['2026-11-20T010000-aaaa', '2026-11-21T010000-bbbb', '2026-11-22T010000-cccc', '2026-11-23T010000-dddd.part', 'notes']) mkdirSync(join(d, n));
    expect(pruneCopies(d, 2)).toBe(1);
    expect(readdirSync(d).sort()).toEqual(['2026-11-21T010000-bbbb', '2026-11-22T010000-cccc', 'notes']);
  });

  it('opens a drive by its UUID, copies with rsync under a .part name, and always closes it', async () => {
    const calls: string[][] = [];
    const run: Runner = async (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === 'lsblk') return { code: 0, out: LSBLK, err: '' };
      if (cmd === 'rsync') {
        // Stands in for rsync: the destination is the last argument.
        writeFileSync(join(args.at(-1)!, 'disk-vda.qcow2'), 'disk');
        return { code: 0, out: '', err: '' };
      }
      return { code: 0, out: '', err: '' };
    };
    const work = temp();
    const copier = new LinuxTimeCopier({ workDir: work, run });
    const from = temp();
    await copier.copy({ kind: 'drive', uuid: '6F2A-91C4' }, from, 'files-01', '2026-11-23T010000-abcd1234', { subject: 'files-01' }, 3, new AbortController().signal);
    const mount = calls.find((c) => c[0] === 'mount')!;
    expect(mount.slice(0, 2)).toEqual(['mount', 'UUID=6F2A-91C4']);
    const rsync = calls.find((c) => c[0] === 'rsync')!;
    expect(rsync[1]).toBe('-rlt');
    expect(rsync.at(-1)!.replace(/\\/g, '/')).toMatch(/FBRX Time\/files-01\/2026-11-23T010000-abcd1234\.part\/$/);
    expect(calls.at(-1)![0]).toBe('umount');
    // A drive that will not open is said in words, and nothing is left mounted.
    const failing: Runner = async (cmd) => (cmd === 'mount' ? { code: 32, out: '', err: "mount: /x: can't find UUID=6F2A-91C4." } : cmd === 'lsblk' ? { code: 0, out: '{"blockdevices":[]}', err: '' } : { code: 0, out: '', err: '' });
    await expect(new LinuxTimeCopier({ workDir: work, run: failing }).test({ kind: 'drive', uuid: '6F2A-91C4' }, new AbortController().signal)).rejects.toThrow(/is it plugged in/);
  });
});
