import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audited, need, type VirtualContext } from '../context';
import { conflict } from '../errors';
import { ISOS_POOL } from '../drivers/types';
import { ISO_NAME_RE } from '../isos';

const POOL_RE = /^[A-Za-z0-9._-]{1,64}$/;
const NET_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,14}$/;

export async function storageRoutes(app: FastifyInstance, ctx: VirtualContext) {
  // ------------------------------------------------------------------------------ storage

  app.get('/v1/storage/pools', async (req) => {
    need(req, 'viewer');
    return { pools: await ctx.hv.pools() };
  });

  app.get('/v1/storage/pools/:pool/volumes', async (req) => {
    need(req, 'viewer');
    const { pool } = z.object({ pool: z.string().regex(POOL_RE) }).parse(req.params);
    return { volumes: await ctx.hv.volumes(pool) };
  });

  app.delete('/v1/storage/pools/:pool/volumes/:name', async (req) => {
    need(req, 'admin');
    const { pool, name } = z.object({ pool: z.string().regex(POOL_RE), name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+()-]{0,200}$/) }).parse(req.params);
    if (pool === ISOS_POOL) {
      await audited(ctx, req, 'iso.delete', name, async () => {
        const used = (await ctx.hv.volumes(ISOS_POOL)).find((v) => v.name === name)?.usedBy ?? [];
        if (used.length) throw conflict(`${name} is in the CD drive of ${used.join(', ')}`);
        await ctx.isos.remove(name);
      });
    } else await audited(ctx, req, 'volume.delete', `${pool}/${name}`, () => ctx.hv.deleteVolume(pool, name));
    return { ok: true };
  });

  // -------------------------------------------------------------------------------- ISOs

  app.get('/v1/isos', async (req) => {
    need(req, 'viewer');
    const used = new Map((await ctx.hv.volumes(ISOS_POOL).catch(() => [])).map((v) => [v.name, v.usedBy]));
    return { isos: ctx.isos.list().map((i) => ({ ...i, usedBy: used.get(i.name) ?? [] })), downloads: ctx.isos.listDownloads() };
  });

  // Uploads stream straight to disk (installer images are several gigabytes).
  app.put('/v1/isos/:name', { bodyLimit: ctx.config.maxUploadBytes }, async (req) => {
    need(req, 'operator');
    const { name } = z.object({ name: z.string().regex(ISO_NAME_RE, 'ISO names end in .iso or .img') }).parse(req.params);
    return audited(ctx, req, 'iso.upload', name, () => ctx.isos.upload(name, req.body as NodeJS.ReadableStream));
  });

  app.post('/v1/isos/download', async (req) => {
    need(req, 'operator');
    const body = z.object({ url: z.string().url().max(2000), name: z.string().regex(ISO_NAME_RE, 'ISO names end in .iso or .img') }).parse(req.body);
    return audited(ctx, req, 'iso.download', body.name, () => ctx.isos.download(body.url, body.name), { url: body.url });
  });

  app.delete('/v1/isos/downloads/:id', async (req) => {
    need(req, 'operator');
    ctx.isos.cancelDownload((req.params as { id: string }).id);
    return { downloads: ctx.isos.listDownloads() };
  });

  app.delete('/v1/isos/:name', async (req) => {
    need(req, 'operator');
    const { name } = z.object({ name: z.string().regex(ISO_NAME_RE) }).parse(req.params);
    await audited(ctx, req, 'iso.delete', name, async () => {
      const used = (await ctx.hv.volumes(ISOS_POOL).catch(() => [])).find((v) => v.name === name)?.usedBy ?? [];
      if (used.length) throw conflict(`${name} is in the CD drive of ${used.join(', ')}`);
      await ctx.isos.remove(name);
    });
    return { ok: true };
  });

  // ------------------------------------------------------------------------------ networks

  app.get('/v1/networks', async (req) => {
    need(req, 'viewer');
    return { networks: await ctx.hv.networks() };
  });

  app.post('/v1/networks', async (req) => {
    need(req, 'admin');
    const body = z.object({ name: z.string().regex(NET_RE, 'Network names: up to 15 letters, digits, dots, dashes, underscores'), kind: z.enum(['nat', 'isolated']), subnet: z.string().max(32) }).parse(req.body);
    return audited(ctx, req, 'network.create', body.name, () => ctx.hv.createNetwork(body), body);
  });

  app.delete('/v1/networks/:name', async (req) => {
    need(req, 'admin');
    const { name } = z.object({ name: z.string().regex(NET_RE) }).parse(req.params);
    await audited(ctx, req, 'network.delete', name, () => ctx.hv.deleteNetwork(name));
    return { ok: true };
  });
}
