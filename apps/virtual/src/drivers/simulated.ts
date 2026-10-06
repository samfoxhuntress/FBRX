import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import type { HypervisorInfo, StoragePool, StorageVolume, VirtualNetwork, VmChanges, VmDetail, VmPowerAction, VmSnapshot, VmCreateSpec, VmState, VmSummary } from '@fbrx/shared';
import { badRequest, conflict, notFound } from '../errors';
import { planSubnet } from './libvirt';
import { IMAGES_POOL, ISOS_POOL, type Hypervisor } from './types';

interface SimVm {
  id: string;
  name: string;
  os: VmCreateSpec['os'];
  cpus: number;
  memoryMb: number;
  diskGb: number;
  pool: string;
  autostart: boolean;
  description: string;
  state: VmState;
  startedAt: number | null;
  firmware: VmCreateSpec['firmware'];
  secureBoot: boolean;
  tpm: boolean;
  iso: string | null;
  network: VmCreateSpec['network'];
  mac: string;
  cpuset: string | null;
  hostdevs: string[];
  createdAt: string;
  snapshots: Array<{ name: string; description: string; createdAt: string; state: VmState; copy: Omit<SimVm, 'snapshots'> }>;
  currentSnapshot: string | null;
}

interface SimState {
  vms: SimVm[];
  networks: VirtualNetwork[];
}

const mac = () => `52:54:00:${[0, 0, 0].map(() => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join(':')}`;

/**
 * Pretend virtual machines for development, demos and tests on computers without a hypervisor. They answer like real
 * ones (power, snapshots, disks, networks) but nothing runs. Kept in a JSON file so they survive restarts. The ISO
 * library is real: it lists the files in the ISO folder.
 */
export class SimulatedHypervisor implements Hypervisor {
  readonly kind = 'simulated' as const;
  private state: SimState;
  private readonly file: string;

  constructor(private readonly opts: { dataDir: string; isosDir: string; seed?: boolean }) {
    this.file = join(opts.dataDir, 'simulated-hypervisor.json');
    this.state = this.load();
  }

