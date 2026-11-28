import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { FbrxAlertSchema, newId, type FbrxAlert } from '@fbrx/shared';
import { verifyFbrxAlertSignature } from '@fbrx/shared/node';
import type { AppContext } from '../context';
import { actorOf, adminAuth, assertTenantAccess, requirePerm, tenantScope } from '../auth';
import { HttpError, badRequest, notFound } from '../errors';

/**
 * FBRX Command → Alerts: the organization's alerts (going on now, and recently), acknowledging them, the rules for who
 * gets what, and the address FBRX Servers send their alerts to (signed with the organization's secret).
 */
export async function alertRoutes(app: FastifyInstance, ctx: AppContext) {
  // ----------------------------------------------------------------------- from FBRX Servers (signed webhooks)
  await app.register(async (inbound) => {
    // The signature covers the body exactly as sent, so it is read as text.
    inbound.removeContentTypeParser('application/json');
    inbound.addContentTypeParser('application/json', { parseAs: 'string', bodyLimit: 64 * 1024 }, (_req, body, done) => done(null, body));
    inbound.post('/v1/alerts/inbound/:tenantId', { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } }, async (req, reply) => {
      const { tenantId } = req.params as { tenantId: string };
      const secret = /^[\w-]{1,64}$/.test(tenantId) ? ctx.alerts.inboundSecret(tenantId) : null;
      const raw = typeof req.body === 'string' ? req.body : '';
      const signature = req.headers['fbrx-signature'];
      if (!secret || !verifyFbrxAlertSignature(raw, typeof signature === 'string' ? signature : null, secret)) {
        // The same answer for an unknown organization and a wrong signature.
        return reply.code(401).send({ error: { code: 'UNAUTHENTICATED', message: 'Not signed with this organization’s alert secret' } });
      }
      let alert: FbrxAlert;
      try {
        alert = FbrxAlertSchema.parse(JSON.parse(raw));
      } catch {
        return reply.code(400).send({ error: { code: 'INVALID_ARGUMENT', message: 'Not an FBRX Alert v1' } });
      }
      const row = ctx.alerts.ingest(tenantId, alert);
      return { ok: true, id: row?.id ?? null };
    });
  });

  // ---------------------------------------------------------------------------------------- the console
  await app.register(async (admin) => {
    admin.addHook('preHandler', adminAuth(ctx));
    const tenantOf = (req: FastifyRequest) => {
      const t = tenantScope(req);
      if (!t) throw badRequest('Choose an organization');
      return t;
    };

    admin.get('/v1/admin/alerts', async (req) => {
      requirePerm(req, 'alerts.read');
      return ctx.alerts.list(tenantScope(req));
    });

    /** The incident report: what happened to the alert, in order, and the same as text to copy or download. */
    admin.get('/v1/admin/alerts/:id/report', async (req) => {
      requirePerm(req, 'alerts.read');
      const { id } = req.params as { id: string };
      const tenantId = ctx.alerts.tenantOf(id);
      if (!tenantId) throw notFound('Unknown alert');
      assertTenantAccess(req, tenantId);
      return ctx.alerts.report(id);
    });

    admin.post('/v1/admin/alerts/:id/acknowledge', async (req) => {
      const p = requirePerm(req, 'alerts.acknowledge');
      const { id } = req.params as { id: string };
      const tenantId = ctx.alerts.tenantOf(id);
      if (!tenantId) throw notFound('Unknown alert');
      assertTenantAccess(req, tenantId);
      const { note } = z.object({ note: z.string().max(500).optional() }).parse(req.body ?? {});
      const row = ctx.alerts.acknowledge(id, p.label.replace(/^\w+:/, ''), note?.trim() || null);
      ctx.audit.record(actorOf(req), 'alert.acknowledged', { type: 'alert', id, tenantId }, { title: row.alert.title, note: note ?? null });
      return row;
    });

    admin.get('/v1/admin/alerts/rules', async (req) => {
      requirePerm(req, 'alerts.read');
      return { rules: ctx.alerts.rules(tenantOf(req)) };
    });

    admin.put('/v1/admin/alerts/rules', async (req) => {
      requirePerm(req, 'alerts.manage');
      const tenantId = tenantOf(req);
      const { rules } = z.object({ rules: z.array(z.record(z.string(), z.unknown())).max(50) }).parse(req.body);
      try {
        const saved = ctx.alerts.saveRules(tenantId, rules);
        ctx.audit.record(actorOf(req), 'alert.rules.updated', { type: 'tenant', id: tenantId, tenantId }, { rules: saved.map((r) => r.name) });
        return { rules: saved };
      } catch (err) {
        if (err instanceof z.ZodError) throw badRequest(err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
        throw err;
      }
    });

    admin.get('/v1/admin/alerts/inbound', async (req) => {
      requirePerm(req, 'alerts.read');
      return ctx.alerts.inbound(tenantOf(req), ctx.config.publicUrl);
    });

    /** A new signing secret for FBRX Servers' alerts, shown once. */
    admin.post('/v1/admin/alerts/inbound/secret', async (req) => {
      requirePerm(req, 'alerts.manage');
      const tenantId = tenantOf(req);
      const secret = ctx.alerts.newInboundSecret(tenantId);
      ctx.audit.record(actorOf(req), 'alert.inbound.secret', { type: 'tenant', id: tenantId, tenantId });
      return { ...ctx.alerts.inbound(tenantId, ctx.config.publicUrl), secret };
    });

    /** A test alert through the organization's rules (it ends at once, with its all-clear). */
    admin.post('/v1/admin/alerts/test', async (req) => {
      const p = requirePerm(req, 'alerts.manage');
      const tenantId = tenantOf(req);
      const now = new Date().toISOString();
      const key = `fbrx-command|test|${newId('t')}`;
      const alert: FbrxAlert = {
        v: 1,
        id: newId('fa'),
        key,
        state: 'open',
        severity: 'warning',
        source: { app: 'fbrx-command', host: 'FBRX Command' },
        rule: 'test',
        title: 'Test alert from FBRX Command',
        detail: `Sent by ${p.label.replace(/^\w+:/, '')} to check who gets what. Nothing is wrong.`,
        startedAt: now,
        sentAt: now,
      };
      const row = ctx.alerts.ingest(tenantId, alert);
      if (!row) throw new HttpError(500, 'The test alert was not kept', 'INTERNAL');
      ctx.audit.record(actorOf(req), 'alert.test', { type: 'tenant', id: tenantId, tenantId });
      return row;
    });
  });
}
