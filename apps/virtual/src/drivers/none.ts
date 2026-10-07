import type { HypervisorInfo, StoragePool, StorageVolume, VirtualNetwork, VmDetail, VmSnapshot, VmSummary } from '@fbrx/shared';
import { conflict, notFound } from '../errors';
import type { Hypervisor } from './types';

const NO = () => conflict('This server does not run virtual machines (FBRX Virtual is not one of its roles: install.sh --roles virtual,…)');

/** A server without the virtual role (a gate, say): the console still runs, with no virtual machines. */
export class NoHypervisor implements Hypervisor {
  readonly kind = 'none' as const;
  async prepare(): Promise<void> {}
  async info(): Promise<HypervisorInfo> {
    return { driver: 'none', version: null, kvm: false, uefi: false, tpm: false };
  }
  async listVms(): Promise<VmSummary[]> {
    return [];
  }
  async getVm(): Promise<VmDetail> {
    throw notFound('No such virtual machine');
  }
  async createVm(): Promise<VmDetail> {
    throw NO();
  }
  async updateVm(): Promise<VmDetail> {
    throw NO();
  }
  async power(): Promise<void> {
    throw NO();
  }
  async deleteVm(): Promise<void> {
    throw NO();
  }
  async snapshots(): Promise<VmSnapshot[]> {
    return [];
  }
  async createSnapshot(): Promise<void> {
    throw NO();
  }
  async revertSnapshot(): Promise<void> {
    throw NO();
  }
  async deleteSnapshot(): Promise<void> {
    throw NO();
  }
  async consoleEndpoint() {
    return null;
  }
  async attachHostdev(): Promise<void> {
    throw NO();
  }
  async detachHostdev(): Promise<void> {
    throw NO();
  }
  async hostdevUsers(): Promise<Map<string, string>> {
    return new Map();
  }
  async pools(): Promise<StoragePool[]> {
    return [];
  }
  async volumes(): Promise<StorageVolume[]> {
    return [];
  }
  async deleteVolume(): Promise<void> {
    throw NO();
  }
  async refreshPool(): Promise<void> {}
  async networks(): Promise<VirtualNetwork[]> {
    return [];
  }
  async createNetwork(): Promise<VirtualNetwork> {
    throw NO();
  }
  async deleteNetwork(): Promise<void> {
    throw NO();
  }
}
