import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { HA_SIGNED_TYPE, HA_WITNESS_SIGNATURE, HaWitnessError } from '@fbrx/shared/node';
import type { AppContext } from '../context';
import { actorOf, adminAuth, requirePerm, tenantScope } from '../auth';
import { HttpError, badRequest, notFound } from '../errors';

/**
 * FBRX Command as the third vote of the organization's FBRX Server pairs: the keys (Alerts → High availability), and
 * the lease the pairs' servers ask for (signed with their key, read as text so the signature covers what was sent).
 */
export async function haRoutes(app: FastifyInstance, ctx: AppContext) {
  await app.register(async (pairs) => {
    pairs.addContentTypeParser(HA_SIGNED_TYPE, { parseAs: 'string', bodyLimit: 16 * 1024 }, (_req, body, done) => done(null, body));
    pairs.post('/v1/ha/witness/lease', { config: { rateLimit: { max: 2400, timeWindow: '1 minute' } } }, async (req, reply) => {
      if (typeof req.body !== 'string') return reply.code(400).send({ error: { code: 'INVALID_ARGUMENT', message: 'Send it signed' } });
      const sig = req.headers[HA_WITNESS_SIGNATURE.toLowerCase()];
      try {
        return ctx.witness.witness.handle(req.body, typeof sig === 'string' ? sig : null);
      } catch (e) {
        if (e instanceof HaWitnessError) return reply.code(e.status).send({ error: { code: e.status === 401 ? 'UNAUTHENTICATED' : 'INVALID_ARGUMENT', message: e.message } });
        throw e;
      }
    });
  });

  await app.register(async (admin) => {
    admin.addHook('preHandler', adminAuth(ctx));
    const tenantOf = (req: FastifyRequest) => {
      const t = tenantScope(req);
      if (!t) throw badRequest('Choose an organization first');
      return t;
    };

    admin.get('/v1/admin/ha/witness', async (req) => {
      requirePerm(req, 'alerts.read');
      return { keys: ctx.witness.list(tenantOf(req)), url: ctx.config.publicUrl || null, fingerprint: ctx.tls?.fingerprint ?? null };
    });

    /** A key for one pair of FBRX Servers, shown this once. */
    admin.post('/v1/admin/ha/witness/keys', async (req) => {
      requirePerm(req, 'alerts.manage');
      const tenantId = tenantOf(req);
      const { label } = z.object({ label: z.string().trim().max(80).default('') }).parse(req.body ?? {});
      let made: { id: string; key: string };
      try {
        made = ctx.witness.add(tenantId, label);
      } catch (e) {
        throw new HttpError(409, (e as Error).message, 'CONFLICT');
      }
      ctx.audit.record(actorOf(req), 'ha.witness.key', { type: 'tenant', id: tenantId, tenantId }, { label });
      return { ...made, url: ctx.config.publicUrl || null, fingerprint: ctx.tls?.fingerprint ?? null };
    });

    admin.delete('/v1/admin/ha/witness/keys/:id', async (req) => {
      requirePerm(req, 'alerts.manage');
      const tenantId = tenantOf(req);
      const { id } = req.params as { id: string };
      if (!ctx.witness.remove(tenantId, id)) throw notFound('That third-vote key is gone already');
      ctx.audit.record(actorOf(req), 'ha.witness.key.removed', { type: 'tenant', id: tenantId, tenantId }, { id });
      return { ok: true };
    });
  });
}
