import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SCHEDULES } from '@fbrx/shared';
import { allows } from '../auth';
import { audited, need, type VirtualContext } from '../context';
import { conflict } from '../errors';

const jobBody = z.object({
  name: z.string().max(80).optional(),
  vmId: z.string().min(1).max(100),
  schedule: z.enum(SCHEDULES as ['off', 'daily', 'weekly']),
  time: z.string().max(5),
  day: z.number().int().min(0).max(6),
  verify: z.boolean(),
  keep: z.number().int().min(1).max(365),
  enabled: z.boolean().optional(),
});

/** The address people reach this console on, for the backup folder's path (\\address\fbrx-time). */
function hostOf(req: FastifyRequest): string {
  const h = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? 'fbrx-server';
  return h.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
}

/** FBRX Time (the time role): backup jobs, images, boot checks, restores and the backup folder for computers. */
export async function timeRoutes(app: FastifyInstance, ctx: VirtualContext) {
  const time = () => {
    if (!ctx.time) throw conflict('FBRX Time is not on this server: add the time role (Roles in this console, or sudo fbrx-server roles add time)');
    return ctx.time;
  };

  app.get('/v1/time', async (req) => {
    const user = need(req, 'viewer');
    if (!ctx.time) return { enabled: false };
    return time().status({ host: hostOf(req), admin: allows(user.role, 'admin'), enabled: true });
  });

  app.get('/v1/time/jobs', async (req) => {
    need(req, 'viewer');
    return { jobs: time().jobs() };
  });

  app.post('/v1/time/jobs', async (req) => {
    need(req, 'admin');
    const body = jobBody.parse(req.body);
    return audited(ctx, req, 'time.job.create', body.vmId, async () => ({ job: await time().createJob(body) }), { schedule: body.schedule, time: body.time });
  });

  app.put<{ Params: { id: string } }>('/v1/time/jobs/:id', async (req) => {
    need(req, 'admin');
    const body = jobBody.omit({ vmId: true }).partial().parse(req.body);
    const job = time().job(req.params.id);
    return audited(ctx, req, 'time.job.update', job.name, () => ({ job: time().updateJob(job.id, body) }));
  });

  app.delete<{ Params: { id: string } }>('/v1/time/jobs/:id', async (req) => {
    need(req, 'admin');
    const job = time().job(req.params.id);
    return audited(ctx, req, 'time.job.delete', job.name, () => (time().deleteJob(job.id), { ok: true }));
  });

  app.post<{ Params: { id: string } }>('/v1/time/jobs/:id/run', async (req) => {
    need(req, 'operator');
    const job = time().job(req.params.id);
    return audited(ctx, req, 'time.job.run', job.name, async () => ({ task: await time().runJob(job.id) }));
  });

  /** Backs up one virtual machine now, without a job. */
  app.post('/v1/time/backup', async (req) => {
    need(req, 'operator');
    const { vmId } = z.object({ vmId: z.string().min(1).max(100) }).parse(req.body);
    return audited(ctx, req, 'time.backup', vmId, async () => ({ task: await time().backupVm(vmId) }));
  });

  app.get<{ Querystring: { subject?: string } }>('/v1/time/images', async (req) => {
    need(req, 'viewer');
    return { images: time().images(req.query.subject) };
  });

  app.get<{ Params: { id: string } }>('/v1/time/images/:id/screenshot', async (req) => {
    need(req, 'viewer');
    return { dataUrl: time().screenshot(req.params.id) };
  });

  app.post<{ Params: { id: string } }>('/v1/time/images/:id/check', async (req) => {
    need(req, 'operator');
    const img = time().image(req.params.id);
    return audited(ctx, req, 'time.check', `${img.subject} ${img.createdAt}`, () => ({ task: time().check(img.id) }));
  });

  app.post<{ Params: { id: string } }>('/v1/time/images/:id/restore', async (req) => {
    need(req, 'admin');
    const { name } = z.object({ name: z.string().max(63).default('') }).parse(req.body ?? {});
    const img = time().image(req.params.id);
    return audited(ctx, req, 'time.restore', `${img.subject} ${img.createdAt}`, () => ({ task: time().restore(img.id, name) }), { name });
  });

  app.delete<{ Params: { id: string } }>('/v1/time/images/:id', async (req) => {
    need(req, 'admin');
    const img = time().image(req.params.id);
    return audited(ctx, req, 'time.image.delete', `${img.subject} ${img.createdAt}`, () => (time().deleteImage(img.id), { ok: true }));
  });

  /** Looks in the backup folder for computers' finished backups now. */
  app.post('/v1/time/computers/scan', async (req) => {
    need(req, 'operator');
    return { kept: await time().scanComputers() };
  });

  app.post('/v1/time/cancel', async (req) => {
    need(req, 'operator');
    return audited(ctx, req, 'time.cancel', null, () => ({ stopped: time().cancelCurrent() }));
  });

  app.put('/v1/time/settings', async (req) => {
    need(req, 'admin');
    const body = z.object({ verifyComputers: z.boolean(), checkSeconds: z.number().int(), keepComputer: z.number().int() }).partial().parse(req.body);
    return audited(ctx, req, 'time.settings', null, () => ({ settings: time().setSettings(body) }), body);
  });
}
