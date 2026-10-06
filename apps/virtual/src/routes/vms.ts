import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { VmChanges, VmCreateSpec } from '@fbrx/shared';
import { audited, need, type VirtualContext } from '../context';
import { relay } from '../console-proxy';
import { badRequest, conflict, notFound } from '../errors';
import { VM_NAME_RE } from '../drivers/types';
import { CPUSET_RE } from '../drivers/xml';
import { PCI_RE } from '../hardware/topology';

const SNAP_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

const Spec = z.object({
  name: z.string().regex(VM_NAME_RE, 'Names use letters, digits, dots, dashes and underscores (up to 63)'),
  os: z.enum(['linux', 'windows', 'other']),
  cpus: z.number().int().min(1).max(128),
  memoryMb: z.number().int().min(128).max(4 * 1024 * 1024),
  diskGb: z.number().int().min(1).max(64 * 1024),
  pool: z.string().max(64).optional(),
  iso: z.string().max(200).nullable().optional(),
  network: z.object({ kind: z.enum(['network', 'bridge']), source: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/) }),
  firmware: z.enum(['bios', 'uefi']),
  secureBoot: z.boolean().optional(),
  tpm: z.boolean().optional(),
  autostart: z.boolean().optional(),
  description: z.string().max(2000).optional(),
  startNow: z.boolean().optional(),
});

const Changes = z.object({
  cpus: z.number().int().min(1).max(128).optional(),
  memoryMb: z.number().int().min(128).max(4 * 1024 * 1024).optional(),
  autostart: z.boolean().optional(),
  description: z.string().max(2000).optional(),
  iso: z.string().max(200).nullable().optional(),
  diskGb: z.number().int().min(1).max(64 * 1024).optional(),
  cpuset: z.string().regex(CPUSET_RE, 'Give processors like 0-3 or 0,2,4').nullable().optional(),
});

