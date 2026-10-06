import { XMLParser } from 'fast-xml-parser';
import type { VmDisk, VmFirmware, VmNic, VmOs, VmCreateSpec } from '@fbrx/shared';

/**
 * libvirt domain XML for FBRX Virtual: what a new virtual machine looks like, and reading one back (FBRX's own and ones
 * made elsewhere). FBRX keeps its own notes (the guest OS, when it was made) in a metadata block of its own.
 */

export const FBRX_NS = 'https://fbrx.dev/virtual/1';

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export interface DomainBuild {
  spec: VmCreateSpec;
  /** "kvm" with hardware acceleration, "qemu" (software emulation) without. */
  domainType: 'kvm' | 'qemu';
  diskPath: string;
  isoPath: string | null;
  /** A software TPM is installed (swtpm). */
  tpmAvailable: boolean;
  createdAt: string;
}

/** The domain XML for a new virtual machine. Windows gets SATA disks and an Intel NIC (no drivers needed to install). */
export function buildDomainXml(b: DomainBuild): string {
  const { spec } = b;
  const win = spec.os === 'windows';
  const uefi = spec.firmware === 'uefi';
  const secure = uefi && !!spec.secureBoot;
  const diskBus = win ? 'sata' : 'virtio';
  const diskDev = win ? 'sda' : 'vda';
  const cdDev = win ? 'sdb' : 'sda';
  const nicModel = win ? 'e1000e' : 'virtio';
  const nicSource = spec.network.kind === 'bridge' ? `<source bridge='${esc(spec.network.source)}'/>` : `<source network='${esc(spec.network.source)}'/>`;
  const firmware = uefi
    ? `
    <firmware>
      <feature enabled='${secure ? 'yes' : 'no'}' name='secure-boot'/>
      <feature enabled='${secure ? 'yes' : 'no'}' name='enrolled-keys'/>
    </firmware>`
    : '';
  const lines = [
    `<domain type='${b.domainType}'>`,
    `  <name>${esc(spec.name)}</name>`,
    spec.description ? `  <description>${esc(spec.description)}</description>` : '',
    `  <metadata>`,
    `    <fbrx:vm xmlns:fbrx='${FBRX_NS}'>`,
    `      <fbrx:os>${spec.os}</fbrx:os>`,
    `      <fbrx:created>${esc(b.createdAt)}</fbrx:created>`,
    `    </fbrx:vm>`,
    `  </metadata>`,
    `  <memory unit='MiB'>${spec.memoryMb}</memory>`,
    `  <currentMemory unit='MiB'>${spec.memoryMb}</currentMemory>`,
    `  <vcpu placement='static'>${spec.cpus}</vcpu>`,
    `  <os${uefi ? " firmware='efi'" : ''}>`,
    `    <type arch='x86_64' machine='q35'>hvm</type>${firmware}`,
    `    <boot dev='hd'/>`,
    `    <boot dev='cdrom'/>`,
    `  </os>`,
    `  <features>`,
    `    <acpi/>`,
    `    <apic/>`,
    secure ? `    <smm state='on'/>` : '',
    win ? `    <hyperv mode='custom'><relaxed state='on'/><vapic state='on'/><spinlocks state='on' retries='8191'/></hyperv>` : '',
    `  </features>`,
    b.domainType === 'kvm' ? `  <cpu mode='host-passthrough' check='none' migratable='on'/>` : '',
    `  <clock offset='${win ? 'localtime' : 'utc'}'/>`,
    `  <on_poweroff>destroy</on_poweroff>`,
    `  <on_reboot>restart</on_reboot>`,
    `  <on_crash>destroy</on_crash>`,
    `  <devices>`,
    `    <disk type='file' device='disk'>`,
    `      <driver name='qemu' type='qcow2' discard='unmap'/>`,
    `      <source file='${esc(b.diskPath)}'/>`,
    `      <target dev='${diskDev}' bus='${diskBus}'/>`,
    `    </disk>`,
    `    <disk type='file' device='cdrom'>`,
    `      <driver name='qemu' type='raw'/>`,
    b.isoPath ? `      <source file='${esc(b.isoPath)}'/>` : '',
    `      <target dev='${cdDev}' bus='sata'/>`,
    `      <readonly/>`,
    `    </disk>`,
    `    <interface type='${spec.network.kind}'>`,
    `      ${nicSource}`,
    `      <model type='${nicModel}'/>`,
    `    </interface>`,
    `    <controller type='usb' model='qemu-xhci'/>`,
    `    <input type='tablet' bus='usb'/>`,
    `    <graphics type='vnc' port='-1' autoport='yes' listen='127.0.0.1'/>`,
    `    <video><model type='${win ? 'vga' : 'virtio'}'/></video>`,
    `    <channel type='unix'><target type='virtio' name='org.qemu.guest_agent.0'/></channel>`,
    `    <rng model='virtio'><backend model='random'>/dev/urandom</backend></rng>`,
    spec.tpm && b.tpmAvailable ? `    <tpm model='tpm-crb'><backend type='emulator' version='2.0'/></tpm>` : '',
    `    <memballoon model='virtio'/>`,
    `  </devices>`,
    `</domain>`,
  ];
  return lines.filter(Boolean).join('\n') + '\n';
}

