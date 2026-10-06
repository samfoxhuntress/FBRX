import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hostInfo } from '../host';
import { audited, need, type VirtualContext } from '../context';
import { CPUSET_RE } from '../drivers/xml';
import { PCI_RE } from '../hardware/topology';

export async function hardwareRoutes(app: FastifyInstance, ctx: VirtualContext) {
  app.get('/v1/host', async (req) => {
    need(req, 'viewer');
    return hostInfo(ctx.hv, ctx.version, ctx.config.sysRoot);
  });

  app.get('/v1/hardware/topology', async (req) => {
    need(req, 'viewer');
    return ctx.hardware.topology();
  });

  app.get('/v1/hardware/flows', async (req) => {
    need(req, 'viewer');
    return ctx.hardware.flows();
  });

  /** Sends a device's interrupts (its data's first stop) to chosen processors; null puts them back on all. */
  app.put('/v1/hardware/devices/:address/irqs', async (req) => {
    need(req, 'admin');
    const { address } = z.object({ address: z.string().regex(PCI_RE) }).parse(req.params);
    const { cpus } = z.object({ cpus: z.string().regex(CPUSET_RE, 'Give processors like 0-3 or 0,2,4').nullable() }).parse(req.body);
    return audited(ctx, req, 'hardware.irqs', address.toLowerCase(), () => ctx.hardware.setDeviceIrqs(address.toLowerCase(), cpus), { cpus });
  });

  app.put('/v1/hardware/irqs/:irq', async (req) => {
    need(req, 'admin');
    const { irq } = z.object({ irq: z.coerce.number().int().min(0).max(65535) }).parse(req.params);
    const { cpus } = z.object({ cpus: z.string().regex(CPUSET_RE) }).parse(req.body);
    await audited(ctx, req, 'hardware.irq', String(irq), () => ctx.hardware.setIrq(irq, cpus), { cpus });
    return ctx.hardware.topology();
  });

  app.put('/v1/hardware/irqbalance', async (req) => {
    need(req, 'admin');
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    await audited(ctx, req, 'hardware.irqbalance', enabled ? 'on' : 'off', () => ctx.hardware.setIrqbalance(enabled));
    return ctx.hardware.topology();
  });
}
