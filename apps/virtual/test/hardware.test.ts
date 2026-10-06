import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Db } from '@fbrx/shared/node';
import { compactCpus, expandCpus, parseInterrupts, readTopology, resetPciIds } from '../src/hardware/topology';
import { FlowSampler, readCounters } from '../src/hardware/flows';
import { HardwareService } from '../src/hardware/service';
import { SimulatedHypervisor } from '../src/drivers/simulated';
import { VIRTUAL_MIGRATIONS } from '../src/migrations';

let root: string;

function put(p: string, text: string) {
  mkdirSync(join(root, p, '..'), { recursive: true });
  writeFileSync(join(root, p), text);
}

/** A small two-socket server: a bridge with a 10 GbE card on node 1, a RAID card on node 0 with two disks. */
function fixture() {
  const devs = join(root, 'sys/devices/pci0000:00');
  const nic = join(devs, '0000:00:03.0/0000:05:00.0');
  const raid = join(devs, '0000:01:00.0');
  for (const d of [join(devs, '0000:00:03.0'), nic, raid]) mkdirSync(d, { recursive: true });
  const dev = (dir: string, cls: string, vendor: string, device: string, numa: number, driver: string, group: number) => {
    writeFileSync(join(dir, 'class'), cls);
    writeFileSync(join(dir, 'vendor'), vendor);
    writeFileSync(join(dir, 'device'), device);
    writeFileSync(join(dir, 'numa_node'), String(numa));
    mkdirSync(join(root, 'sys/bus/pci/drivers', driver), { recursive: true });
    symlinkSync(join(root, 'sys/bus/pci/drivers', driver), join(dir, 'driver'));
    mkdirSync(join(root, 'sys/kernel/iommu_groups', String(group)), { recursive: true });
    symlinkSync(join(root, 'sys/kernel/iommu_groups', String(group)), join(dir, 'iommu_group'));
  };
  dev(join(devs, '0000:00:03.0'), '0x060400', '0x8086', '0x6f08', 1, 'pcieport', 3);
  dev(nic, '0x020000', '0x8086', '0x10fb', 1, 'ixgbe', 30);
  writeFileSync(join(nic, 'current_link_speed'), '5.0 GT/s PCIe');
  writeFileSync(join(nic, 'current_link_width'), '8');
  writeFileSync(join(nic, 'max_link_speed'), '5.0 GT/s PCIe');
  writeFileSync(join(nic, 'max_link_width'), '8');
  mkdirSync(join(nic, 'msi_irqs/60'), { recursive: true });
  mkdirSync(join(nic, 'msi_irqs/61'), { recursive: true });
  mkdirSync(join(nic, 'net/eth2/statistics'), { recursive: true });
  writeFileSync(join(nic, 'net/eth2/statistics/rx_bytes'), '1000');
  writeFileSync(join(nic, 'net/eth2/statistics/tx_bytes'), '500');
  dev(raid, '0x010400', '0x1000', '0x005f', 0, 'megaraid_sas', 12);
  writeFileSync(join(raid, 'irq'), '40');
  mkdirSync(join(raid, 'host0/target0:2:0/0:2:0:0/block/sda'), { recursive: true });
  writeFileSync(join(raid, 'host0/target0:2:0/0:2:0:0/block/sda/stat'), '100 0 2048 0 50 0 4096 0 0 0 0');
  mkdirSync(join(root, 'sys/bus/pci/devices'), { recursive: true });
  for (const [a, d] of [['0000:00:03.0', join(devs, '0000:00:03.0')], ['0000:05:00.0', nic], ['0000:01:00.0', raid]] as const) symlinkSync(d, join(root, 'sys/bus/pci/devices', a));
  mkdirSync(join(root, 'sys/class/net'), { recursive: true });
  symlinkSync(join(nic, 'net/eth2'), join(root, 'sys/class/net/eth2'));
  mkdirSync(join(root, 'sys/class/net/lo/statistics'), { recursive: true });
  mkdirSync(join(root, 'sys/block'), { recursive: true });
  symlinkSync(join(raid, 'host0/target0:2:0/0:2:0:0/block/sda'), join(root, 'sys/block/sda'));
  put('sys/devices/system/node/node0/cpulist', '0-3\n');
  put('sys/devices/system/node/node0/meminfo', 'Node 0 MemTotal:       16384000 kB\n');
  put('sys/devices/system/node/node1/cpulist', '4-7\n');
  put('sys/devices/system/node/node1/meminfo', 'Node 1 MemTotal:       16384000 kB\n');
  put('sys/devices/system/cpu/cpu0/topology/physical_package_id', '0');
  put('sys/devices/system/cpu/cpu4/topology/physical_package_id', '1');
  put('proc/cpuinfo', 'processor\t: 0\nmodel name\t: Sample Xeon   E5-2620 v4 @ 2.10GHz\n');
  put('proc/interrupts', '           CPU0       CPU1\n 40:   10   20   IR-IO-APIC   40-fasteoi   megasas\n 60:   5    6    IR-PCI-MSI 1  0-edge      eth2-TxRx-0\n 61:   1    1    IR-PCI-MSI 2  0-edge      eth2-TxRx-1\n');
  for (const irq of [40, 60, 61]) {
    put(`proc/irq/${irq}/smp_affinity_list`, '0-7\n');
    put(`proc/irq/${irq}/effective_affinity_list`, '0\n');
  }
  put('usr/share/misc/pci.ids', '8086  Intel Corporation\n\t10fb  82599ES 10-Gigabit SFI/SFP+ Network Connection\n\t6f08  Xeon E7 v4/Xeon E5 v4 PCI Express Root Port 3\n1000  Broadcom / LSI\n\t005f  MegaRAID SAS-3 3008 [Fury]\nC 00  Unclassified device\n');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fbrx-hw-'));
  resetPciIds();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('processor lists', () => {
  it('expands and compacts', () => {
    expect(expandCpus('0-3,8,10-11')).toEqual([0, 1, 2, 3, 8, 10, 11]);
    expect(compactCpus([11, 10, 0, 1, 2, 3, 8])).toBe('0-3,8,10-11');
    expect(parseInterrupts('  CPU0 CPU1\n 9:  1 2  IO-APIC 9-fasteoi acpi\n').get(9)?.name).toBe('acpi');
  });
});

// The fixtures use symbolic links like sysfs does (Windows needs special rights for those).
describe.skipIf(process.platform === 'win32')('hardware topology', () => {
  it('reads nodes, the PCI tree, what sits on each device and its interrupts', () => {
    fixture();
    const t = readTopology({ root, passthrough: new Map([['0000:05:00.0', 'router']]) });
    expect(t.source).toBe('system');
    expect(t.totalCpus).toBe(8);
    expect(t.nodes).toEqual([
      { node: 0, cpus: '0-3', cpuCount: 4, memoryMb: 16000, model: 'Sample Xeon E5-2620 v4 @ 2.10GHz', socket: 0 },
      { node: 1, cpus: '4-7', cpuCount: 4, memoryMb: 16000, model: 'Sample Xeon E5-2620 v4 @ 2.10GHz', socket: 1 },
    ]);
    const nic = t.devices.find((d) => d.address === '0000:05:00.0')!;
    expect(nic).toMatchObject({ parent: '0000:00:03.0', kind: 'network', name: '82599ES 10-Gigabit SFI/SFP+ Network Connection', vendor: 'Intel Corporation', driver: 'ixgbe', numaNode: 1, iommuGroup: 30, interfaces: ['eth2'], passthroughVm: 'router' });
    expect(nic.link).toEqual({ speed: '5.0 GT/s PCIe', width: 8, maxSpeed: '5.0 GT/s PCIe', maxWidth: 8 });
    expect(nic.irqs).toEqual([
      { irq: 60, name: 'eth2-TxRx-0', cpus: '0-7', effective: '0' },
      { irq: 61, name: 'eth2-TxRx-1', cpus: '0-7', effective: '0' },
    ]);
    const raid = t.devices.find((d) => d.address === '0000:01:00.0')!;
    expect(raid).toMatchObject({ parent: null, kind: 'storage', name: 'MegaRAID SAS-3 3008 [Fury]', numaNode: 0, interfaces: ['sda'] });
    expect(raid.irqs.map((i) => i.irq)).toEqual([40]);
  });

  it('shows a sample server where there is no sysfs', () => {
    const t = readTopology({ root: join(root, 'nothing') });
    expect(t.source).toBe('sample');
    expect(t.devices.some((d) => d.kind === 'network')).toBe(true);
  });

  it('measures data flow per port and disk', async () => {
    fixture();
    expect(readCounters(root)).toEqual([
      { id: 'eth2', kind: 'network', device: '0000:05:00.0', rx: 1000, tx: 500 },
      { id: 'sda', kind: 'disk', device: '0000:01:00.0', rx: 2048 * 512, tx: 4096 * 512 },
    ]);
    const s = new FlowSampler(root);
    await s.flows();
    writeFileSync(join(root, 'sys/class/net/eth2/statistics/rx_bytes'), '1001000');
    const f = await s.flows();
    const eth = f.items.find((i) => i.id === 'eth2')!;
    expect(eth.rxBps).toBeGreaterThan(0);
    expect(eth.txBps).toBe(0);
  });

  it('moves a device’s interrupts, remembers it and puts it back after a restart', async () => {
    fixture();
    const db = new Db(':memory:');
    db.migrate(VIRTUAL_MIGRATIONS);
    const hv = new SimulatedHypervisor({ dataDir: join(root, 'data'), isosDir: join(root, 'isos'), seed: false });
    const hw = new HardwareService(db, hv, root);
    const r = await hw.setDeviceIrqs('0000:05:00.0', '4-7');
    expect(r.refused).toEqual([]);
    expect(readFileSync(join(root, 'proc/irq/60/smp_affinity_list'), 'utf8').trim()).toBe('4-7');
    expect(readFileSync(join(root, 'proc/irq/61/smp_affinity_list'), 'utf8').trim()).toBe('4-7');
    expect(hw.pinned()).toEqual({ '0000:05:00.0': '4-7' });
    await expect(hw.setDeviceIrqs('0000:05:00.0', '0-9')).rejects.toThrow(/processors 0-7/);
    // Linux forgets on restart; FBRX Virtual puts it back.
    writeFileSync(join(root, 'proc/irq/60/smp_affinity_list'), '0-7\n');
    await hw.applyPinned();
    expect(readFileSync(join(root, 'proc/irq/60/smp_affinity_list'), 'utf8').trim()).toBe('4-7');
    await hw.setDeviceIrqs('0000:05:00.0', null);
    expect(readFileSync(join(root, 'proc/irq/61/smp_affinity_list'), 'utf8').trim()).toBe('0-7');
    expect(hw.pinned()).toEqual({});
    db.close();
  });
});
