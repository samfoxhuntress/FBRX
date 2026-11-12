import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MESH_TRAFFIC_CLASSES, SCHEDULES, type FilesStatus } from '@fbrx/shared';
import { audited, need, type VirtualContext } from '../context';
import { conflict } from '../errors';
import { hostOf } from './time';

const place = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('smb'), path: z.string().max(300), user: z.string().max(100), password: z.string().max(256).optional() }),
  z.object({ kind: z.literal('nfs'), path: z.string().max(300) }),
]);

const backupBody = z.object({
  name: z.string().max(80),
  source: z.discriminatedUnion('kind', [z.object({ kind: z.literal('share'), share: z.string().max(40) }), z.object({ kind: z.literal('remote'), place })]),
  destination: place,
  schedule: z.enum(SCHEDULES as ['off', 'daily', 'weekly']),
  time: z.string().max(5),
  day: z.number().int().min(0).max(6),
  keepDays: z.number().int().min(0).max(3650),
  enabled: z.boolean().optional(),
});

const shareBody = z.object({ name: z.string().max(40), comment: z.string().max(200).optional(), readOnly: z.boolean().optional(), accounts: z.array(z.string().max(40)).max(200).optional() });

/**
 * The file server (the files role): where it serves from, its shares and accounts, priority for its traffic, backups
 * to another device and, on a gate, the firewall rules that let your networks reach it. Running a backup is for
 * operators; the rest for administrators. Passwords never come back out.
 */
export async function filesRoutes(app: FastifyInstance, ctx: VirtualContext) {
  const files = () => {
    if (!ctx.files) throw conflict('The file server is not on this server: add the files role (Roles in this console, or sudo fbrx-server roles add files)');
    return ctx.files;
  };

  app.get('/v1/files', async (req): Promise<FilesStatus | { enabled: false }> => {
    need(req, 'viewer');
    if (!ctx.files) return { enabled: false };
    return { enabled: true, ...(await files().status(hostOf(req))) };
  });

  app.put('/v1/files/mode', async (req) => {
    need(req, 'admin');
    const body = z.object({ mode: z.enum(['off', 'host', 'vm']), vmId: z.string().max(100).optional(), address: z.string().max(45).nullable().optional() }).parse(req.body);
    return audited(ctx, req, 'files.mode', body.mode, async () => (await files().setMode(body.mode, body.vmId ? { vmId: body.vmId, address: body.address } : undefined), { ok: true }), { vmId: body.vmId });
  });

  app.put('/v1/files/vm/autostart', async (req) => {
    need(req, 'admin');
    const { on } = z.object({ on: z.boolean() }).parse(req.body);
    return audited(ctx, req, 'files.vm.autostart', String(on), async () => (await files().setAutostart(on), { ok: true }));
  });

  app.post('/v1/files/shares', async (req) => {
    need(req, 'admin');
    const body = shareBody.parse(req.body);
    return audited(ctx, req, 'files.share.create', body.name, async () => (await files().addShare(body), { ok: true }), { readOnly: !!body.readOnly, accounts: body.accounts ?? [] });
  });

  app.put<{ Params: { name: string } }>('/v1/files/shares/:name', async (req) => {
    need(req, 'admin');
    const body = shareBody.omit({ name: true }).parse(req.body);
    return audited(ctx, req, 'files.share.update', req.params.name, async () => (await files().updateShare(req.params.name, body), { ok: true }), body);
  });

  app.delete<{ Params: { name: string } }>('/v1/files/shares/:name', async (req) => {
    need(req, 'admin');
    return audited(ctx, req, 'files.share.delete', req.params.name, async () => (await files().removeShare(req.params.name), { ok: true }));
  });

  app.post('/v1/files/accounts', async (req) => {
    need(req, 'admin');
    const body = z.object({ name: z.string().max(40), password: z.string().max(200) }).parse(req.body);
    return audited(ctx, req, 'files.account.create', body.name, async () => (await files().addAccount(body.name, body.password), { ok: true }));
  });

  app.put<{ Params: { name: string } }>('/v1/files/accounts/:name/password', async (req) => {
    need(req, 'admin');
    const { password } = z.object({ password: z.string().max(200) }).parse(req.body);
    return audited(ctx, req, 'files.account.password', req.params.name, async () => (await files().setPassword(req.params.name, password), { ok: true }));
  });

  app.delete<{ Params: { name: string } }>('/v1/files/accounts/:name', async (req) => {
    need(req, 'admin');
    return audited(ctx, req, 'files.account.delete', req.params.name, async () => (await files().removeAccount(req.params.name), { ok: true }));
  });

  app.put('/v1/files/priority', async (req) => {
    need(req, 'admin');
    const body = z.object({ enabled: z.boolean(), trafficClass: z.enum(MESH_TRAFFIC_CLASSES).optional() }).parse(req.body);
    return audited(ctx, req, 'files.priority', body.enabled ? (body.trafficClass ?? 'on') : 'off', async () => (await files().setPriority(body), { ok: true }));
  });

  /** On a gate: adds rules letting each network reach the shares, to what is being edited (commit it with What If). */
  app.post('/v1/files/gate', async (req) => {
    const user = need(req, 'admin');
    return audited(ctx, req, 'files.gate.open', null, () => files().openGate(user.username));
  });

  app.post('/v1/files/backups', async (req) => {
    need(req, 'admin');
    const body = backupBody.parse(req.body);
    return audited(ctx, req, 'files.backup.create', body.name, () => ({ backup: files().createBackup(body) }), { schedule: body.schedule, time: body.time, destination: body.destination.path });
  });

  app.put<{ Params: { id: string } }>('/v1/files/backups/:id', async (req) => {
    need(req, 'admin');
    const body = backupBody.partial().parse(req.body);
    const b = files().backup(req.params.id);
    return audited(ctx, req, 'files.backup.update', b.name, () => ({ backup: files().updateBackup(b.id, body) }));
  });

  app.delete<{ Params: { id: string } }>('/v1/files/backups/:id', async (req) => {
    need(req, 'admin');
    const b = files().backup(req.params.id);
    return audited(ctx, req, 'files.backup.delete', b.name, () => (files().deleteBackup(b.id), { ok: true }));
  });

  app.post<{ Params: { id: string } }>('/v1/files/backups/:id/run', async (req) => {
    need(req, 'operator');
    const b = files().backup(req.params.id);
    return audited(ctx, req, 'files.backup.run', b.name, () => ({ backup: files().runBackup(b.id) }));
  });

  app.post<{ Params: { id: string } }>('/v1/files/backups/:id/stop', async (req) => {
    need(req, 'operator');
    const b = files().backup(req.params.id);
    return audited(ctx, req, 'files.backup.stop', b.name, () => (files().stopBackup(b.id), { ok: true }));
  });
}
