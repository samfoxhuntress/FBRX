import type { HwFlows, HwTopology } from '@fbrx/shared';
import type { Db } from '@fbrx/shared/node';
import { badRequest, VirtualError } from '../errors';
import type { Hypervisor } from '../drivers/types';
import { FlowSampler } from './flows';
import { setDeviceAffinity, setIrqAffinity, setIrqbalance, validCpus } from './irq';
import { compactCpus, readTopology } from './topology';

const PINS = 'irq-pins';

/** The hardware view: what is in the server, live data flow, and steering a device's interrupts to chosen processors. */
export class HardwareService {
  private readonly sampler: FlowSampler;

  constructor(
    private readonly db: Db,
    private readonly hv: Hypervisor,
    private readonly root: string,
    private readonly log: (msg: string) => void = () => undefined,
  ) {
    this.sampler = new FlowSampler(root);
  }

  pinned(): Record<string, string> {
    const row = this.db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', PINS);
    return row ? (JSON.parse(row.value) as Record<string, string>) : {};
  }

  private savePins(p: Record<string, string>) {
    this.db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', PINS, JSON.stringify(p));
  }

  async topology(): Promise<HwTopology> {
    const passthrough = await this.hv.hostdevUsers().catch(() => new Map<string, string>());
    const pinned = this.pinned();
    const topo = readTopology({ root: this.root, passthrough, pinned });
    if (topo.source === 'sample') {
      for (const d of topo.devices) {
        const cpus = pinned[d.address];
        if (cpus) d.irqs = d.irqs.map((i) => ({ ...i, cpus, effective: cpus.split(/[-,]/)[0] ?? null }));
      }
    }
    return topo;
  }

  flows(): Promise<HwFlows> {
    return this.sampler.flows();
  }

  /**
   * Sends a device's interrupts to these processors (null: back to all of them) and remembers it, so it is put back
   * after a restart. Returns interrupts Linux would not move.
   */
  async setDeviceIrqs(address: string, cpus: string | null): Promise<{ refused: number[]; topology: HwTopology }> {
    const topo = await this.topology();
    const dev = topo.devices.find((d) => d.address === address);
    if (!dev) throw badRequest(`No PCI device ${address}`);
    const target = cpus === null ? compactCpus(Array.from({ length: topo.totalCpus }, (_, i) => i)) : validCpus(cpus, topo.totalCpus);
    const refused = topo.source === 'sample' ? [] : setDeviceAffinity(this.root, topo, address, target);
    const pins = this.pinned();
    if (cpus === null) delete pins[address];
    else pins[address] = target;
    this.savePins(pins);
    return { refused, topology: await this.topology() };
  }

  async setIrq(irq: number, cpus: string): Promise<void> {
    const topo = await this.topology();
    if (topo.source === 'sample') throw badRequest('The sample server has no real interrupts');
    setIrqAffinity(this.root, irq, validCpus(cpus, topo.totalCpus));
  }

  async setIrqbalance(enabled: boolean): Promise<void> {
    if (this.root !== '/') throw badRequest('Only on the server itself');
    await setIrqbalance(enabled);
  }

  /** Puts remembered interrupt placements back (at start-up: Linux forgets them when it restarts). */
  async applyPinned(): Promise<void> {
    const pins = this.pinned();
    if (!Object.keys(pins).length) return;
    const topo = await this.topology();
    if (topo.source === 'sample') return;
    for (const [address, cpus] of Object.entries(pins)) {
      if (!topo.devices.some((d) => d.address === address)) {
        this.log(`Interrupt placement for ${address} skipped: the device is not in this server any more`);
        continue;
      }
      try {
        const refused = setDeviceAffinity(this.root, topo, address, cpus);
        if (refused.length) this.log(`Linux kept interrupts ${refused.join(', ')} of ${address} where they were`);
      } catch (e) {
        this.log(`Could not place interrupts for ${address}: ${e instanceof VirtualError ? e.message : String(e)}`);
      }
    }
  }
}
