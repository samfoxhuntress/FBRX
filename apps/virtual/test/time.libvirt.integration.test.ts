import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TimeImage } from '@fbrx/shared';
import { LibvirtHypervisor } from '../src/drivers/libvirt';
import { IMAGES_POOL, ISOS_POOL } from '../src/drivers/types';
import { LibvirtTimeDriver } from '../src/time/driver';

/**
 * FBRX Time against a real hypervisor (QEMU emulation is enough): a machine backed up while off and while it runs
 * (snapshot, copy, merge back), the image opened as a throwaway machine and deleted again, and a restore. Runs where
 * FBRX_TEST_LIBVIRT=1, like the libvirt driver's test. The machine has an empty disk, so the check sees the firmware's
 * "no bootable device" text: it must say so, not pass.
 */
const enabled = process.env.FBRX_TEST_LIBVIRT === '1';
const uri = process.env.FBRX_TEST_LIBVIRT_URI ?? 'qemu:///system';
const virsh = (...args: string[]) => {
  try {
    return execFileSync('virsh', ['-c', uri, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
};

describe.skipIf(!enabled)('FBRX Time with libvirt (real hypervisor)', () => {
  let dir: string;
  let hv: LibvirtHypervisor;
  const name = `fbrx-time-test-${process.pid}`;
  const restored = `${name}-restored`;
  let id = '';
  const facts = { cpus: 1, memoryMb: 256 };
  const driver = new LibvirtTimeDriver({ uri, facts: () => facts });
  const images: TimeImage[] = [];

  const image = (n: number, disks: TimeImage['disks'], consistency: TimeImage['consistency']): TimeImage => ({
    id: `0000000${n}-aaaa-bbbb-cccc-dddddddddddd`,
    source: 'vm',
    subject: name,
    jobId: null,
    createdAt: new Date().toISOString(),
    bytes: disks.reduce((a, d) => a + d.bytes, 0),
    disks,
    os: 'linux',
    firmware: 'bios',
    consistency,
    check: { state: 'none', at: null, seconds: null, detail: '', screenshot: null, agent: null },
    note: '',
  });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fbrx-time-libvirt-'));
    chmodSync(dir, 0o755); // QEMU runs as its own user and must reach the disks
    for (const p of [IMAGES_POOL, ISOS_POOL]) {
      virsh('pool-destroy', p);
      virsh('pool-undefine', p);
    }
    hv = new LibvirtHypervisor({ uri, imagesDir: join(dir, 'images'), isosDir: join(dir, 'isos') });
    await hv.prepare();
    const vm = await hv.createVm({ name, os: 'linux', cpus: 1, memoryMb: 256, diskGb: 1, network: { kind: 'network', source: 'default' }, firmware: 'bios' }, null);
    id = vm.id;
  }, 120_000);

  afterAll(async () => {
    for (const n of [name, restored, `fbrx-time-check-00000001`, `fbrx-time-check-00000002`]) {
      virsh('destroy', n);
      virsh('undefine', n, '--nvram', '--snapshots-metadata', '--remove-all-storage');
    }
    for (const p of [IMAGES_POOL, ISOS_POOL]) {
      virsh('pool-destroy', p);
      virsh('pool-undefine', p);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('copies a machine that is off', async () => {
    const out = join(dir, 'repo', 'off');
    const r = await driver.backupVm(await hv.getVm(id), out, () => undefined);
    expect(r.consistency).toBe('offline');
    expect(r.domainXml).toContain(`<name>${name}</name>`);
    expect(r.disks).toHaveLength(1);
    expect(r.disks[0]).toMatchObject({ format: 'qcow2', virtualBytes: 1024 ** 3 });
    expect(existsSync(join(out, r.disks[0]!.file))).toBe(true);
    images.push(image(1, r.disks, r.consistency));
  }, 120_000);

  it('copies a running machine from a moment-in-time snapshot and merges its writes back', async () => {
    await hv.power(id, 'start');
    const before = virsh('domblklist', name);
    const out = join(dir, 'repo', 'live');
    const pct: number[] = [];
    const r = await driver.backupVm(await hv.getVm(id), out, (p) => pct.push(p));
    // No guest agent in an empty machine: copied like pulling the plug.
    expect(r.consistency).toBe('crash');
    expect(pct.at(-1)).toBe(100);
    // Back on its own disk, with no overlay left behind.
    expect(virsh('domblklist', name)).toBe(before);
    expect(readdirSync(join(dir, 'images')).filter((f) => f.includes('.fbrx-time-'))).toEqual([]);
    images.push(image(2, r.disks, r.consistency));
    await hv.power(id, 'stop');
  }, 180_000);

  it('opens an image as a throwaway machine with no network, looks at it, and deletes it', async () => {
    const img = images[0]!;
    const scratch = join(dir, 'lab', 'one');
    const check = await driver.bootCheck(img, join(dir, 'repo', 'off'), scratch, 15);
    // An empty disk: the firmware says there is nothing to start, in text.
    expect(check.state).not.toBe('passed');
    expect(check.detail.length).toBeGreaterThan(10);
    expect(virsh('list', '--all', '--name')).not.toContain('fbrx-time-check-');
    expect(existsSync(scratch)).toBe(false);
    if (check.screenshot) expect(existsSync(join(dir, 'repo', 'off', check.screenshot))).toBe(true);
  }, 120_000);

  it('makes a new, stopped machine from an image', async () => {
    const r = await driver.restore(images[1]!, join(dir, 'repo', 'live'), restored, join(dir, 'images'));
    expect(r.vmName).toBe(restored);
    expect(virsh('domstate', restored).trim()).toBe('shut off');
    expect(existsSync(join(dir, 'images', `${restored}-vda.qcow2`))).toBe(true);
  }, 120_000);
});
