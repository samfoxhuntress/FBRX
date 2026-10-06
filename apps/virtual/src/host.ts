import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { cpus, freemem, hostname, loadavg, release, totalmem, uptime } from 'node:os';
import { join } from 'node:path';
import si from 'systeminformation';
import { VIRTUAL_PRODUCT, type HostInfo } from '@fbrx/shared';
import type { Hypervisor } from './drivers/types';

let cached: { at: number; value: Omit<HostInfo, 'memory' | 'load' | 'cpuPct' | 'uptimeSeconds' | 'hypervisor' | 'warnings'> } | null = null;
let lastCpu: { idle: number; total: number } | null = null;

function cpuPct(): number {
  const now = cpus().reduce(
    (a, c) => {
      const t = c.times;
      return { idle: a.idle + t.idle, total: a.total + t.user + t.nice + t.sys + t.idle + t.irq };
    },
    { idle: 0, total: 0 },
  );
  const prev = lastCpu;
  lastCpu = now;
  if (!prev || now.total <= prev.total) return 0;
  return Math.round((1 - (now.idle - prev.idle) / (now.total - prev.total)) * 1000) / 10;
}

/** Intel VT-d / AMD-Vi is on: the kernel made IOMMU groups. */
export function iommuEnabled(sysRoot = '/'): boolean {
  try {
    return readdirSync(join(sysRoot, 'sys/kernel/iommu_groups')).length > 0;
  } catch {
    return false;
  }
}

/** Debian's os-release name ("Debian GNU/Linux 13 (trixie)"); FBRX Server says so too. */
function osName(sysRoot: string): string | null {
  try {
    const text = readFileSync(join(sysRoot, 'etc/os-release'), 'utf8');
    return /^PRETTY_NAME="?([^"\n]+)"?/m.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The server: what it is, how busy, and what is in the way of running virtual machines well. */
export async function hostInfo(hv: Hypervisor, version: string, sysRoot = '/'): Promise<HostInfo> {
  if (!cached || Date.now() - cached.at > 10 * 60_000) {
    const [sys, bios, cpu] = await Promise.all([si.system().catch(() => null), si.bios().catch(() => null), si.cpu().catch(() => null)]);
    const fbrxServer = existsSync(join(sysRoot, 'etc/fbrx-server-release'));
    cached = {
      at: Date.now(),
      value: {
        hostname: hostname(),
        product: fbrxServer ? 'FBRX Server' : VIRTUAL_PRODUCT,
        version,
        os: osName(sysRoot) ?? `${process.platform} ${release()}`,
        kernel: release(),
        vendor: sys?.manufacturer || null,
        model: sys?.model || null,
        serial: sys?.serial && sys.serial !== '-' ? sys.serial : null,
        bios: { vendor: bios?.vendor || null, version: bios?.version || null, date: bios?.releaseDate || null },
        cpu: {
          model: cpu ? `${cpu.manufacturer} ${cpu.brand}`.trim() : (cpus()[0]?.model ?? 'Unknown processor'),
          sockets: cpu?.processors || 1,
          cores: cpu?.physicalCores || cpus().length,
          threads: cpu?.cores || cpus().length,
          mhz: cpu?.speed ? Math.round(cpu.speed * 1000) : null,
        },
        iommu: iommuEnabled(sysRoot),
      },
    };
  }
  const hypervisor = await hv.info();
  const warnings: string[] = [];
  if (hypervisor.driver === 'simulated') warnings.push('Simulated hypervisor: virtual machines here are pretend (no libvirt on this computer). Install FBRX Server to run real ones.');
  else if (!hypervisor.kvm) warnings.push('Processor virtualization is off or missing, so virtual machines run in slow software emulation. Turn on Virtualization Technology in the BIOS (Server → BIOS).');
  if (hypervisor.driver === 'libvirt' && !cached.value.iommu) warnings.push('VT-d (IOMMU) is off: PCI devices cannot be given to virtual machines. Turn on Virtualization Technology for Direct I/O in the BIOS and add intel_iommu=on to the kernel options.');
  const total = Math.round(totalmem() / 1048576);
  return {
    ...cached.value,
    memory: { totalMb: total, usedMb: total - Math.round(freemem() / 1048576) },
    load: loadavg().map((l) => Math.round(l * 100) / 100),
    cpuPct: cpuPct(),
    uptimeSeconds: Math.round(uptime()),
    hypervisor,
    warnings,
  };
}
