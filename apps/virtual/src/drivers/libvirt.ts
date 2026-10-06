import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { XMLParser } from 'fast-xml-parser';
import type { HypervisorInfo, StoragePool, StorageVolume, VirtualNetwork, VmChanges, VmDetail, VmDisk, VmNic, VmPowerAction, VmSnapshot, VmCreateSpec, VmState, VmSummary } from '@fbrx/shared';
import { badRequest, conflict, errorMessage, notFound, VirtualError } from '../errors';
import { IMAGES_POOL, ISOS_POOL, type Hypervisor } from './types';
import { buildDomainXml, editDomainXml, esc, hostdevXml, parseDomainXml, type ParsedDomain } from './xml';
import { firstColumn, nonEmptyLines, parseBlkinfo, parseDomstats, parseIfaddr, parseInfo, stateFromWords, stateName, virshRunner, type VirshRunner } from './virsh';

export interface LibvirtOptions {
  uri?: string;
  /** Where new virtual disks go (the fbrx-images pool). */
  imagesDir: string;
  /** The ISO library (the fbrx-isos pool). */
  isosDir: string;
  run?: VirshRunner;
  /** Where libvirt keeps running machines' pid files (their start time is the pid file's). */
  runDir?: string;
  sysClassNet?: string;
}

const GB = 1024 ** 3;
const gb = (bytes: number | null | undefined) => (bytes == null ? null : Math.round((bytes / GB) * 100) / 100);

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, isArray: (n) => ['ip', 'range', 'interface'].includes(n) });

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

function which(bin: string): Promise<boolean> {
  return new Promise((resolve) => execFile('sh', ['-c', `command -v ${bin}`], (err) => resolve(!err)));
}

function ipToInt(ip: string): number {
  return ip.split('.').reduce((n, p) => (n << 8) + Number(p), 0) >>> 0;
}
const intToIp = (n: number) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join('.');
const maskToPrefix = (mask: string) => ipToInt(mask).toString(2).replace(/0+$/, '').length;

/** Parses "192.168.50.0/24": the network's first address for the server, and a DHCP range for machines. */
export function planSubnet(subnet: string): { address: string; prefix: number; dhcpStart: string; dhcpEnd: string } {
  const m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(subnet.trim());
  if (!m || m[1]!.split('.').some((p) => Number(p) > 255)) throw badRequest('Give the subnet like 192.168.50.0/24');
  const prefix = Number(m[2]);
  if (prefix < 16 || prefix > 28) throw badRequest('Use a subnet between /16 and /28');
  const size = 2 ** (32 - prefix);
  const net = (ipToInt(m[1]!) & ~(size - 1)) >>> 0;
  const firstOctet = net >>> 24;
  const second = (net >>> 16) & 255;
  const isPrivate = firstOctet === 10 || (firstOctet === 172 && second >= 16 && second <= 31) || (firstOctet === 192 && second === 168);
  if (!isPrivate) throw badRequest('Use a private range (10.x, 172.16-31.x or 192.168.x)');
  return { address: intToIp(net + 1), prefix, dhcpStart: intToIp(net + (size >= 256 ? 100 : 2)), dhcpEnd: intToIp(net + size - 2) };
}

/** Real virtual machines through libvirt (KVM, or QEMU emulation where the processor has no virtualization). */
export class LibvirtHypervisor implements Hypervisor {
  readonly kind = 'libvirt' as const;
  private readonly run: VirshRunner;
  private readonly runDir: string;
  private readonly sysClassNet: string;
  private readonly cpuSamples = new Map<string, { cpuNs: number; at: number }>();

  constructor(private readonly opts: LibvirtOptions) {
    this.run = opts.run ?? virshRunner(opts.uri ?? 'qemu:///system');
    this.runDir = opts.runDir ?? '/run/libvirt/qemu';
    this.sysClassNet = opts.sysClassNet ?? '/sys/class/net';
  }

  // ------------------------------------------------------------------------------------- setup

