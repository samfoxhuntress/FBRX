import type { HypervisorInfo, StoragePool, StorageVolume, VirtualNetwork, VmChanges, VmDetail, VmPowerAction, VmSnapshot, VmCreateSpec, VmSummary } from '@fbrx/shared';

/**
 * What FBRX Virtual needs from a hypervisor. The libvirt driver runs real virtual machines (KVM on FBRX Server); the
 * simulated one keeps pretend machines for development, demos and tests on computers without one.
 */
export interface Hypervisor {
  readonly kind: HypervisorInfo['driver'];
  /** Gets the storage pools and default network ready (idempotent). */
  prepare(): Promise<void>;
  info(): Promise<HypervisorInfo>;

  listVms(): Promise<VmSummary[]>;
  getVm(id: string): Promise<VmDetail>;
  createVm(spec: VmCreateSpec, isoPath: string | null): Promise<VmDetail>;
  updateVm(id: string, changes: VmChanges, isoPath: string | null | undefined): Promise<VmDetail>;
  power(id: string, action: VmPowerAction): Promise<void>;
  deleteVm(id: string, deleteDisks: boolean): Promise<void>;

  snapshots(id: string): Promise<VmSnapshot[]>;
  createSnapshot(id: string, name: string, description: string): Promise<void>;
  revertSnapshot(id: string, name: string): Promise<void>;
  deleteSnapshot(id: string, name: string): Promise<void>;

  /** Where the virtual machine's screen can be reached (VNC on this server), while it runs. */
  consoleEndpoint(id: string): Promise<{ host: string; port: number } | null>;

  attachHostdev(id: string, address: string): Promise<void>;
  detachHostdev(id: string, address: string): Promise<void>;
  /** PCI devices given to virtual machines: address → virtual machine name. */
  hostdevUsers(): Promise<Map<string, string>>;

  pools(): Promise<StoragePool[]>;
  volumes(pool: string): Promise<StorageVolume[]>;
  deleteVolume(pool: string, name: string): Promise<void>;
  /** Re-reads a pool's folder (after an ISO was added or removed). */
  refreshPool(pool: string): Promise<void>;

  networks(): Promise<VirtualNetwork[]>;
  createNetwork(p: { name: string; kind: 'nat' | 'isolated'; subnet: string }): Promise<VirtualNetwork>;
  deleteNetwork(name: string): Promise<void>;
}

export const IMAGES_POOL = 'fbrx-images';
export const ISOS_POOL = 'fbrx-isos';

/** Names people type for virtual machines: letters, digits, dot, dash and underscore. */
export const VM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;