  private load(): SimState {
    try {
      if (existsSync(this.file)) return JSON.parse(readFileSync(this.file, 'utf8')) as SimState;
    } catch {
      /* start fresh */
    }
    const now = new Date().toISOString();
    const base = { pool: IMAGES_POOL, description: '', iso: null, cpuset: null, hostdevs: [], createdAt: now, snapshots: [], currentSnapshot: null, secureBoot: false, tpm: false };
    const seed: SimVm[] =
      this.opts.seed === false
        ? []
        : [
            { ...base, id: randomUUID(), name: 'files-01', os: 'linux', cpus: 2, memoryMb: 4096, diskGb: 64, autostart: true, description: 'File shares for the house', state: 'running', startedAt: Date.now() - 3 * 86400_000, firmware: 'uefi', network: { kind: 'network', source: 'default' }, mac: mac() },
            { ...base, id: randomUUID(), name: 'win11-lab', os: 'windows', cpus: 4, memoryMb: 8192, diskGb: 80, autostart: false, description: 'Windows 11 test machine', state: 'stopped', startedAt: null, firmware: 'uefi', secureBoot: true, tpm: true, network: { kind: 'network', source: 'default' }, mac: mac() },
          ];
    return {
      vms: seed,
      networks: [{ name: 'default', kind: 'nat', active: true, autostart: true, bridge: 'virbr0', subnet: '192.168.122.0/24', ports: [], managed: true }],
    };
  }

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.state, null, 2));
  }

  private vm(id: string): SimVm {
    const v = this.state.vms.find((x) => x.id === id || x.name === id);
    if (!v) throw notFound(`No virtual machine ${id}`);
    return v;
  }

  async prepare(): Promise<void> {
    mkdirSync(this.opts.isosDir, { recursive: true });
  }

  async info(): Promise<HypervisorInfo> {
    return { driver: 'simulated', version: 'simulated', kvm: false, uefi: true, tpm: true };
  }

  private live(v: SimVm) {
    return v.state === 'running' || v.state === 'paused';
  }

  private summary(v: SimVm): VmSummary {
    const running = v.state === 'running';
    const wobble = (seed: number) => (Math.sin(Date.now() / 7000 + seed) + 1) / 2;
    const n = v.id.charCodeAt(0);
    return {
      id: v.id,
      name: v.name,
      state: v.state,
      os: v.os,
      cpus: v.cpus,
      memoryMb: v.memoryMb,
      diskGb: v.diskGb,
      autostart: v.autostart,
      description: v.description,
      cpuPct: running ? Math.round((4 + wobble(n) * 30) * 10) / 10 : this.live(v) ? 0 : null,
      memoryUsedMb: this.live(v) ? Math.round(v.memoryMb * (0.35 + wobble(n + 1) * 0.3)) : null,
      ip: this.live(v) && v.network.kind === 'network' ? `192.168.122.${10 + (n % 200)}` : null,
      uptimeSeconds: this.live(v) && v.startedAt ? Math.round((Date.now() - v.startedAt) / 1000) : null,
      cpuset: v.cpuset,
    };
  }

  private detail(v: SimVm): VmDetail {
    const s = this.summary(v);
    const win = v.os === 'windows';
    return {
      ...s,
      firmware: v.firmware,
      secureBoot: v.secureBoot,
      tpm: v.tpm,
      machine: 'pc-q35',
      disks: [
        { target: win ? 'sda' : 'vda', device: 'disk', path: `/simulated/${v.pool}/${v.name}.qcow2`, bus: win ? 'sata' : 'virtio', sizeGb: v.diskGb, allocatedGb: Math.round(v.diskGb * 0.3 * 100) / 100 },
        { target: win ? 'sdb' : 'sda', device: 'cdrom', path: v.iso, bus: 'sata', sizeGb: null, allocatedGb: null },
      ],
      nics: [{ mac: v.mac, kind: v.network.kind, source: v.network.source, model: win ? 'e1000e' : 'virtio', ip: s.ip }],
      iso: v.iso,
      hostdevs: v.hostdevs.map((address) => ({ address, name: address })),
      console: false,
      restartNeeded: false,
      createdAt: v.createdAt,
    };
  }

  async listVms(): Promise<VmSummary[]> {
    return this.state.vms.map((v) => this.summary(v)).sort((a, b) => a.name.localeCompare(b.name));
  }

  async getVm(id: string): Promise<VmDetail> {
    return this.detail(this.vm(id));
  }

  async createVm(spec: VmCreateSpec, isoPath: string | null): Promise<VmDetail> {
    if (this.state.vms.some((v) => v.name === spec.name)) throw conflict(`There is already a virtual machine called ${spec.name}`);
    if (spec.network.kind === 'network' && !this.state.networks.some((n) => n.name === spec.network.source)) throw notFound(`No network ${spec.network.source}`);
    const v: SimVm = {
      id: randomUUID(),
      name: spec.name,
      os: spec.os,
      cpus: spec.cpus,
      memoryMb: spec.memoryMb,
      diskGb: spec.diskGb,
      pool: spec.pool ?? IMAGES_POOL,
      autostart: !!spec.autostart,
      description: spec.description ?? '',
      state: spec.startNow ? 'running' : 'stopped',
      startedAt: spec.startNow ? Date.now() : null,
      firmware: spec.firmware,
      secureBoot: spec.firmware === 'uefi' && !!spec.secureBoot,
      tpm: !!spec.tpm,
      iso: isoPath,
      network: spec.network,
      mac: mac(),
      cpuset: null,
      hostdevs: [],
      createdAt: new Date().toISOString(),
      snapshots: [],
      currentSnapshot: null,
    };
    this.state.vms.push(v);
    this.save();
    return this.detail(v);
  }

  async updateVm(id: string, c: VmChanges, isoPath: string | null | undefined): Promise<VmDetail> {
    const v = this.vm(id);
    if (c.diskGb !== undefined && c.diskGb < v.diskGb) throw badRequest(`Disks can only grow (it is ${v.diskGb} GB now)`);
    if (c.cpus !== undefined) v.cpus = c.cpus;
    if (c.memoryMb !== undefined) v.memoryMb = c.memoryMb;
    if (c.autostart !== undefined) v.autostart = c.autostart;
    if (c.description !== undefined) v.description = c.description;
    if (c.diskGb !== undefined) v.diskGb = c.diskGb;
    if (c.cpuset !== undefined) v.cpuset = c.cpuset;
    if (isoPath !== undefined) v.iso = isoPath;
    this.save();
    return this.detail(v);
  }

  async power(id: string, action: VmPowerAction): Promise<void> {
    const v = this.vm(id);
    const live = this.live(v);
    switch (action) {
      case 'start':
        if (live) throw conflict('Requested operation is not valid: domain is already running');
        v.state = 'running';
        v.startedAt = Date.now();
        break;
      case 'shutdown':
      case 'stop':
        if (!live) throw conflict('Requested operation is not valid: domain is not running');
        v.state = 'stopped';
        v.startedAt = null;
        break;
      case 'reboot':
        if (!live) throw conflict('Requested operation is not valid: domain is not running');
        v.state = 'running';
        v.startedAt = Date.now();
        break;
      case 'pause':
        if (v.state !== 'running') throw conflict('Requested operation is not valid: domain is not running');
        v.state = 'paused';
        break;
      case 'resume':
        if (v.state !== 'paused') throw conflict('Requested operation is not valid: domain is not paused');
        v.state = 'running';
        break;
    }
    this.save();
  }

  async deleteVm(id: string): Promise<void> {
    const v = this.vm(id);
    if (v.state !== 'stopped') throw conflict('Turn the virtual machine off before deleting it');
    this.state.vms = this.state.vms.filter((x) => x !== v);
    this.save();
  }

  async snapshots(id: string): Promise<VmSnapshot[]> {
    const v = this.vm(id);
    return v.snapshots.map((s) => ({ name: s.name, description: s.description, createdAt: s.createdAt, state: s.state, current: s.name === v.currentSnapshot }));
  }

  async createSnapshot(id: string, name: string, description: string): Promise<void> {
    const v = this.vm(id);
    if (v.snapshots.some((s) => s.name === name)) throw conflict(`There is already a snapshot called ${name}`);
    if (v.firmware === 'uefi' && v.state !== 'stopped') throw conflict('Turn this virtual machine off to take a snapshot (machines with UEFI firmware are snapshotted while off)');
    const { snapshots: _s, ...copy } = v;
    v.snapshots.push({ name, description, createdAt: new Date().toISOString(), state: v.state, copy: JSON.parse(JSON.stringify(copy)) });
    v.currentSnapshot = name;
    this.save();
  }

  async revertSnapshot(id: string, name: string): Promise<void> {
    const v = this.vm(id);
    const s = v.snapshots.find((x) => x.name === name);
    if (!s) throw notFound(`No snapshot ${name}`);
    if (v.firmware === 'uefi' && v.state !== 'stopped') throw conflict('Turn this virtual machine off to go back to a snapshot');
    Object.assign(v, JSON.parse(JSON.stringify(s.copy)), { snapshots: v.snapshots, currentSnapshot: name, startedAt: s.state === 'running' ? Date.now() : null });
    this.save();
  }

  async deleteSnapshot(id: string, name: string): Promise<void> {
    const v = this.vm(id);
    if (!v.snapshots.some((s) => s.name === name)) throw notFound(`No snapshot ${name}`);
    v.snapshots = v.snapshots.filter((s) => s.name !== name);
    if (v.currentSnapshot === name) v.currentSnapshot = v.snapshots.at(-1)?.name ?? null;
    this.save();
  }

  async consoleEndpoint(): Promise<null> {
    return null;
  }

  async attachHostdev(id: string, address: string): Promise<void> {
    const v = this.vm(id);
    if (!v.hostdevs.includes(address)) v.hostdevs.push(address);
    this.save();
  }

  async detachHostdev(id: string, address: string): Promise<void> {
    const v = this.vm(id);
    if (!v.hostdevs.includes(address)) throw notFound(`${address} is not given to this virtual machine`);
    v.hostdevs = v.hostdevs.filter((a) => a !== address);
    this.save();
  }

  async hostdevUsers(): Promise<Map<string, string>> {
    return new Map(this.state.vms.flatMap((v) => v.hostdevs.map((a) => [a, v.name] as [string, string])));
  }

  private isoFiles(): Array<{ name: string; path: string; size: number }> {
    try {
      return readdirSync(this.opts.isosDir)
        .filter((f) => /\.(iso|img)$/i.test(f))
        .map((f) => ({ name: f, path: join(this.opts.isosDir, f), size: statSync(join(this.opts.isosDir, f)).size }));
    } catch {
      return [];
    }
  }

  async pools(): Promise<StoragePool[]> {
    const used = this.state.vms.reduce((n, v) => n + v.diskGb * 0.3, 0);
    const isoGb = this.isoFiles().reduce((n, f) => n + f.size / 1024 ** 3, 0);
    const r = (n: number) => Math.round(n * 100) / 100;
    return [
      { name: IMAGES_POOL, path: '/simulated/images', type: 'dir', active: true, capacityGb: 1024, allocationGb: r(used), availableGb: r(1024 - used), role: 'images' },
      { name: ISOS_POOL, path: this.opts.isosDir, type: 'dir', active: true, capacityGb: 1024, allocationGb: r(isoGb), availableGb: r(1024 - isoGb), role: 'isos' },
    ];
  }

  async volumes(pool: string): Promise<StorageVolume[]> {
    if (pool === ISOS_POOL) {
      return this.isoFiles().map((f) => ({ name: f.name, path: f.path, format: 'iso', capacityGb: Math.round((f.size / 1024 ** 3) * 100) / 100, allocationGb: Math.round((f.size / 1024 ** 3) * 100) / 100, usedBy: this.state.vms.filter((v) => v.iso === f.path).map((v) => v.name) }));
    }
    if (pool !== IMAGES_POOL) throw notFound(`No storage pool ${pool}`);
    return this.state.vms.map((v) => ({ name: `${v.name}.qcow2`, path: `/simulated/${v.pool}/${v.name}.qcow2`, format: 'qcow2', capacityGb: v.diskGb, allocationGb: Math.round(v.diskGb * 0.3 * 100) / 100, usedBy: [v.name] }));
  }

  async deleteVolume(pool: string, name: string): Promise<void> {
    const vols = await this.volumes(pool);
    const vol = vols.find((v) => v.name === name);
    if (!vol) throw notFound(`No volume ${name} in ${pool}`);
    if (vol.usedBy.length) throw conflict(`${name} is used by ${vol.usedBy.join(', ')}`);
    if (pool !== ISOS_POOL) throw badRequest(`Simulated disks go away with their virtual machine (${basename(name)})`);
  }

  async refreshPool(): Promise<void> {}

  async networks(): Promise<VirtualNetwork[]> {
    return [...this.state.networks, { name: 'br0', kind: 'bridge' as const, active: true, autostart: true, bridge: 'br0', subnet: null, ports: ['eno1'], managed: false }];
  }

  async createNetwork(p: { name: string; kind: 'nat' | 'isolated'; subnet: string }): Promise<VirtualNetwork> {
    const plan = planSubnet(p.subnet);
    if (this.state.networks.some((n) => n.name === p.name)) throw conflict(`There is already a network called ${p.name}`);
    const subnet = `${plan.address.replace(/\.\d+$/, '.0')}/${plan.prefix}`;
    const n: VirtualNetwork = { name: p.name, kind: p.kind, active: true, autostart: true, bridge: `virbr${this.state.networks.length}`, subnet, ports: [], managed: true };
    this.state.networks.push(n);
    this.save();
    return n;
  }

  async deleteNetwork(name: string): Promise<void> {
    if (!this.state.networks.some((n) => n.name === name)) throw notFound(`No network ${name}`);
    const users = this.state.vms.filter((v) => v.network.kind === 'network' && v.network.source === name).map((v) => v.name);
    if (users.length) throw conflict(`${name} is used by ${users.join(', ')}`);
    this.state.networks = this.state.networks.filter((n) => n.name !== name);
    this.save();
  }
}
