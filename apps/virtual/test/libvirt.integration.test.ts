import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LibvirtHypervisor } from '../src/drivers/libvirt';
import { IMAGES_POOL, ISOS_POOL } from '../src/drivers/types';

/**
 * Real virtual machines through libvirt (QEMU emulation is enough). Runs where FBRX_TEST_LIBVIRT=1 and libvirt is set
 * up (the CI's libvirt job, or an FBRX Server). It makes its own pools and networks and removes them afterwards.
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

describe.skipIf(!enabled)('libvirt driver (real hypervisor)', () => {
  let dir: string;
  let hv: LibvirtHypervisor;
  const name = `fbrx-test-${process.pid}`;
  const net = `fbrxt${process.pid % 10000}`;
  let id = '';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'fbrx-libvirt-'));
    chmodSync(dir, 0o755); // QEMU runs as its own user and must reach the disks
    for (const p of [IMAGES_POOL, ISOS_POOL]) {
      virsh('pool-destroy', p);
      virsh('pool-undefine', p);
    }
    hv = new LibvirtHypervisor({ uri, imagesDir: join(dir, 'images'), isosDir: join(dir, 'isos') });
    await hv.prepare();
    writeFileSync(join(dir, 'isos', 'blank.iso'), Buffer.alloc(64 * 1024));
    await hv.refreshPool(ISOS_POOL);
  }, 120_000);

  afterAll(async () => {
    virsh('destroy', name);
    virsh('undefine', name, '--nvram', '--snapshots-metadata', '--remove-all-storage');
    virsh('undefine', `${name}-uefi`, '--nvram', '--snapshots-metadata', '--remove-all-storage');
    virsh('net-destroy', net);
    virsh('net-undefine', net);
    for (const p of [IMAGES_POOL, ISOS_POOL]) {
      virsh('pool-destroy', p);
      virsh('pool-undefine', p);
    }
    rmSync(dir, { recursive: true, force: true });
  }, 120_000);

  it('knows the hypervisor and has its pools', async () => {
    const info = await hv.info();
    expect(info.driver).toBe('libvirt');
    expect(info.version).toBeTruthy();
    const pools = await hv.pools();
    expect(pools.find((p) => p.role === 'images')).toMatchObject({ name: IMAGES_POOL, active: true, path: join(dir, 'images') });
    expect((await hv.volumes(ISOS_POOL)).map((v) => v.name)).toEqual(['blank.iso']);
  });

  it('creates and starts a machine with an ISO in its CD drive', async () => {
    const vm = await hv.createVm({ name, os: 'linux', cpus: 1, memoryMb: 256, diskGb: 1, network: { kind: 'network', source: 'default' }, firmware: 'bios', description: 'FBRX test', startNow: true }, join(dir, 'isos', 'blank.iso'));
    id = vm.id;
    expect(vm).toMatchObject({ name, state: 'running', cpus: 1, memoryMb: 256, firmware: 'bios', description: 'FBRX test', console: true });
    expect(vm.disks.find((d) => d.device === 'disk')).toMatchObject({ target: 'vda', sizeGb: 1 });
    expect(vm.iso).toBe(join(dir, 'isos', 'blank.iso'));
    expect((await hv.listVms()).some((v) => v.id === id && v.state === 'running')).toBe(true);
    const ep = await hv.consoleEndpoint(id);
    expect(ep?.port).toBeGreaterThanOrEqual(5900);
    expect((await hv.volumes(ISOS_POOL))[0]!.usedBy).toEqual([name]);
  }, 120_000);

  it('takes, lists and goes back to snapshots', async () => {
    await hv.createSnapshot(id, 'first', 'Before changes');
    const snaps = await hv.snapshots(id);
    expect(snaps).toMatchObject([{ name: 'first', description: 'Before changes', state: 'running', current: true }]);
    await hv.revertSnapshot(id, 'first');
    await hv.deleteSnapshot(id, 'first');
    expect(await hv.snapshots(id)).toEqual([]);
  }, 120_000);

  it('changes the machine (next start for processors and memory, now for the CD and placement)', async () => {
    const vm = await hv.updateVm(id, { cpus: 2, memoryMb: 512, description: 'Changed', cpuset: '0', autostart: true }, null);
    expect(vm.iso).toBeNull();
    expect(vm.autostart).toBe(true);
    expect(vm.cpuset).toBe('0');
    expect(virsh('dumpxml', id, '--inactive')).toContain("<vcpu placement='static' cpuset='0'>2</vcpu>");
    await hv.power(id, 'stop');
    const grown = await hv.updateVm(id, { diskGb: 2 }, undefined);
    expect(grown.disks.find((d) => d.device === 'disk')?.sizeGb).toBe(2);
    expect(grown).toMatchObject({ state: 'stopped', cpus: 2, memoryMb: 512 });
  }, 120_000);

  it('snapshots UEFI machines while they are off', async () => {
    const vm = await hv.createVm({ name: `${name}-uefi`, os: 'linux', cpus: 1, memoryMb: 256, diskGb: 1, network: { kind: 'network', source: 'default' }, firmware: 'uefi', startNow: true }, null);
    expect(vm.firmware).toBe('uefi');
    await expect(hv.createSnapshot(vm.id, 's1', '')).rejects.toThrow(/off/);
    await hv.power(vm.id, 'stop');
    await hv.createSnapshot(vm.id, 's1', '');
    await hv.createSnapshot(vm.id, 's2', '');
    await hv.revertSnapshot(vm.id, 's1');
    await hv.deleteVm(vm.id, true);
    expect((await hv.listVms()).some((v) => v.id === vm.id)).toBe(false);
  }, 180_000);

  it('makes and removes networks', async () => {
    const n = await hv.createNetwork({ name: net, kind: 'isolated', subnet: '10.231.7.0/24' });
    expect(n).toMatchObject({ name: net, kind: 'isolated', active: true, subnet: '10.231.7.0/24', managed: true });
    await hv.deleteNetwork(net);
    expect((await hv.networks()).some((x) => x.name === net)).toBe(false);
  }, 60_000);

  it('deletes the machine and its disk', async () => {
    await expect(hv.deleteVm(id, true)).resolves.toBeUndefined();
    expect((await hv.volumes(IMAGES_POOL)).some((v) => v.name === `${name}.qcow2`)).toBe(false);
  }, 60_000);
});
