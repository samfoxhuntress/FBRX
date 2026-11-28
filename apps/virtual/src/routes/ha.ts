import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { HaSettingsSchema } from '@fbrx/shared';
import { HA_SIGNED_TYPE, HA_WITNESS_SIGNATURE, HaWitnessError, peerCertificate } from '@fbrx/shared/node';
import { audited, need, type VirtualContext } from '../context';
import { VirtualError, badRequest } from '../errors';

/**
 * High availability: the pair (pairing, its settings and third vote, switching over and handing back), and this
 * server as the third vote of another pair. What the partner and a pair's servers send is signed with their secret,
 * as text (application/fbrx-signed+json), so the signature is checked over exactly what was sent.
 */
const signature = (h: string | string[] | undefined) => (Array.isArray(h) ? h[0] : h);

export async function haRoutes(app: FastifyInstance, ctx: VirtualContext) {
  // A full copy goes in parts of about a megabyte (written as JSON, a little more).
  app.addContentTypeParser(HA_SIGNED_TYPE, { parseAs: 'string', bodyLimit: 16 * 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.get('/v1/ha', async (req) => {
    need(req, 'viewer');
    return ctx.ha.status();
  });

  // ---------------------------------------------------------------------------------------------- pairing

  app.post('/v1/ha/code', async (req) => {
    need(req, 'admin');
    return audited(ctx, req, 'ha.code', null, () => ctx.ha.makeCode());
  });

  app.delete('/v1/ha/code', async (req) => {
    need(req, 'admin');
    ctx.ha.cancelCode();
    return ctx.ha.status();
  });

  /** The certificate a server presents (to trust it by its fingerprint before pairing, or for a third vote). */
  app.post('/v1/ha/check', async (req) => {
    need(req, 'admin');
    const { address } = z.object({ address: z.string().trim().min(1).max(300) }).parse(req.body);
    const url = /^https:\/\//i.test(address) ? address : `https://${address.includes(':') && !address.startsWith('[') ? address : `${address}:9443`}`;
    try {
      return await peerCertificate(url, 8_000);
    } catch (e) {
      throw badRequest(`Could not reach ${address}: ${(e as Error).message}`);
    }
  });

  app.post('/v1/ha/pair', async (req) => {
    need(req, 'admin');
    const i = z.object({ address: z.string().trim().min(1).max(300), fingerprint: z.string().trim().min(32).max(200), code: z.string().trim().min(4).max(40), linkAddress: z.string().trim().max(64).nullable().optional() }).parse(req.body);
    return audited(ctx, req, 'ha.pair', i.address, () => ctx.ha.pairWith(i));
  });

  /** The primary asks to pair (with this server's pairing code): no signed-in person, the code is the proof. */
  app.post('/v1/ha/join', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const out = ctx.ha.join(req.body, req.socket.remoteAddress ?? '');
    ctx.audit.record('pair', 'ha.joined', null, 'success', { partner: (req.body as { node?: { name?: string } }).node?.name ?? null });
    return out;
  });

  app.delete('/v1/ha', async (req) => {
    const u = need(req, 'admin');
    return audited(ctx, req, 'ha.unpair', null, () => ctx.ha.unpair(u.name || u.username));
  });

  // -------------------------------------------------------------------------------------- running the pair

  app.post('/v1/ha/switchover', async (req) => {
    const u = need(req, 'admin');
    return audited(ctx, req, 'ha.switchover', null, () => ctx.ha.switchover(u.name || u.username, 'switchover'));
  });

  app.post('/v1/ha/handback', async (req) => {
    const u = need(req, 'admin');
    return audited(ctx, req, 'ha.handback', null, () => ctx.ha.switchover(u.name || u.username, 'handback'));
  });

  app.put('/v1/ha/settings', async (req) => {
    need(req, 'admin');
    const i = HaSettingsSchema.partial().parse(req.body);
    return audited(ctx, req, 'ha.settings', null, () => ctx.ha.setSettings(i), i);
  });

  /** This server's own address in each of the gate's networks (each server sets its own). */
  app.put('/v1/ha/gate', async (req) => {
    need(req, 'admin');
    const { own } = z.object({ own: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,30}$/), z.string().trim().max(64)) }).parse(req.body);
    return audited(ctx, req, 'ha.gate', null, () => ctx.ha.setGateOwn(own), { own });
  });

  app.put('/v1/ha/witness', async (req) => {
    need(req, 'admin');
    const i = z.object({ url: z.string().trim().min(1).max(300), fingerprint: z.string().trim().max(200).nullable().optional(), key: z.string().trim().min(10).max(200) }).parse(req.body);
    return audited(ctx, req, 'ha.witness', i.url, () => ctx.ha.setWitness(i), { url: i.url });
  });

  app.delete('/v1/ha/witness', async (req) => {
    need(req, 'admin');
    return audited(ctx, req, 'ha.witness', null, () => ctx.ha.setWitness(null));
  });

  /** From the partner: signed with the pair's secret. */
  app.post('/v1/ha/peer', async (req) => {
    if (typeof req.body !== 'string') throw badRequest('Send it signed');
    return ctx.ha.handlePeer(req.body, signature(req.headers[HA_WITNESS_SIGNATURE.toLowerCase()]));
  });

  // ---------------------------------------------------------------------- this server as a third vote

  app.get('/v1/ha/witness/keys', async (req) => {
    need(req, 'admin');
    return { keys: ctx.ha.status().witnessKeys, holders: ctx.ha.witness.holders(), fingerprint: ctx.tls?.fingerprint ?? null };
  });

  app.post('/v1/ha/witness/keys', async (req) => {
    need(req, 'admin');
    const { label } = z.object({ label: z.string().trim().max(80).default('') }).parse(req.body ?? {});
    return audited(ctx, req, 'ha.witness.key', label || null, () => ctx.ha.addWitnessKey(label));
  });

  app.delete('/v1/ha/witness/keys/:id', async (req) => {
    need(req, 'admin');
    const { id } = req.params as { id: string };
    return audited(ctx, req, 'ha.witness.key.remove', id, () => {
      ctx.ha.removeWitnessKey(id);
      return { ok: true };
    });
  });

  /** A pair's server asks for (or keeps, or gives up) its lease: signed with the pair's third-vote key. */
  app.post('/v1/ha/witness/lease', { config: { rateLimit: { max: 1200, timeWindow: '1 minute' } } }, async (req) => {
    if (typeof req.body !== 'string') throw badRequest('Send it signed');
    try {
      return ctx.ha.witness.handle(req.body, signature(req.headers[HA_WITNESS_SIGNATURE.toLowerCase()]));
    } catch (e) {
      if (e instanceof HaWitnessError) throw new VirtualError(e.status, e.message);
      throw e;
    }
  });
}
