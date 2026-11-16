import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { remoteInputProblem } from '@fbrx/shared';
import type { AppContext } from '../context';
import { actorOf, adminAuth, assertTenantAccess, requirePerm } from '../auth';
import { badRequest, conflict, forbidden, notFound } from '../errors';

/**
 * Remote screen for administrators: an operator or above, switched on for them by name (Users), gives a ticket
 * number and a reason; the person at the computer says yes (or view only, or no) each time. Only the administrator
 * who started a session can use it, and the audit log keeps who, which computer, the ticket, how long and whether the
 * mouse and keyboard were used. Pictures and input go through FBRX Command to the computer and back.
 */
export async function screenRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = adminAuth(ctx);

  /** The administrator may use remote screen: the role, and the switch on their own user. */
  const allowed = (req: FastifyRequest) => {
    const p = requirePerm(req, 'devices.remote');
    if (p.kind !== 'user') throw forbidden('Remote screen is for people signed in, not API keys');
    const u = ctx.db.get<{ remote_control: number; name: string; email: string }>('SELECT remote_control, name, email FROM users WHERE id = ?', p.id);
    if (!u?.remote_control) throw forbidden('Remote screen is not switched on for you: an owner or administrator turns it on in Users');
    return { p, name: u.name || u.email };
  };

  const mine = (req: FastifyRequest) => {
    const { p } = allowed(req);
    const s = ctx.screen.sessions.get((req.params as { sid: string }).sid);
    if (!s || s.adminId !== p.id) throw notFound('That screen session is over');
    return s;
  };

  app.post('/v1/admin/devices/:id/screen', { preHandler: auth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const { p, name } = allowed(req);
    const { id } = req.params as { id: string };
    // Sessions a browser left without ending (closed, crashed) are forgotten after half a day.
    for (const [k, v] of ctx.screen.sessions) if (Date.now() - Date.parse(v.startedAt) > 12 * 3600_000) ctx.screen.sessions.delete(k);
    const body = z.object({ mode: z.enum(['view', 'control']), ticket: z.string().trim().min(1).max(40), reason: z.string().trim().max(300).default('') }).parse(req.body);
    if (/[\u0000-\u001f\u007f]/.test(body.ticket + body.reason)) throw badRequest('No control characters in the ticket or the reason');
    const d = ctx.db.get<{ id: string; name: string; tenant_id: string; status: string }>('SELECT id, name, tenant_id, status FROM devices WHERE id = ?', id);
    if (!d) throw notFound('No such computer');
    assertTenantAccess(req, d.tenant_id);
    if (d.status !== 'active') throw conflict(`This computer is ${d.status}`);
    const session = await ctx.screen.call<{ id: string; mode: 'view' | 'control'; state: string }>(d.id, 'start', { admin: name, ticket: body.ticket, reason: body.reason, mode: body.mode });
    ctx.screen.sessions.set(session.id, { id: session.id, deviceId: d.id, tenantId: d.tenant_id, adminId: p.id, admin: name, ticket: body.ticket, reason: body.reason, mode: body.mode, startedAt: new Date().toISOString() });
    ctx.audit.record(actorOf(req), 'device.screen.requested', { type: 'device', id: d.id, tenantId: d.tenant_id }, { session: session.id, mode: body.mode, ticket: body.ticket, reason: body.reason });
    return session;
  });

  app.get('/v1/admin/screen/:sid', { preHandler: auth }, async (req) => {
    const s = mine(req);
    const r = await ctx.screen.call<{ state: string; mode: string }>(s.deviceId, 'session', { id: s.id });
    if (r.state === 'ended' || r.state === 'denied') ctx.screen.sessions.delete(s.id);
    return r;
  });

  app.get('/v1/admin/screen/:sid/frame', { preHandler: auth }, async (req) => {
    const s = mine(req);
    const q = z.object({ after: z.coerce.number().int().optional(), display: z.coerce.number().int().min(0).max(16).optional(), maxWidth: z.coerce.number().int().min(320).max(2560).optional() }).parse(req.query);
    return (await ctx.screen.call(s.deviceId, 'frame', { id: s.id, ...q })) ?? null;
  });

  app.post('/v1/admin/screen/:sid/input', { preHandler: auth }, async (req) => {
    const s = mine(req);
    const body = z.object({ events: z.array(z.any()).max(200) }).parse(req.body);
    const problem = remoteInputProblem(body.events);
    if (problem) throw badRequest(problem);
    return ctx.screen.call(s.deviceId, 'input', { id: s.id, events: body.events });
  });

  app.post('/v1/admin/screen/:sid/end', { preHandler: auth }, async (req) => {
    const s = mine(req);
    ctx.screen.sessions.delete(s.id);
    const r = await ctx.screen.call<{ endedAt: string | null }>(s.deviceId, 'end', { id: s.id }).catch(() => null);
    ctx.audit.record(actorOf(req), 'device.screen.ended', { type: 'device', id: s.deviceId, tenantId: s.tenantId }, { session: s.id, ticket: s.ticket, seconds: Math.round((Date.now() - Date.parse(s.startedAt)) / 1000) });
    return r ?? { ok: true };
  });
}
