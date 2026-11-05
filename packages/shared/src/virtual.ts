/**
 * FBRX Virtual: the hypervisor that FBRX Server runs (FBRX OS for servers). These are the shapes its API returns to
 * the FBRX Virtual console (and, later, to FBRX Command).
 */

export const VIRTUAL_PRODUCT = 'FBRX Virtual';
export const VIRTUAL_DEFAULT_PORT = 9443;

export type VirtualRole = 'admin' | 'operator' | 'viewer';
export const VIRTUAL_ROLES: readonly VirtualRole[] = ['admin', 'operator', 'viewer'];

export interface VirtualUser {
  id: string;
  username: string;
  name: string;
  role: VirtualRole;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface HypervisorInfo {
  /** "libvirt" on a real server; "simulated" for development and demos (no virtual machines really run). */
  driver: 'libvirt' | 'simulated' | 'none';
  version: string | null;
  /** Hardware acceleration: without it virtual machines run in slow software emulation. */
  kvm: boolean;
  /** UEFI firmware for virtual machines is installed. */
  uefi: boolean;
  /** A software TPM (for Windows 11) is installed. */
  tpm: boolean;
}

export interface HostInfo {
  hostname: string;
  product: string;
  version: string;
  os: string;
  kernel: string;
  vendor: string | null;
  model: string | null;
  serial: string | null;
  bios: { vendor: string | null; version: string | null; date: string | null };
  cpu: { model: string; sockets: number; cores: number; threads: number; mhz: number | null };
  memory: { totalMb: number; usedMb: number };
  load: number[];
  cpuPct: number;
  uptimeSeconds: number;
  hypervisor: HypervisorInfo;
  /** Intel VT-d / AMD-Vi is on (needed to give a PCI device to a virtual machine). */
  iommu: boolean;
  warnings: string[];
}

export type VmState = 'running' | 'paused' | 'stopped' | 'shutting-down' | 'crashed' | 'suspended' | 'unknown';
export type VmOs = 'linux' | 'windows' | 'other';
export type VmFirmware = 'bios' | 'uefi';
export type VmPowerAction = 'start' | 'shutdown' | 'reboot' | 'stop' | 'pause' | 'resume';

export interface VmDisk {
  target: string;
  device: 'disk' | 'cdrom';
  path: string | null;
  bus: string;
  sizeGb: number | null;
  allocatedGb: number | null;
}

export interface VmNic {
  mac: string;
  kind: 'network' | 'bridge';
  source: string;
  model: string;
  ip: string | null;
}

export interface VmSummary {
  id: string;
  name: string;
  state: VmState;
  os: VmOs;
  cpus: number;
  memoryMb: number;
  diskGb: number;
  autostart: boolean;
  description: string;
  /** Live figures while it runs. */
  cpuPct: number | null;
  memoryUsedMb: number | null;
  ip: string | null;
  uptimeSeconds: number | null;
  /** Host CPUs it is pinned to (null: any). */
  cpuset: string | null;
  /** The networks and switches its network cards are plugged into (libvirt network names, or bridges). */
  networks: string[];
}

export interface VmDetail extends VmSummary {
  firmware: VmFirmware;
  secureBoot: boolean;
  tpm: boolean;
  machine: string;
  disks: VmDisk[];
  nics: VmNic[];
  /** The ISO in the virtual CD drive, if any. */
  iso: string | null;
  hostdevs: Array<{ address: string; name: string }>;
  console: boolean;
  /** Processor, memory or device changes are saved and wait for the next start. */
  restartNeeded: boolean;
  createdAt: string | null;
}

export interface VmCreateSpec {
  name: string;
  os: VmOs;
  cpus: number;
  memoryMb: number;
  diskGb: number;
  pool?: string;
  /** An ISO from the ISO library, put in the virtual CD drive. */
  iso?: string | null;
  network: { kind: 'network' | 'bridge'; source: string };
  firmware: VmFirmware;
  secureBoot?: boolean;
  tpm?: boolean;
  autostart?: boolean;
  description?: string;
  startNow?: boolean;
}

export interface VmChanges {
  cpus?: number;
  memoryMb?: number;
  autostart?: boolean;
  description?: string;
  /** Put an ISO in the CD drive (null: eject). */
  iso?: string | null;
  /** Grow the first disk to this size (never shrinks). */
  diskGb?: number;
  /** Run on these host CPUs ("0-3", "4-7", null for any): keeps it next to the hardware it uses. */
  cpuset?: string | null;
  /** Plug its network card into another network or switch (it keeps its MAC address, so reservations follow it). */
  network?: { kind: 'network' | 'bridge'; source: string };
}

export interface VmSnapshot {
  name: string;
  description: string;
  createdAt: string;
  state: VmState;
  current: boolean;
}

export interface StoragePool {
  name: string;
  path: string | null;
  type: string;
  active: boolean;
  capacityGb: number;
  allocationGb: number;
  availableGb: number;
  /** "images" for virtual disks, "isos" for the ISO library. */
  role: 'images' | 'isos' | 'other';
}

export interface StorageVolume {
  name: string;
  path: string;
  format: string;
  capacityGb: number;
  allocationGb: number;
  /** The virtual machines that use it. */
  usedBy: string[];
}

export interface IsoImage {
  name: string;
  path: string;
  sizeBytes: number;
  modifiedAt: string;
}

export interface IsoDownload {
  id: string;
  name: string;
  url: string;
  received: number;
  total: number | null;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  error: string | null;
}

export interface VirtualNetwork {
  name: string;
  /** "nat": a private network with internet through the server; "isolated": machines only; "bridge": straight onto the LAN. */
  kind: 'nat' | 'isolated' | 'bridge' | 'other';
  active: boolean;
  autostart: boolean;
  bridge: string | null;
  subnet: string | null;
  /** For a host bridge: the physical ports in it. */
  ports: string[];
  managed: boolean;
  /** A switch of FBRX Gate on this server: machines on it are on that gate network (addresses, rules) like its devices. */
  gate?: { network: string; purpose: string; address: string; access: 'full' | 'internet' | 'isolated'; port: string } | null;
}

// ------------------------------------------------------------------------------------- hardware view

export interface HwCpuNode {
  node: number;
  cpus: string;
  cpuCount: number;
  memoryMb: number | null;
  model: string | null;
  socket: number | null;
}

export type HwDeviceKind = 'network' | 'storage' | 'display' | 'usb' | 'bridge' | 'other';

export interface HwDevice {
  address: string;
  /** Parent PCI bridge (null: straight off the processor or chipset root). */
  parent: string | null;
  kind: HwDeviceKind;
  name: string;
  vendor: string | null;
  driver: string | null;
  numaNode: number | null;
  link: { speed: string | null; width: number | null; maxSpeed: string | null; maxWidth: number | null } | null;
  iommuGroup: number | null;
  /** What sits on it: network ports, disks. */
  interfaces: string[];
  /** Interrupt lines and which CPUs handle them. */
  irqs: Array<{ irq: number; name: string; cpus: string; effective: string | null }>;
  /** Given to a virtual machine. */
  passthroughVm: string | null;
}

export interface HwTopology {
  /** "system": read from this server; "sample": a made-up server (this computer has no Linux hardware view). */
  source: 'system' | 'sample';
  nodes: HwCpuNode[];
  devices: HwDevice[];
  /** IRQ balancing is running (it may move interrupts back). */
  irqbalance: boolean;
  /** Interrupt placements FBRX Virtual keeps (re-applied at start-up), by PCI address. */
  pinned: Record<string, string>;
  totalCpus: number;
  collectedAt: string;
}

/** Live throughput per network port and disk, and where it flows. */
export interface HwFlows {
  at: string;
  intervalMs: number;
  items: Array<{ id: string; kind: 'network' | 'disk'; device: string | null; rxBps: number; txBps: number }>;
}

// ------------------------------------------------------------------- server management (Redfish)

export interface BmcConfig {
  host: string;
  username: string;
  fingerprint: string | null;
  /** The controller's name ("iDRAC 8", "iLO 5", "Redfish"). */
  kind: string | null;
  connectedAt: string | null;
  lastError: string | null;
}

export interface BmcProbe {
  host: string;
  fingerprint: string;
  subject: string;
  issuer: string;
  trusted: boolean;
}

export interface BmcSystem {
  manufacturer: string | null;
  model: string | null;
  serial: string | null;
  serviceTag: string | null;
  biosVersion: string | null;
  powerState: string | null;
  health: string | null;
  hostName: string | null;
  processors: string | null;
  memoryGb: number | null;
  controller: { name: string; firmware: string | null } | null;
  resetTypes: string[];
}

export interface BmcSensor {
  kind: 'temperature' | 'fan' | 'power' | 'voltage';
  name: string;
  reading: number | null;
  unit: string;
  health: string | null;
  upperCritical: number | null;
}

export interface BiosAttribute {
  name: string;
  displayName: string;
  value: string | number | boolean | null;
  pending: string | number | boolean | null;
  type: 'enum' | 'string' | 'integer' | 'boolean' | 'password' | 'unknown';
  options: Array<{ value: string; label: string }>;
  readOnly: boolean;
  group: string;
  help: string | null;
  min: number | null;
  max: number | null;
}

export interface BiosSettings {
  attributes: BiosAttribute[];
  /** Changes waiting for the next restart. */
  pendingCount: number;
  jobs: Array<{ id: string; name: string; state: string; percent: number | null; message: string | null }>;
}

export interface BmcLogEntry {
  id: string;
  at: string | null;
  severity: string | null;
  message: string;
}

export interface VirtualAuditEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string | null;
  outcome: 'success' | 'failure';
  details: string | null;
}

