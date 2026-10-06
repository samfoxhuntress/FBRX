import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audited, need, type VirtualContext } from '../context';

const Value = z.union([z.string().max(500), z.number(), z.boolean()]);

export async function bmcRoutes(app: FastifyInstance, ctx: VirtualContext) {
  app.get('/v1/bmc', async (req) => {
    need(req, 'viewer');
    return { config: ctx.bmc.config() };
  });

  /** The certificate the controller presents, to check before trusting it. */
  app.post('/v1/bmc/probe', async (req) => {
    need(req, 'admin');
    const { host } = z.object({ host: z.string().min(1).max(260) }).parse(req.body);
    return ctx.bmc.probe(host);
  });

  app.put('/v1/bmc', async (req) => {
    need(req, 'admin');
    const body = z.object({ host: z.string().min(1).max(260), username: z.string().min(1).max(64), password: z.string().min(1).max(200), fingerprint: z.string().max(200).nullable() }).parse(req.body);
    return { config: await audited(ctx, req, 'bmc.connect', body.host, () => ctx.bmc.connect(body), { username: body.username, fingerprint: body.fingerprint }) };
  });

  app.delete('/v1/bmc', async (req) => {
    need(req, 'admin');
    await audited(ctx, req, 'bmc.disconnect', ctx.bmc.config()?.host ?? null, () => ctx.bmc.disconnect());
    return { config: null };
  });

  app.get('/v1/bmc/system', async (req) => {
    need(req, 'viewer');
    return ctx.bmc.use((rf) => rf.system());
  });

  app.get('/v1/bmc/sensors', async (req) => {
    need(req, 'viewer');
    return { sensors: await ctx.bmc.use((rf) => rf.sensors()) };
  });

  app.get('/v1/bmc/logs', async (req) => {
    need(req, 'viewer');
    return { entries: await ctx.bmc.use((rf) => rf.logs()) };
  });

  app.post('/v1/bmc/power', async (req) => {
    need(req, 'admin');
    const { resetType } = z.object({ resetType: z.string().regex(/^[A-Za-z]{2,40}$/) }).parse(req.body);
    await audited(ctx, req, 'bmc.power', resetType, () => ctx.bmc.use((rf) => rf.reset(resetType)));
    return { ok: true };
  });

  app.post('/v1/bmc/boot-to-setup', async (req) => {
    need(req, 'admin');
    const { restart } = z.object({ restart: z.boolean().default(false) }).parse(req.body ?? {});
    await audited(ctx, req, 'bmc.boot-to-setup', restart ? 'restart now' : 'next start', () => ctx.bmc.use((rf) => rf.bootToSetup(restart)));
    return { ok: true };
  });

  app.get('/v1/bmc/bios', async (req) => {
    need(req, 'viewer');
    return ctx.bmc.use((rf) => rf.bios());
  });

  /** Stages BIOS changes for the next restart (and restarts now when asked). */
  app.patch('/v1/bmc/bios', async (req) => {
    need(req, 'admin');
    const body = z.object({ changes: z.record(z.string().regex(/^[A-Za-z0-9_.]{1,120}$/), Value), restart: z.boolean().default(false) }).parse(req.body);
    const out = await audited(
      ctx,
      req,
      'bmc.bios.set',
      Object.keys(body.changes).join(', '),
      () =>
        ctx.bmc.use(async (rf) => {
          const r = await rf.setBios(body.changes);
          if (body.restart) await rf.reset('GracefulRestart');
          return r;
        }),
      { changes: body.changes, restart: body.restart },
    );
    return { ...out, bios: await ctx.bmc.use((rf) => rf.bios()) };
  });

  app.delete('/v1/bmc/bios/pending', async (req) => {
    need(req, 'admin');
    await audited(ctx, req, 'bmc.bios.clear', null, () => ctx.bmc.use((rf) => rf.clearPending()));
    return ctx.bmc.use((rf) => rf.bios());
  });
}
