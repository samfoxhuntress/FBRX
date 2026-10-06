import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { HwCpuNode, HwDevice, HwDeviceKind, HwTopology } from '@fbrx/shared';

/**
 * The server's hardware as Linux sees it: processor sockets / NUMA nodes, the PCI tree hanging off them, what sits on
 * each device (network ports, disks) and which processors handle each device's interrupts. Everything is read from
 * sysfs and procfs under `root` ("/" on a server, a folder of fixtures in tests).
 */

export const PCI_RE = /^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/i;

const read = (p: string): string | null => {
  try {
    return readFileSync(p, 'utf8').trim();
  } catch {
    return null;
  }
};
const list = (p: string): string[] => {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
};
const link = (p: string): string | null => {
  try {
    return basename(readlinkSync(p));
  } catch {
    return null;
  }
};

/** "0-3,8-11" → [0,1,2,3,8,9,10,11]. */
export function expandCpus(s: string): number[] {
  const out: number[] = [];
  for (const part of s.split(',')) {
    const m = /^\s*(\d+)(?:-(\d+))?\s*$/.exec(part);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    for (let i = a; i <= b && i - a < 4096; i++) out.push(i);
  }
  return out;
}

/** [0,1,2,3,8] → "0-3,8". */
export function compactCpus(cpus: number[]): string {
  const s = [...new Set(cpus)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j]! + 1) j++;
    parts.push(i === j ? `${s[i]}` : `${s[i]}-${s[j]}`);
    i = j + 1;
  }
  return parts.join(',');
}

// ------------------------------------------------------------------------------------- names

interface PciIds {
  vendors: Map<string, { name: string; devices: Map<string, string> }>;
}
let pciIds: PciIds | null = null;

/** pci.ids (from the pciutils / hwdata packages): every vendor and device name. */
function loadPciIds(root: string): PciIds {
  if (pciIds) return pciIds;
  const vendors: PciIds['vendors'] = new Map();
  for (const f of ['usr/share/misc/pci.ids', 'usr/share/hwdata/pci.ids', 'usr/share/pci.ids']) {
    const text = read(join(root, f));
    if (!text) continue;
    let cur: { name: string; devices: Map<string, string> } | null = null;
    for (const line of text.split('\n')) {
      if (line.startsWith('C ')) break; // device classes follow; not needed
      if (!line || line.startsWith('#')) continue;
      const v = /^([0-9a-f]{4})\s+(.+)$/.exec(line);
      if (v) {
        cur = { name: v[2]!, devices: new Map() };
        vendors.set(v[1]!, cur);
        continue;
      }
      const d = /^\t([0-9a-f]{4})\s+(.+)$/.exec(line);
      if (d && cur) cur.devices.set(d[1]!, d[2]!);
    }
    break;
  }
  pciIds = { vendors };
  return pciIds;
}

/** For tests: forget the loaded name database. */
export function resetPciIds() {
  pciIds = null;
}

const COMMON_VENDORS: Record<string, string> = {
  '8086': 'Intel',
  '14e4': 'Broadcom',
  '1000': 'Broadcom / LSI',
  '15b3': 'Mellanox',
  '10de': 'NVIDIA',
  '1002': 'AMD',
  '1022': 'AMD',
  '1af4': 'Red Hat (virtio)',
  '1b36': 'Red Hat (QEMU)',
  '102b': 'Matrox',
  '10ec': 'Realtek',
  '144d': 'Samsung',
  '1b4b': 'Marvell',
  '1077': 'QLogic',
  '19a2': 'Emulex',
  '1924': 'Solarflare',
  '1d6a': 'Aquantia',
  '1344': 'Micron',
  '15ad': 'VMware',
  '1414': 'Microsoft',
};

const CLASS_NAMES: Record<string, string> = {
  '0100': 'SCSI storage controller',
  '0101': 'IDE controller',
  '0104': 'RAID controller',
  '0106': 'SATA controller',
  '0107': 'SAS controller',
  '0108': 'NVMe drive',
  '0200': 'Ethernet controller',
  '0207': 'InfiniBand controller',
  '0280': 'Network controller',
  '0300': 'Display controller',
  '0302': '3D controller',
  '0403': 'Audio device',
  '0500': 'Memory controller',
  '0600': 'Host bridge',
  '0601': 'ISA bridge',
  '0604': 'PCI bridge',
  '0780': 'Communication controller',
  '0805': 'SD host controller',
  '0880': 'System peripheral',
  '0c03': 'USB controller',
  '0c05': 'SMBus',
  '1180': 'Signal processing controller',
};