export interface ParsedDomain {
  uuid: string;
  name: string;
  description: string;
  os: VmOs;
  memoryMb: number;
  cpus: number;
  cpuset: string | null;
  firmware: VmFirmware;
  secureBoot: boolean;
  tpm: boolean;
  machine: string;
  disks: Array<Omit<VmDisk, 'sizeGb' | 'allocatedGb'>>;
  nics: Array<Omit<VmNic, 'ip'>>;
  vncPort: number | null;
  hostdevs: string[];
  createdAt: string | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  removeNSPrefix: true,
  isArray: (name) => ['disk', 'interface', 'hostdev', 'graphics', 'boot', 'feature'].includes(name),
});

const arr = <T>(v: T | T[] | undefined | null): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const text = (v: unknown): string => (v === undefined || v === null ? '' : typeof v === 'object' ? String((v as Record<string, unknown>)['#text'] ?? '') : String(v));

function toMb(node: unknown): number {
  const n = Number(text(node));
  const unit = String((node as Record<string, unknown>)?.['@unit'] ?? 'KiB').toLowerCase();
  const factor: Record<string, number> = { b: 1 / 1048576, bytes: 1 / 1048576, k: 1 / 1024, kib: 1 / 1024, kb: 1000 / 1048576, m: 1, mib: 1, mb: 1e6 / 1048576, g: 1024, gib: 1024, gb: 1e9 / 1048576 };
  return Math.round(n * (factor[unit] ?? 1 / 1024));
}

const pciAddress = (a: Record<string, string>) => {
  const h = (v: string | undefined, len: number) => Number.parseInt(String(v ?? '0').replace(/^0x/i, ''), 16).toString(16).padStart(len, '0');
  return `${h(a['@domain'], 4)}:${h(a['@bus'], 2)}:${h(a['@slot'], 2)}.${Number.parseInt(String(a['@function'] ?? '0').replace(/^0x/i, ''), 16)}`;
};