// ------------------------------------------------------------------------------------------ server roles

/** A role FBRX Server can have (install.sh --roles, fbrx-server roles, or Roles in the console). */
export interface ServerRoleInfo {
  id: string;
  name: string;
  what: string;
  /** Roles it works through. */
  needs?: string[];
  /** It takes two network ports (internet, your network). */
  ports?: boolean;
}

export const SERVER_ROLE_CATALOG: ServerRoleInfo[] = [
  { id: 'virtual', name: 'FBRX Virtual', what: 'Virtual machines on this server (KVM), with their networks, storage and ISOs.' },
  { id: 'ai', name: 'AI', what: 'An AI agent on FBRX Mesh, and bigger AI models that every computer on the mesh can use.' },
  { id: 'gate', name: 'FBRX Gate', what: 'The router and firewall for your network, on two of this server’s network ports.', ports: true },
  { id: 'minidome', name: 'FBRX MiniDome', what: 'Watches the network through FBRX Gate for threats and tells the computer they are about.', needs: ['gate'] },
  { id: 'time', name: 'FBRX Time', what: 'Image backups of virtual machines and computers, each checked by starting it as a throwaway machine.', needs: ['virtual'] },
  { id: 'command', name: 'FBRX Command', what: 'Your organization’s FBRX Command on this server: its computers, their settings and policy, licenses and updates, with its own console.' },
];