export function kindOf(classCode: string): HwDeviceKind {
  const c = classCode.replace(/^0x/i, '').toLowerCase();
  if (c.startsWith('02')) return 'network';
  if (c.startsWith('01')) return 'storage';
  if (c.startsWith('03')) return 'display';
  if (c.startsWith('0c03')) return 'usb';
  if (c.startsWith('06')) return 'bridge';
  return 'other';
}

// ------------------------------------------------------------------------------- interrupts

export interface IrqLine {
  irq: number;
  name: string;
}

/** /proc/interrupts: each numbered line's last column (the driver's name for it). */
export function parseInterrupts(text: string): Map<number, IrqLine> {
  const out = new Map<number, IrqLine>();
  const lines = text.split('\n');
  const cpuCount = (lines[0] ?? '').trim().split(/\s+/).filter(Boolean).length;
  for (const line of lines.slice(1)) {
    const m = /^\s*(\d+):\s+(.*)$/.exec(line);
    if (!m) continue;
    const rest = m[2]!.trim().split(/\s+/);
    const tail = rest.slice(cpuCount);
    out.set(Number(m[1]), { irq: Number(m[1]), name: tail.at(-1) ?? '' });
  }
  return out;
}

function irqbalanceRunning(root: string): boolean {
  for (const pid of list(join(root, 'proc'))) {
    if (!/^\d+$/.test(pid)) continue;
    if (read(join(root, 'proc', pid, 'comm')) === 'irqbalance') return true;
  }
  return false;
}

// ----------------------------------------------------------------------------------- reading

function cpuModel(root: string): string | null {
  const text = read(join(root, 'proc/cpuinfo'));
  return text ? (/^model name\s*:\s*(.+)$/m.exec(text)?.[1]?.replace(/\s+/g, ' ').trim() ?? null) : null;
}

function readNodes(root: string): HwCpuNode[] {
  const base = join(root, 'sys/devices/system/node');
  const model = cpuModel(root);
  const nodes = list(base)
    .map((n) => /^node(\d+)$/.exec(n))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b)
    .map((node): HwCpuNode => {
      const cpus = read(join(base, `node${node}`, 'cpulist')) ?? '';
      const mem = read(join(base, `node${node}`, 'meminfo'));
      const kb = mem ? Number(/MemTotal:\s*(\d+)\s*kB/.exec(mem)?.[1]) : NaN;
      const first = expandCpus(cpus)[0];
      const socket = first === undefined ? null : Number(read(join(root, `sys/devices/system/cpu/cpu${first}/topology/physical_package_id`)) ?? NaN);
      return { node, cpus, cpuCount: expandCpus(cpus).length, memoryMb: Number.isFinite(kb) ? Math.round(kb / 1024) : null, model, socket: socket !== null && Number.isFinite(socket) ? socket : null };
    })
    .filter((n) => n.cpuCount > 0);
  if (nodes.length) return nodes;
  const online = read(join(root, 'sys/devices/system/cpu/online')) ?? '0';
  return [{ node: 0, cpus: online, cpuCount: expandCpus(online).length, memoryMb: null, model, socket: 0 }];
}

/** The PCI device a sysfs path belongs to: the last PCI address in its real path. */
export function pciOwner(realPath: string): string | null {
  const parts = realPath.split('/').filter((p) => PCI_RE.test(p));
  return parts.at(-1)?.toLowerCase() ?? null;
}

/** Network ports and disks by the PCI device they hang off. */
function interfacesByDevice(root: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (dev: string | null, name: string) => {
    if (dev) out.set(dev, [...(out.get(dev) ?? []), name]);
  };
  for (const n of list(join(root, 'sys/class/net'))) {
    try {
      add(pciOwner(realpathSync(join(root, 'sys/class/net', n))), n);
    } catch {
      /* gone */
    }
  }
  for (const b of list(join(root, 'sys/block'))) {
    if (/^(loop|ram|zram|dm-|md|sr|nbd)/.test(b)) continue;
    try {
      add(pciOwner(realpathSync(join(root, 'sys/block', b))), b);
    } catch {
      /* gone */
    }
  }
  return out;
}