export async function vmRoutes(app: FastifyInstance, ctx: VirtualContext) {
  const label = async (id: string) => (await ctx.hv.getVm(id)).name;

  app.get('/v1/vms', async (req) => {
    need(req, 'viewer');
    return { vms: await ctx.hv.listVms() };
  });

  app.post('/v1/vms', async (req) => {
    need(req, 'operator');
    const spec = Spec.parse(req.body) as VmCreateSpec;
    if (spec.secureBoot && spec.firmware !== 'uefi') throw badRequest('Secure Boot needs UEFI firmware');
    const iso = spec.iso ? ctx.isos.path(spec.iso) : null;
    return audited(ctx, req, 'vm.create', spec.name, () => ctx.hv.createVm(spec, iso), { cpus: spec.cpus, memoryMb: spec.memoryMb, diskGb: spec.diskGb, os: spec.os, iso: spec.iso ?? null });
  });

  app.get('/v1/vms/:id', async (req) => {
    need(req, 'viewer');
    const vm = await ctx.hv.getVm((req.params as { id: string }).id);
    return { ...vm, isoName: ctx.isos.nameOf(vm.iso) };
  });

  app.patch('/v1/vms/:id', async (req) => {
    need(req, 'operator');
    const { id } = req.params as { id: string };
    const c = Changes.parse(req.body) as VmChanges;
    if (c.cpuset !== undefined) need(req, 'admin');
    const iso = c.iso === undefined ? undefined : c.iso === null ? null : ctx.isos.path(c.iso);
    const { iso: _i, ...rest } = c;
    return audited(ctx, req, 'vm.update', await label(id), () => ctx.hv.updateVm(id, rest, iso), c);
  });

  app.delete('/v1/vms/:id', async (req) => {
    need(req, 'admin');
    const { id } = req.params as { id: string };
    const q = z.object({ disks: z.enum(['0', '1']).default('1') }).parse(req.query);
    await audited(ctx, req, 'vm.delete', await label(id), () => ctx.hv.deleteVm(id, q.disks === '1'), { disks: q.disks === '1' });
    return { ok: true };
  });

  app.post('/v1/vms/:id/power', async (req) => {
    need(req, 'operator');
    const { id } = req.params as { id: string };
    const { action } = z.object({ action: z.enum(['start', 'shutdown', 'reboot', 'stop', 'pause', 'resume']) }).parse(req.body);
    await audited(ctx, req, `vm.${action}`, await label(id), () => ctx.hv.power(id, action));
    return ctx.hv.getVm(id);
  });

  // ------------------------------------------------------------------------------ snapshots

  app.get('/v1/vms/:id/snapshots', async (req) => {
    need(req, 'viewer');
    return { snapshots: await ctx.hv.snapshots((req.params as { id: string }).id) };
  });

  app.post('/v1/vms/:id/snapshots', async (req) => {
    need(req, 'operator');
    const { id } = req.params as { id: string };
    const body = z.object({ name: z.string().regex(SNAP_RE, 'Snapshot names use letters, digits, dots, dashes and underscores'), description: z.string().max(500).default('') }).parse(req.body);
    await audited(ctx, req, 'vm.snapshot.create', `${await label(id)}@${body.name}`, () => ctx.hv.createSnapshot(id, body.name, body.description));
    return { snapshots: await ctx.hv.snapshots(id) };
  });

  app.post('/v1/vms/:id/snapshots/:name/revert', async (req) => {
    need(req, 'operator');
    const { id, name } = req.params as { id: string; name: string };
    if (!SNAP_RE.test(name)) throw badRequest('Not a snapshot name');
    await audited(ctx, req, 'vm.snapshot.revert', `${await label(id)}@${name}`, () => ctx.hv.revertSnapshot(id, name));
    return { snapshots: await ctx.hv.snapshots(id) };
  });

  app.delete('/v1/vms/:id/snapshots/:name', async (req) => {
    need(req, 'operator');
    const { id, name } = req.params as { id: string; name: string };
    if (!SNAP_RE.test(name)) throw badRequest('Not a snapshot name');
    await audited(ctx, req, 'vm.snapshot.delete', `${await label(id)}@${name}`, () => ctx.hv.deleteSnapshot(id, name));
    return { snapshots: await ctx.hv.snapshots(id) };
  });

  // -------------------------------------------------------------------------------- console

  app.post('/v1/vms/:id/console', async (req) => {
    const user = need(req, 'operator');
    const { id } = req.params as { id: string };
    const vm = await ctx.hv.getVm(id);
    if (ctx.hv.kind === 'simulated') throw conflict('Simulated virtual machines have no screen');
    if (vm.state !== 'running' && vm.state !== 'paused') throw conflict(`Start ${vm.name} to see its screen`);
    const endpoint = await ctx.hv.consoleEndpoint(vm.id);
    if (!endpoint) throw conflict(`${vm.name} has no screen to show (no VNC display)`);
    ctx.audit.record(user.username, 'vm.console', vm.name);
    return { ticket: ctx.tickets.issue(vm.id, user.username), path: `/v1/vms/${vm.id}/console/ws` };
  });

  app.get('/v1/vms/:id/console/ws', { websocket: true }, async (socket, req) => {
    const { id } = req.params as { id: string };
    const ticket = String((req.query as { ticket?: string }).ticket ?? '');
    const who = ctx.tickets.take(ticket, id);
    if (!who) return socket.close(4401, 'Ask for a new console ticket');
    try {
      const endpoint = await ctx.hv.consoleEndpoint(id);
      if (!endpoint) return socket.close(4409, 'The virtual machine is not running');
      relay(socket, endpoint.host, endpoint.port);
    } catch {
      socket.close(1011, 'Console unavailable');
    }
  });

  // ---------------------------------------------------------------------------- passthrough

  app.post('/v1/vms/:id/hostdevs', async (req) => {
    need(req, 'admin');
    const { id } = req.params as { id: string };
    const { address } = z.object({ address: z.string().regex(PCI_RE, 'Give a PCI address like 0000:02:00.0') }).parse(req.body);
    const topo = await ctx.hardware.topology();
    const dev = topo.devices.find((d) => d.address === address.toLowerCase());
    if (!dev) throw notFound(`No PCI device ${address} in this server`);
    if (dev.kind === 'bridge') throw badRequest('Bridges stay with the server');
    if (dev.passthroughVm) throw conflict(`${dev.name} is already given to ${dev.passthroughVm}`);
    if (topo.source === 'system' && dev.iommuGroup === null) throw badRequest('Turn on VT-d (IOMMU) first: Server → BIOS, then intel_iommu=on');
    const vm = await ctx.hv.getVm(id);
    await audited(ctx, req, 'vm.hostdev.attach', vm.name, () => ctx.hv.attachHostdev(id, dev.address), { address: dev.address, device: dev.name });
    return ctx.hv.getVm(id);
  });

  app.delete('/v1/vms/:id/hostdevs/:address', async (req) => {
    need(req, 'admin');
    const { id, address } = req.params as { id: string; address: string };
    if (!PCI_RE.test(address)) throw badRequest('Give a PCI address like 0000:02:00.0');
    const vm = await ctx.hv.getVm(id);
    await audited(ctx, req, 'vm.hostdev.detach', vm.name, () => ctx.hv.detachHostdev(id, address.toLowerCase()), { address });
    return ctx.hv.getVm(id);
  });
}
