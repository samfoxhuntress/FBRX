import { writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type { HwTopology } from '@fbrx/shared';
import { badRequest, notFound, VirtualError } from '../errors';
import { compactCpus, expandCpus } from './topology';

/**
 * Moving interrupts: which processors handle a device's interrupts (and so where its data is first touched). Keeping a
 * fast network card's interrupts on the processor socket it is plugged into, and away from the processors busy
 * virtual machines run on, is the classic way to steer data flow on a server.
 */

export function validCpus(cpus: string, total: number): string {
  const list = expandCpus(cpus);
  if (!list.length || !/^[\d,\-\s]+$/.test(cpus)) throw badRequest('Give processors like 0-3 or 0,2,4');
  const bad = list.find((c) => c >= total);
  if (bad !== undefined) throw badRequest(`This server has processors 0-${total - 1}; there is no ${bad}`);
  return compactCpus(list);
}

/** Writes one interrupt's processor list (Linux may refuse some, such as the timer's: those keep where they are). */
export function setIrqAffinity(root: string, irq: number, cpus: string): void {
  try {
    writeFileSync(join(root, 'proc/irq', String(irq), 'smp_affinity_list'), `${cpus}\n`);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw notFound(`There is no interrupt ${irq}`);
    if (code === 'EACCES' || code === 'EPERM') throw new VirtualError(403, 'FBRX Virtual needs to run as root to move interrupts');
    if (code === 'EIO' || code === 'EINVAL') throw badRequest(`Linux keeps interrupt ${irq} where it is`);
    throw e;
  }
}

/** Moves all of a device's interrupts. Returns the ones Linux refused. */
export function setDeviceAffinity(root: string, topo: HwTopology, address: string, cpus: string): number[] {
  const dev = topo.devices.find((d) => d.address === address);
  if (!dev) throw notFound(`No PCI device ${address}`);
  if (!dev.irqs.length) throw badRequest(`${dev.name} has no interrupts to move`);
  const refused: number[] = [];
  for (const i of dev.irqs) {
    try {
      setIrqAffinity(root, i.irq, cpus);
    } catch (e) {
      if (e instanceof VirtualError && e.status === 403) throw e;
      refused.push(i.irq);
    }
  }
  return refused;
}

/** Turns the irqbalance service off or on (it spreads interrupts on its own and would undo manual placement). */
export function setIrqbalance(enabled: boolean): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile('systemctl', [enabled ? 'enable' : 'disable', '--now', 'irqbalance'], { timeout: 30_000 }, (err, _o, stderr) => (err ? reject(new VirtualError(500, stderr.trim() || err.message)) : resolve())),
  );
}