export interface TopologyOptions {
  root?: string;
  /** PCI address → name of the virtual machine it is given to. */
  passthrough?: Map<string, string>;
  pinned?: Record<string, string>;
}

/** Reads the server's hardware. Computers without a Linux sysfs get a sample server (so the view can be explored). */
export function readTopology(opts: TopologyOptions = {}): HwTopology {
  const root = opts.root ?? '/';
  const pciDir = join(root, 'sys/bus/pci/devices');
  if (!existsSync(pciDir)) return sampleTopology(opts.passthrough, opts.pinned);
  const ids = loadPciIds(root);
  const interrupts = parseInterrupts(read(join(root, 'proc/interrupts')) ?? '');
  const ifaces = interfacesByDevice(root);
  const nodes = readNodes(root);
  const devices: HwDevice[] = [];
  for (const address of list(pciDir).filter((a) => PCI_RE.test(a)).sort()) {
    const dir = join(pciDir, address);
    let parent: string | null = null;
    try {
      const real = realpathSync(dir).split('/');
      const up = real.at(-2) ?? '';
      parent = PCI_RE.test(up) ? up.toLowerCase() : null;
    } catch {
      /* flat fixture */
    }
    const cls = (read(join(dir, 'class')) ?? '0x000000').replace(/^0x/i, '').toLowerCase();
    const vendorId = (read(join(dir, 'vendor')) ?? '').replace(/^0x/i, '').toLowerCase();
    const deviceId = (read(join(dir, 'device')) ?? '').replace(/^0x/i, '').toLowerCase();
    const v = ids.vendors.get(vendorId);
    const vendor = v?.name ?? COMMON_VENDORS[vendorId] ?? (vendorId ? `Vendor ${vendorId}` : null);
    const className = CLASS_NAMES[cls.slice(0, 4)] ?? 'PCI device';
    const name = v?.devices.get(deviceId) ?? `${className} (${vendorId}:${deviceId})`;
    const numa = Number(read(join(dir, 'numa_node')) ?? -1);
    const speed = read(join(dir, 'current_link_speed'));
    const width = read(join(dir, 'current_link_width'));
    const irqNums = new Set<number>(list(join(dir, 'msi_irqs')).map(Number).filter(Number.isFinite));
    const legacy = Number(read(join(dir, 'irq')) ?? 0);
    if (legacy > 0 && !irqNums.size) irqNums.add(legacy);
    const irqs = [...irqNums]
      .sort((a, b) => a - b)
      .map((irq) => ({
        irq,
        name: interrupts.get(irq)?.name ?? '',
        cpus: read(join(root, 'proc/irq', String(irq), 'smp_affinity_list')) ?? '',
        effective: read(join(root, 'proc/irq', String(irq), 'effective_affinity_list')),
      }));
    const groupLink = link(join(dir, 'iommu_group'));
    devices.push({
      address: address.toLowerCase(),
      parent,
      kind: kindOf(cls),
      name,
      vendor,
      driver: link(join(dir, 'driver')),
      numaNode: Number.isFinite(numa) && numa >= 0 ? numa : nodes.length === 1 ? nodes[0]!.node : null,
      link: speed || width ? { speed: speed && !/unknown/i.test(speed) ? speed : null, width: width ? Number(width) || null : null, maxSpeed: read(join(dir, 'max_link_speed')), maxWidth: Number(read(join(dir, 'max_link_width'))) || null } : null,
      iommuGroup: groupLink !== null && /^\d+$/.test(groupLink) ? Number(groupLink) : null,
      interfaces: (ifaces.get(address.toLowerCase()) ?? []).sort(),
      irqs,
      passthroughVm: opts.passthrough?.get(address.toLowerCase()) ?? null,
    });
  }
  const totalCpus = nodes.reduce((n, x) => n + x.cpuCount, 0);
  return { source: 'system', nodes, devices, irqbalance: irqbalanceRunning(root), pinned: opts.pinned ?? {}, totalCpus, collectedAt: new Date().toISOString() };
}