/** FBRX Command on this server (the command role), as the server console shows it. */
export interface ServerCommandStatus {
  /** The command role is on. */
  enabled: boolean;
  /** Its service answers. */
  running: boolean;
  version: string | null;
  /** Nobody has set it up yet: its first sign-in asks for the setup token. Null while it does not answer. */
  needsSetup: boolean | null;
  /** Where people and computers reach it (https://<this server>:8787). */
  url: string | null;
  /** Its certificate's SHA-256 fingerprint, which a computer compares once when it joins. */
  fingerprint: string | null;
  /** The one-time setup token, shown to administrators until FBRX Command is set up. */
  setupToken: string | null;
  /** Why it does not answer, in words. */
  error: string | null;
  /** On a gate: the gate's firewall lets your networks reach it (null without the gate role). */
  gateOpen: boolean | null;
  /** This server's FBRX core (the ai role) in an FBRX Command: null when it has not joined one (or has no ai role). */
  joined: { server: string; organization: string | null; state: string } | null;
  /** This server has the ai role, which is what joins an FBRX Command. */
  canJoin: boolean;
}

/** A change of roles: running, or how the last one ended (fbrx-server roles writes it). */
export interface RoleChange {
  state: 'running' | 'done' | 'failed';
  roles: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** The end of the installer's output. */
  log: string;
}

export interface ServerRolesStatus {
  roles: string[];
  catalog: ServerRoleInfo[];
  /** Roles can be changed from here (the server keeps a copy of its installer). */
  canChange: boolean;
  /** Why not, in words. */
  why: string | null;
  change: RoleChange | null;
  /** Network ports, for the gate role. */
  ports: string[];
  gate: { wan: string; lan: string };
}

/** What is wrong with a set of roles, in words (null: fine). */
export function rolesProblem(roles: string[]): string | null {
  if (!roles.length) return 'Pick at least one role';
  for (const r of roles) {
    const info = SERVER_ROLE_CATALOG.find((x) => x.id === r);
    if (!info) return `There is no ${r} role`;
    const missing = (info.needs ?? []).filter((n) => !roles.includes(n));
    if (missing.length) return `${info.name} works through ${missing.map((m) => SERVER_ROLE_CATALOG.find((x) => x.id === m)?.name ?? m).join(' and ')}: add it too`;
  }
  return null;
}