  async prepare(): Promise<void> {
    await this.ensurePool(IMAGES_POOL, this.opts.imagesDir);
    await this.ensurePool(ISOS_POOL, this.opts.isosDir);
    try {
      const info = parseInfo(await this.run(['net-info', 'default']));
      if (info.active !== 'yes') await this.run(['net-start', 'default']);
      if (info.autostart !== 'yes') await this.run(['net-autostart', 'default']);
    } catch {
      /* no default network: people pick a bridge or make one */
    }
  }

  private async ensurePool(name: string, dir: string) {
    mkdirSync(dir, { recursive: true });
    let info: Record<string, string> | null = null;
    try {
      info = parseInfo(await this.run(['pool-info', name]));
    } catch {
      await this.run(['pool-define-as', name, 'dir', '--target', dir]);
      await this.run(['pool-build', name]).catch(() => undefined);
    }
    if (info?.state !== 'running') await this.run(['pool-start', name]);
    if (info?.autostart !== 'yes') await this.run(['pool-autostart', name]);
  }

  async info(): Promise<HypervisorInfo> {
    let version: string | null = null;
    try {
      const out = await this.run(['version']);
      version = /Running hypervisor:\s*(.+)/.exec(out)?.[1]?.trim() ?? /Using library:\s*(.+)/.exec(out)?.[1]?.trim() ?? null;
    } catch (e) {
      if (e instanceof VirtualError && e.status === 503) throw e;
    }
    const kvm = existsSync('/dev/kvm');
    let uefi = false;
    try {
      uefi = /<value>efi<\/value>/.test(await this.run(['domcapabilities', '--virttype', kvm ? 'kvm' : 'qemu', '--machine', 'q35']));
    } catch {
      uefi = existsSync('/usr/share/OVMF') || existsSync('/usr/share/edk2');
    }
    return { driver: 'libvirt', version, kvm, uefi, tpm: await which('swtpm') };
  }

  // ------------------------------------------------------------------------------- machines

  private async xmlOf(id: string, inactive = false): Promise<string> {
    return this.run(['dumpxml', id, ...(inactive ? ['--inactive'] : [])]);
  }