/** A made-up single-socket rack server, for exploring the hardware view on a computer without one. */
export function sampleTopology(passthrough?: Map<string, string>, pinned: Record<string, string> = {}): HwTopology {
  const irq = (base: number, n: number, cpus = '0-7', label = 'queue') => Array.from({ length: n }, (_, i) => ({ irq: base + i, name: `${label}-${i}`, cpus, effective: String(i % 8) }));
  const dev = (d: Partial<HwDevice> & Pick<HwDevice, 'address' | 'kind' | 'name'>): HwDevice => ({ parent: null, vendor: null, driver: null, numaNode: 0, link: null, iommuGroup: null, interfaces: [], irqs: [], passthroughVm: passthrough?.get(d.address) ?? null, ...d });
  return {
    source: 'sample',
    nodes: [{ node: 0, cpus: '0-7', cpuCount: 8, memoryMb: 32768, model: 'Sample 4-core / 8-thread server processor', socket: 0 }],
    devices: [
      dev({ address: '0000:00:00.0', kind: 'bridge', name: 'Host bridge', vendor: 'Intel', iommuGroup: 0 }),
      dev({ address: '0000:00:01.0', kind: 'bridge', name: 'PCIe root port (x16 slot)', vendor: 'Intel', driver: 'pcieport', iommuGroup: 1, link: { speed: '8.0 GT/s PCIe', width: 16, maxSpeed: '8.0 GT/s PCIe', maxWidth: 16 } }),
      dev({ address: '0000:01:00.0', parent: '0000:00:01.0', kind: 'storage', name: 'SAS3008 RAID controller', vendor: 'Broadcom / LSI', driver: 'megaraid_sas', iommuGroup: 1, interfaces: ['sda', 'sdb'], irqs: irq(120, 4, '0-7', 'megasas'), link: { speed: '8.0 GT/s PCIe', width: 8, maxSpeed: '8.0 GT/s PCIe', maxWidth: 8 } }),
      dev({ address: '0000:00:14.0', kind: 'usb', name: 'USB 3.0 xHCI controller', vendor: 'Intel', driver: 'xhci_hcd', iommuGroup: 2, irqs: irq(125, 1, '0-7', 'xhci_hcd') }),
      dev({ address: '0000:00:17.0', kind: 'storage', name: 'SATA controller (AHCI)', vendor: 'Intel', driver: 'ahci', iommuGroup: 3, interfaces: ['sdc'], irqs: irq(126, 1, '0-7', 'ahci') }),
      dev({ address: '0000:00:1c.0', kind: 'bridge', name: 'PCIe root port', vendor: 'Intel', driver: 'pcieport', iommuGroup: 4 }),
      dev({ address: '0000:02:00.0', parent: '0000:00:1c.0', kind: 'network', name: 'NetXtreme BCM5720 Gigabit Ethernet', vendor: 'Broadcom', driver: 'tg3', iommuGroup: 4, interfaces: ['eno1'], irqs: irq(130, 5, '0-7', 'eno1'), link: { speed: '5.0 GT/s PCIe', width: 1, maxSpeed: '5.0 GT/s PCIe', maxWidth: 1 } }),
      dev({ address: '0000:02:00.1', parent: '0000:00:1c.0', kind: 'network', name: 'NetXtreme BCM5720 Gigabit Ethernet', vendor: 'Broadcom', driver: 'tg3', iommuGroup: 4, interfaces: ['eno2'], irqs: irq(135, 5, '0-7', 'eno2'), link: { speed: '5.0 GT/s PCIe', width: 1, maxSpeed: '5.0 GT/s PCIe', maxWidth: 1 } }),
      dev({ address: '0000:00:1c.4', kind: 'bridge', name: 'PCIe root port', vendor: 'Intel', driver: 'pcieport', iommuGroup: 5 }),
      dev({ address: '0000:03:00.0', parent: '0000:00:1c.4', kind: 'display', name: 'Integrated management controller video', vendor: 'Matrox', driver: 'mgag200', iommuGroup: 5 }),
      dev({ address: '0000:00:1f.0', kind: 'bridge', name: 'ISA bridge (chipset)', vendor: 'Intel', iommuGroup: 6 }),
    ],
    irqbalance: true,
    pinned,
    totalCpus: 8,
    collectedAt: new Date().toISOString(),
  };
}