export function parseDomainXml(xml: string): ParsedDomain {
  const d = parser.parse(xml).domain ?? {};
  const os = d.os ?? {};
  const devices = d.devices ?? {};
  const meta = d.metadata?.vm ?? {};
  const loader = os.loader;
  const firmware: VmFirmware = os['@firmware'] === 'efi' || (loader && String(text(loader)).length > 0) || (typeof loader === 'object' && loader?.['@type'] === 'pflash') ? 'uefi' : 'bios';
  const features = arr(os.firmware?.feature);
  const secureBoot = features.some((f: Record<string, string>) => f['@name'] === 'secure-boot' && f['@enabled'] === 'yes') || (typeof loader === 'object' && loader?.['@secure'] === 'yes');
  const metaOs = text(meta.os);
  return {
    uuid: text(d.uuid),
    name: text(d.name),
    description: text(d.description),
    os: metaOs === 'linux' || metaOs === 'windows' ? metaOs : d.features?.hyperv ? 'windows' : 'other',
    memoryMb: toMb(d.memory),
    cpus: Number(text(d.vcpu)) || 1,
    cpuset: (typeof d.vcpu === 'object' && d.vcpu?.['@cpuset']) || null,
    firmware,
    secureBoot,
    tpm: !!devices.tpm,
    machine: String(os.type?.['@machine'] ?? ''),
    disks: arr(devices.disk).map((x: any) => ({
      target: String(x.target?.['@dev'] ?? ''),
      device: x['@device'] === 'cdrom' ? 'cdrom' : 'disk',
      path: x.source?.['@file'] ?? x.source?.['@dev'] ?? null,
      bus: String(x.target?.['@bus'] ?? ''),
    })) as ParsedDomain['disks'],
    nics: arr(devices.interface).map((x: any) => ({
      mac: String(x.mac?.['@address'] ?? ''),
      kind: x['@type'] === 'bridge' ? 'bridge' : 'network',
      source: String(x.source?.['@network'] ?? x.source?.['@bridge'] ?? ''),
      model: String(x.model?.['@type'] ?? ''),
    })) as ParsedDomain['nics'],
    vncPort: (() => {
      const g = arr(devices.graphics).find((x: any) => x['@type'] === 'vnc');
      const port = Number(g?.['@port']);
      return Number.isFinite(port) && port > 0 ? port : null;
    })(),
    hostdevs: arr(devices.hostdev)
      .filter((h: any) => h['@type'] === 'pci' && h.source?.address)
      .map((h: any) => pciAddress(h.source.address)),
    createdAt: text(meta.created) || null,
  };
}

/** The hostdev XML that gives a PCI device (0000:02:00.0) to a virtual machine. */
export function hostdevXml(address: string): string {
  const m = /^([0-9a-f]{4}):([0-9a-f]{2}):([0-9a-f]{2})\.([0-7])$/i.exec(address);
  if (!m) throw new Error(`Not a PCI address: ${address}`);
  return `<hostdev mode='subsystem' type='pci' managed='yes'><source><address domain='0x${m[1]}' bus='0x${m[2]}' slot='0x${m[3]}' function='0x${m[4]}'/></source></hostdev>\n`;
}

/**
 * Changes to a saved (inactive) definition: processors, memory, where it runs and its description. libvirt writes its
 * XML in one canonical form, so these edits are exact.
 */
export function editDomainXml(xml: string, c: { cpus?: number; memoryMb?: number; description?: string; cpuset?: string | null }): string {
  let out = xml;
  if (c.cpus !== undefined || c.cpuset !== undefined) {
    out = out.replace(/<vcpu\b([^>]*)>(\d+)<\/vcpu>/, (_m, attrs: string, n: string) => {
      const count = c.cpus ?? Number(n);
      const keep = c.cpuset === undefined ? (/cpuset='([^']*)'/.exec(attrs)?.[1] ?? null) : c.cpuset;
      return `<vcpu placement='static'${keep ? ` cpuset='${esc(keep)}'` : ''}>${count}</vcpu>`;
    });
  }
  if (c.memoryMb !== undefined) {
    const kib = c.memoryMb * 1024;
    out = out.replace(/<memory\b[^>]*>\d+<\/memory>/, `<memory unit='KiB'>${kib}</memory>`).replace(/<currentMemory\b[^>]*>\d+<\/currentMemory>/, `<currentMemory unit='KiB'>${kib}</currentMemory>`);
  }
  if (c.description !== undefined) {
    const desc = c.description ? `<description>${esc(c.description)}</description>` : '';
    out = /<description>[\s\S]*?<\/description>/.test(out) ? out.replace(/\s*<description>[\s\S]*?<\/description>/, desc ? `\n  ${desc}` : '') : out.replace(/(<name>[^<]*<\/name>)/, desc ? `$1\n  ${desc}` : '$1');
  }
  return out;
}

/** Host CPU lists like "0-3,8-11". */
export const CPUSET_RE = /^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/;