  private async uuidOf(id: string): Promise<string> {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      await this.run(['domname', id]);
      return id.toLowerCase();
    }
    return (await this.run(['domuuid', id])).trim();
  }

  private cpuPct(uuid: string, cpuNs: number | undefined, vcpus: number): number | null {
    if (cpuNs === undefined) return null;
    const now = performance.now();
    const prev = this.cpuSamples.get(uuid);
    this.cpuSamples.set(uuid, { cpuNs, at: now });
    if (!prev || now - prev.at < 200 || cpuNs < prev.cpuNs) return null;
    const pct = ((cpuNs - prev.cpuNs) / ((now - prev.at) * 1e6 * Math.max(1, vcpus))) * 100;
    return Math.max(0, Math.min(100, Math.round(pct * 10) / 10));
  }

  private uptime(name: string): number | null {
    try {
      return Math.max(0, Math.round((Date.now() - statSync(join(this.runDir, `${name}.pid`)).mtimeMs) / 1000));
    } catch {
      return null;
    }
  }

  private async addresses(id: string): Promise<Map<string, string>> {
    for (const source of ['lease', 'agent', 'arp']) {
      try {
        const found = parseIfaddr(await this.run(['domifaddr', id, '--source', source], { timeoutMs: 5000 }));
        if (found.size) return found;
      } catch {
        /* try the next source */
      }
    }
    return new Map();
  }

  private summarize(p: ParsedDomain, stats: Record<string, string> | undefined, autostart: boolean, blk: ReturnType<typeof parseBlkinfo>, ips: Map<string, string>): VmSummary {
    const state: VmState = stats?.['state.state'] ? stateName(Number(stats['state.state'])) : 'unknown';
    const live = state === 'running' || state === 'paused';
    const avail = Number(stats?.['balloon.available']);
    const unused = Number(stats?.['balloon.unused']);
    const rss = Number(stats?.['balloon.rss']);
    const usedKib = Number.isFinite(avail) && Number.isFinite(unused) && avail > 0 ? avail - unused : Number.isFinite(rss) ? rss : NaN;
    const diskBytes = p.disks.filter((d) => d.device === 'disk').reduce((n, d) => n + (blk.get(d.target)?.capacity ?? 0), 0);
    return {
      id: p.uuid,
      name: p.name,
      state,
      os: p.os,
      cpus: p.cpus,
      memoryMb: p.memoryMb,
      diskGb: Math.round((diskBytes / GB) * 10) / 10,
      autostart,
      description: p.description,
      cpuPct: live ? this.cpuPct(p.uuid, stats?.['cpu.time'] ? Number(stats['cpu.time']) : undefined, p.cpus) : null,
      memoryUsedMb: live && Number.isFinite(usedKib) ? Math.min(p.memoryMb, Math.round(usedKib / 1024)) : null,
      ip: live ? (p.nics.map((n) => ips.get(n.mac.toLowerCase())).find(Boolean) ?? null) : null,
      uptimeSeconds: live ? this.uptime(p.name) : null,
      cpuset: p.cpuset,
    };
  }

  async listVms(): Promise<VmSummary[]> {
    const uuids = nonEmptyLines(await this.run(['list', '--all', '--uuid']));
    if (!uuids.length) return [];
    const auto = new Set(nonEmptyLines(await this.run(['list', '--all', '--autostart', '--uuid'])));
    const stats = parseDomstats(await this.run(['domstats', '--raw', '--state', '--cpu-total', '--balloon']).catch(() => ''));
    const list = await mapLimit(uuids, 6, async (uuid) => {
      try {
        const p = parseDomainXml(await this.xmlOf(uuid, true));
        const st = stats.get(p.name);
        const running = st?.['state.state'] === '1' || st?.['state.state'] === '2' || st?.['state.state'] === '3';
        const [blk, ips] = await Promise.all([this.run(['domblkinfo', uuid, '--all']).then(parseBlkinfo, () => new Map()), running ? this.addresses(uuid) : Promise.resolve(new Map<string, string>())]);
        return this.summarize(p, st, auto.has(uuid), blk, ips);
      } catch {
        return null; // removed while listing
      }
    });
    return list.filter((v): v is VmSummary => !!v).sort((a, b) => a.name.localeCompare(b.name));
  }

  async getVm(id: string): Promise<VmDetail> {
    const uuid = await this.uuidOf(id);
    // Settings as saved (what the next start uses); the running copy only for its screen and to spot pending changes.
    const p = parseDomainXml(await this.xmlOf(uuid, true));
    const info = parseInfo(await this.run(['dominfo', uuid]));
    const state = stateFromWords(info.state ?? '');
    const live = state === 'running' || state === 'paused';
    const running = live ? parseDomainXml(await this.xmlOf(uuid)) : null;
    const stats = live ? parseDomstats(await this.run(['domstats', '--raw', '--state', '--cpu-total', '--balloon', uuid]).catch(() => '')).get(p.name) : { 'state.state': '5' };
    const [blk, ips] = await Promise.all([this.run(['domblkinfo', uuid, '--all']).then(parseBlkinfo, () => new Map()), live ? this.addresses(uuid) : Promise.resolve(new Map<string, string>())]);
    const summary = this.summarize(p, stats ?? { 'state.state': '5' }, info.autostart === 'enable', blk, ips);
    const disks: VmDisk[] = p.disks.map((d) => ({ ...d, sizeGb: gb(blk.get(d.target)?.capacity), allocatedGb: gb(blk.get(d.target)?.allocation) }));
    const nics: VmNic[] = p.nics.map((n) => ({ ...n, ip: ips.get(n.mac.toLowerCase()) ?? null }));
    const names = await this.pciNames(p.hostdevs);
    return {
      ...summary,
      state,
      firmware: p.firmware,
      secureBoot: p.secureBoot,
      tpm: p.tpm,
      machine: p.machine,
      disks,
      nics,
      iso: disks.find((d) => d.device === 'cdrom' && d.path)?.path ?? null,
      hostdevs: p.hostdevs.map((address) => ({ address, name: names.get(address) ?? address })),
      console: !!running?.vncPort,
      restartNeeded: !!running && (running.cpus !== p.cpus || running.memoryMb !== p.memoryMb || running.hostdevs.join() !== p.hostdevs.join()),
      createdAt: p.createdAt,
    };
  }

  private async pciNames(addresses: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const a of addresses) {
      try {
        const x = xml.parse(await this.run(['nodedev-dumpxml', `pci_${a.replace(/[:.]/g, '_')}`])).device;
        const product = x?.capability?.product;
        const vendor = x?.capability?.vendor;
        const name = [typeof vendor === 'object' ? vendor['#text'] : vendor, typeof product === 'object' ? product['#text'] : product].filter(Boolean).join(' ');
        if (name) out.set(a, name);
      } catch {
        /* keep the address */
      }
    }
    return out;
  }

  /** KVM when the processor offers it; FBRX_V_DOMAIN_TYPE=qemu forces software emulation (nested setups, CI). */
  private async domainType(): Promise<'kvm' | 'qemu'> {
    if (process.env.FBRX_V_DOMAIN_TYPE === 'qemu') return 'qemu';
    return existsSync('/dev/kvm') ? 'kvm' : 'qemu';
  }

  private async withXmlFile<T>(content: string, fn: (file: string) => Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), 'fbrx-virtual-'));
    const file = join(dir, 'def.xml');
    writeFileSync(file, content);
    try {
      return await fn(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async createVm(spec: VmCreateSpec, isoPath: string | null): Promise<VmDetail> {
    const exists = await this.run(['domuuid', spec.name]).then(
      () => true,
      () => false,
    );
    if (exists) throw conflict(`There is already a virtual machine called ${spec.name}`);
    const info = await this.info();
    if (spec.tpm && !info.tpm) throw badRequest('A virtual TPM needs swtpm on this server (FBRX Server installs it)');
    if (spec.firmware === 'uefi' && !info.uefi) throw badRequest('UEFI firmware (OVMF) is not installed on this server');
    const pool = spec.pool ?? IMAGES_POOL;
    const volume = `${spec.name}.qcow2`;
    await this.run(['vol-create-as', pool, volume, `${spec.diskGb}G`, '--format', 'qcow2']).catch((e) => {
      throw e instanceof VirtualError && e.status === 409 ? conflict(`A disk called ${volume} already exists in ${pool}`) : e;
    });
    const diskPath = (await this.run(['vol-path', '--pool', pool, volume])).trim();
    try {
      const domain = buildDomainXml({ spec, domainType: await this.domainType(), diskPath, isoPath, tpmAvailable: info.tpm, createdAt: new Date().toISOString() });
      await this.withXmlFile(domain, (f) => this.run(['define', f]));
    } catch (e) {
      await this.run(['vol-delete', '--pool', pool, volume]).catch(() => undefined);
      throw e;
    }
    const uuid = (await this.run(['domuuid', spec.name])).trim();
    try {
      if (spec.autostart) await this.run(['autostart', uuid]);
      if (spec.startNow) await this.run(['start', uuid]);
    } catch (e) {
      // All or nothing: a machine that cannot start is taken back out, so trying again starts clean.
      await this.run(['destroy', uuid]).catch(() => undefined);
      await this.run(['undefine', uuid, '--nvram']).catch(() => undefined);
      await this.run(['vol-delete', '--pool', pool, volume]).catch(() => undefined);
      throw e;
    }
    return this.getVm(uuid);
  }

  async updateVm(id: string, c: VmChanges, isoPath: string | null | undefined): Promise<VmDetail> {
    const uuid = await this.uuidOf(id);
    const info = parseInfo(await this.run(['dominfo', uuid]));
    const live = ['running', 'paused', 'idle', 'blocked', 'in shutdown'].includes((info.state ?? '').toLowerCase());
    const p = parseDomainXml(await this.xmlOf(uuid, true));

    if (c.cpus !== undefined || c.memoryMb !== undefined || c.description !== undefined || c.cpuset !== undefined) {
      const edited = editDomainXml(await this.xmlOf(uuid, true), { cpus: c.cpus, memoryMb: c.memoryMb, description: c.description, cpuset: c.cpuset });
      await this.withXmlFile(edited, (f) => this.run(['define', f]));
      if (live && c.description !== undefined) await this.run(['desc', uuid, '--live', c.description]).catch(() => undefined);
      if (live && c.cpuset !== undefined) await this.pinLive(uuid, p.cpus, c.cpuset);
    }
    if (c.autostart !== undefined) await this.run(['autostart', uuid, ...(c.autostart ? [] : ['--disable'])]);
    if (isoPath !== undefined) {
      const cd = p.disks.find((d) => d.device === 'cdrom');
      if (!cd) throw badRequest('This virtual machine has no CD drive');
      const scope = live ? ['--live', '--config'] : ['--config'];
      if (isoPath) await this.run(['change-media', uuid, cd.target, isoPath, '--update', ...scope]);
      else if (cd.path) await this.run(['change-media', uuid, cd.target, '--eject', ...scope]);
    }
    if (c.diskGb !== undefined) {
      const disk = p.disks.find((d) => d.device === 'disk');
      if (!disk?.path) throw badRequest('This virtual machine has no disk to grow');
      const blk = parseBlkinfo(await this.run(['domblkinfo', uuid, '--all'])).get(disk.target);
      const current = (blk?.capacity ?? 0) / GB;
      if (c.diskGb < current - 0.01) throw badRequest(`Disks can only grow (it is ${Math.round(current)} GB now)`);
      if (c.diskGb > current + 0.01) {
        if (live) await this.run(['blockresize', uuid, disk.target, `${c.diskGb}G`]);
        else await this.run(['vol-resize', disk.path, `${c.diskGb}G`]);
      }
    }
    return this.getVm(uuid);
  }

  /** Moves a running machine's processors (and QEMU's own threads) onto these host CPUs right away. */
  private async pinLive(uuid: string, vcpus: number, cpuset: string | null) {
    const all = cpuset ?? `0-${Math.max(0, (await this.hostCpuCount()) - 1)}`;
    for (let i = 0; i < vcpus; i++) await this.run(['vcpupin', uuid, '--vcpu', String(i), '--cpulist', all, '--live']);
    await this.run(['emulatorpin', uuid, '--cpulist', all, '--live']).catch(() => undefined);
  }

  private async hostCpuCount(): Promise<number> {
    const n = /CPU\(s\):\s*(\d+)/.exec(await this.run(['nodeinfo']))?.[1];
    return Number(n) || 1;
  }

  async power(id: string, action: VmPowerAction): Promise<void> {
    const uuid = await this.uuidOf(id);
    const cmd: Record<VmPowerAction, string[]> = {
      start: ['start', uuid],
      shutdown: ['shutdown', uuid],
      reboot: ['reboot', uuid],
      stop: ['destroy', uuid],
      pause: ['suspend', uuid],
      resume: ['resume', uuid],
    };
    await this.run(cmd[action]);
  }

  async deleteVm(id: string, deleteDisks: boolean): Promise<void> {
    const uuid = await this.uuidOf(id);
    const info = parseInfo(await this.run(['dominfo', uuid]));
    if (stateFromWords(info.state ?? '') !== 'stopped') throw conflict('Turn the virtual machine off before deleting it');
    const p = parseDomainXml(await this.xmlOf(uuid, true));
    // Snapshots first: external ones merge back into the disk, so nothing is left behind.
    for (let round = 0; round < 100; round++) {
      const leaves = nonEmptyLines(await this.run(['snapshot-list', uuid, '--name', '--leaves']).catch(() => ''));
      if (!leaves.length) break;
      for (const s of leaves) await this.run(['snapshot-delete', uuid, s]).catch(() => this.run(['snapshot-delete', uuid, s, '--metadata']));
    }
    const targets = p.disks.filter((d) => d.device === 'disk' && d.path).map((d) => d.target);
    const args = ['undefine', uuid, '--nvram', '--snapshots-metadata', '--managed-save', '--checkpoints-metadata'];
    if (deleteDisks && targets.length) args.push('--storage', targets.join(','));
    await this.run(args);
    this.cpuSamples.delete(uuid);
  }

  // ------------------------------------------------------------------------------ snapshots

  async snapshots(id: string): Promise<VmSnapshot[]> {
    const uuid = await this.uuidOf(id);
    const names = nonEmptyLines(await this.run(['snapshot-list', uuid, '--name']));
    const current = (await this.run(['snapshot-current', uuid, '--name']).catch(() => '')).trim();
    const out = await mapLimit(names, 4, async (name) => {
      const s = xml.parse(await this.run(['snapshot-dumpxml', uuid, name])).domainsnapshot ?? {};
      const st = String(s.state ?? '');
      const state: VmState = st === 'running' ? 'running' : st === 'paused' ? 'paused' : st === 'shutoff' || st === 'disk-snapshot' ? 'stopped' : 'unknown';
      return { name, description: typeof s.description === 'string' ? s.description : '', createdAt: new Date(Number(s.creationTime ?? 0) * 1000).toISOString(), state, current: name === current };
    });
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Machines with BIOS firmware keep everything in the disk (memory too, while running). UEFI machines keep their
   * firmware settings outside the disk, which QEMU cannot capture inside it: theirs are taken while turned off.
   */
  async createSnapshot(id: string, name: string, description: string): Promise<void> {
    const uuid = await this.uuidOf(id);
    const p = parseDomainXml(await this.xmlOf(uuid, true));
    const state = stateFromWords(parseInfo(await this.run(['dominfo', uuid])).state ?? '');
    const desc = description.trim() ? ['--description', description.trim()] : [];
    if (p.firmware === 'uefi') {
      if (state !== 'stopped') throw conflict('Turn this virtual machine off to take a snapshot (machines with UEFI firmware are snapshotted while off)');
      await this.run(['snapshot-create-as', uuid, name, ...desc, '--disk-only', '--atomic']);
    } else {
      await this.run(['snapshot-create-as', uuid, name, ...desc, '--atomic']);
    }
  }

  async revertSnapshot(id: string, name: string): Promise<void> {
    const uuid = await this.uuidOf(id);
    const p = parseDomainXml(await this.xmlOf(uuid, true));
    if (p.firmware === 'uefi') {
      const state = stateFromWords(parseInfo(await this.run(['dominfo', uuid])).state ?? '');
      if (state !== 'stopped') throw conflict('Turn this virtual machine off to go back to a snapshot');
    }
    await this.run(['snapshot-revert', uuid, name]);
  }

  async deleteSnapshot(id: string, name: string): Promise<void> {
    await this.run(['snapshot-delete', await this.uuidOf(id), name]);
  }

  async consoleEndpoint(id: string): Promise<{ host: string; port: number } | null> {
    const uuid = await this.uuidOf(id);
    const p = parseDomainXml(await this.xmlOf(uuid));
    return p.vncPort ? { host: '127.0.0.1', port: p.vncPort } : null;
  }

  // ---------------------------------------------------------------------------- passthrough

  async attachHostdev(id: string, address: string): Promise<void> {
    const uuid = await this.uuidOf(id);
    const p = parseDomainXml(await this.xmlOf(uuid, true));
    if (p.hostdevs.includes(address)) return;
    await this.withXmlFile(hostdevXml(address), (f) => this.run(['attach-device', uuid, f, '--config']));
  }

  async detachHostdev(id: string, address: string): Promise<void> {
    const uuid = await this.uuidOf(id);
    const p = parseDomainXml(await this.xmlOf(uuid, true));
    if (!p.hostdevs.includes(address)) throw notFound(`${address} is not given to this virtual machine`);
    await this.withXmlFile(hostdevXml(address), (f) => this.run(['detach-device', uuid, f, '--config']));
  }

  async hostdevUsers(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const uuid of nonEmptyLines(await this.run(['list', '--all', '--uuid']))) {
      try {
        const p = parseDomainXml(await this.xmlOf(uuid, true));
        for (const a of p.hostdevs) out.set(a, p.name);
      } catch {
        /* gone */
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------------- storage

  async pools(): Promise<StoragePool[]> {
    const names = nonEmptyLines(await this.run(['pool-list', '--all', '--name']));
    const out = await mapLimit(names, 4, async (name) => {
      const info = parseInfo(await this.run(['pool-info', name]));
      const x = xml.parse(await this.run(['pool-dumpxml', name])).pool ?? {};
      const bytes = (v: unknown) => Number(typeof v === 'object' && v ? (v as Record<string, unknown>)['#text'] : v) || 0;
      const role: StoragePool['role'] = name === IMAGES_POOL ? 'images' : name === ISOS_POOL ? 'isos' : 'other';
      return {
        name,
        path: x.target?.path ? String(x.target.path) : null,
        type: String(x['@type'] ?? 'unknown'),
        active: info.state === 'running',
        capacityGb: gb(bytes(x.capacity)) ?? 0,
        allocationGb: gb(bytes(x.allocation)) ?? 0,
        availableGb: gb(bytes(x.available)) ?? 0,
        role,
      } satisfies StoragePool;
    });
    const order = { images: 0, isos: 1, other: 2 };
    return out.sort((a, b) => order[a.role] - order[b.role] || a.name.localeCompare(b.name));
  }

  /** Every disk and CD path in use, by virtual machine name. */
  private async pathsInUse(): Promise<Map<string, string[]>> {
    const uses = new Map<string, string[]>();
    const uuids = nonEmptyLines(await this.run(['list', '--all', '--uuid']));
    await mapLimit(uuids, 6, async (uuid) => {
      try {
        const p = parseDomainXml(await this.xmlOf(uuid, true));
        for (const d of p.disks) if (d.path) uses.set(d.path, [...(uses.get(d.path) ?? []), p.name]);
      } catch {
        /* gone */
      }
    });
    return uses;
  }

  async volumes(pool: string): Promise<StorageVolume[]> {
    await this.run(['pool-refresh', pool]).catch(() => undefined);
    const names = firstColumn(await this.run(['vol-list', pool]));
    const uses = await this.pathsInUse();
    const out = await mapLimit(names, 6, async (name) => {
      const v = xml.parse(await this.run(['vol-dumpxml', '--pool', pool, name])).volume ?? {};
      const bytes = (x: unknown) => Number(typeof x === 'object' && x ? (x as Record<string, unknown>)['#text'] : x) || 0;
      const path = String(v.target?.path ?? v.key ?? '');
      return {
        name,
        path,
        format: String(v.target?.format?.['@type'] ?? 'raw'),
        capacityGb: gb(bytes(v.capacity)) ?? 0,
        allocationGb: gb(bytes(v.allocation)) ?? 0,
        usedBy: uses.get(path) ?? [],
      } satisfies StorageVolume;
    });
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async deleteVolume(pool: string, name: string): Promise<void> {
    const path = (await this.run(['vol-path', '--pool', pool, name])).trim();
    const users = (await this.pathsInUse()).get(path);
    if (users?.length) throw conflict(`${name} is used by ${users.join(', ')}`);
    await this.run(['vol-delete', '--pool', pool, name]);
  }

  async refreshPool(pool: string): Promise<void> {
    await this.run(['pool-refresh', pool]);
  }

  // ------------------------------------------------------------------------------- networks

  async networks(): Promise<VirtualNetwork[]> {
    const names = nonEmptyLines(await this.run(['net-list', '--all', '--name']));
    const nets = await mapLimit(names, 4, async (name): Promise<VirtualNetwork> => {
      const info = parseInfo(await this.run(['net-info', name]));
      const x = xml.parse(await this.run(['net-dumpxml', name])).network ?? {};
      const mode = x.forward ? String(x.forward['@mode'] ?? 'nat') : null;
      const ip = (x.ip ?? []).find((i: Record<string, string>) => !i['@family'] || i['@family'] === 'ipv4');
      let subnet: string | null = null;
      if (ip?.['@address']) {
        const prefix = ip['@prefix'] ? Number(ip['@prefix']) : ip['@netmask'] ? maskToPrefix(ip['@netmask']) : 24;
        const size = 2 ** (32 - prefix);
        subnet = `${intToIp((ipToInt(ip['@address']) & ~(size - 1)) >>> 0)}/${prefix}`;
      }
      const bridge = x.bridge?.['@name'] ?? info.bridge ?? null;
      return {
        name,
        kind: mode === null ? 'isolated' : mode === 'nat' ? 'nat' : mode === 'bridge' ? 'bridge' : 'other',
        active: info.active === 'yes',
        autostart: info.autostart === 'yes',
        bridge,
        subnet,
        ports: bridge ? this.bridgePorts(bridge) : [],
        managed: true,
      };
    });
    const libvirtBridges = new Set(nets.map((n) => n.bridge).filter(Boolean));
    const hostBridges: VirtualNetwork[] = [];
    try {
      for (const dev of readdirSync(this.sysClassNet)) {
        if (libvirtBridges.has(dev) || !existsSync(join(this.sysClassNet, dev, 'bridge'))) continue;
        let up = false;
        try {
          up = readFileSync(join(this.sysClassNet, dev, 'operstate'), 'utf8').trim() !== 'down';
        } catch {
          /* unknown */
        }
        hostBridges.push({ name: dev, kind: 'bridge', active: up, autostart: true, bridge: dev, subnet: null, ports: this.bridgePorts(dev).filter((p) => !p.startsWith('vnet')), managed: false });
      }
    } catch {
      /* no sysfs */
    }
    return [...nets, ...hostBridges].sort((a, b) => Number(a.managed) - Number(b.managed) || a.name.localeCompare(b.name));
  }

  private bridgePorts(bridge: string): string[] {
    try {
      return readdirSync(join(this.sysClassNet, bridge, 'brif')).sort();
    } catch {
      return [];
    }
  }

  async createNetwork(p: { name: string; kind: 'nat' | 'isolated'; subnet: string }): Promise<VirtualNetwork> {
    const plan = planSubnet(p.subnet);
    const existing = await this.networks();
    if (existing.some((n) => n.name === p.name)) throw conflict(`There is already a network called ${p.name}`);
    const overlap = existing.find((n) => n.subnet && n.subnet.split('/')[0] === p.subnet.split('/')[0]);
    if (overlap) throw conflict(`${overlap.name} already uses ${overlap.subnet}`);
    const def = [
      `<network>`,
      `  <name>${esc(p.name)}</name>`,
      p.kind === 'nat' ? `  <forward mode='nat'/>` : '',
      `  <bridge stp='on' delay='0'/>`,
      `  <ip address='${plan.address}' prefix='${plan.prefix}'>`,
      `    <dhcp><range start='${plan.dhcpStart}' end='${plan.dhcpEnd}'/></dhcp>`,
      `  </ip>`,
      `</network>`,
    ]
      .filter(Boolean)
      .join('\n');
    await this.withXmlFile(def, (f) => this.run(['net-define', f]));
    try {
      await this.run(['net-start', p.name]);
      await this.run(['net-autostart', p.name]);
    } catch (e) {
      await this.run(['net-undefine', p.name]).catch(() => undefined);
      throw e;
    }
    const made = (await this.networks()).find((n) => n.name === p.name);
    if (!made) throw new VirtualError(500, `The network ${p.name} did not appear`);
    return made;
  }

  async deleteNetwork(name: string): Promise<void> {
    const info = parseInfo(await this.run(['net-info', name]));
    const users: string[] = [];
    for (const uuid of nonEmptyLines(await this.run(['list', '--all', '--uuid']))) {
      try {
        const p = parseDomainXml(await this.xmlOf(uuid, true));
        if (p.nics.some((n) => n.kind === 'network' && n.source === name)) users.push(p.name);
      } catch {
        /* gone */
      }
    }
    if (users.length) throw conflict(`${name} is used by ${users.join(', ')}`);
    if (info.active === 'yes') await this.run(['net-destroy', name]);
    await this.run(['net-undefine', name]).catch((e) => {
      throw new VirtualError(500, `Could not remove ${name}: ${errorMessage(e)}`);
    });
  }
}
