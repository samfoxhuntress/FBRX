import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { remoteInputProblem } from '@fbrx/shared';
import type { AppContext } from '../context';
import type { RecordingRow } from '../services/screen-recorder';
import { actorOf, adminAuth, assertTenantAccess, requirePerm, tenantScope } from '../auth';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../errors';

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
    for (const [k, v] of ctx.screen.sessions)
      if (Date.now() - Date.parse(v.startedAt) > 12 * 3600_000) {
        ctx.screen.sessions.delete(k);
        ctx.recorder.end(k);
      }
    const body = z.object({ mode: z.enum(['view', 'control']), ticket: z.string().trim().min(1).max(40), reason: z.string().trim().max(300).default('') }).parse(req.body);
    if (/[\u0000-\u001f\u007f]/.test(body.ticket + body.reason)) throw badRequest('No control characters in the ticket or the reason');
    const d = ctx.db.get<{ id: string; name: string; tenant_id: string; status: string }>('SELECT id, name, tenant_id, status FROM devices WHERE id = ?', id);
    if (!d) throw notFound('No such computer');
    assertTenantAccess(req, d.tenant_id);
    if (d.status !== 'active') throw conflict(`This computer is ${d.status}`);
    // The organization keeps recordings: the computer tells its person so in the question and on the red bar.
    const recorded = ctx.recorder.on(d.tenant_id);
    const session = await ctx.screen.call<{ id: string; mode: 'view' | 'control'; state: string }>(d.id, 'start', { admin: name, ticket: body.ticket, reason: body.reason, mode: body.mode, recorded });
    if (typeof session?.id !== 'string' || ctx.screen.sessions.has(session.id)) throw conflict('The computer did not start a session');
    ctx.screen.sessions.set(session.id, { id: session.id, deviceId: d.id, tenantId: d.tenant_id, adminId: p.id, admin: name, ticket: body.ticket, reason: body.reason, mode: body.mode, startedAt: new Date().toISOString() });
    let recording: string | null = null;
    if (recorded) {
      try {
        recording = ctx.recorder.start({ sessionId: session.id, tenantId: d.tenant_id, deviceId: d.id, deviceName: d.name, adminId: p.id, admin: name, ticket: body.ticket, reason: body.reason, mode: body.mode });
      } catch (err) {
        // The organization records every session: without a recording there is no session.
        ctx.log.error({ err }, 'Could not start a screen recording');
        ctx.screen.sessions.delete(session.id);
        await ctx.screen.call(d.id, 'end', { id: session.id }).catch(() => null);
        throw new HttpError(503, 'FBRX Command could not start the recording this organization keeps, so the session was not started', 'UNAVAILABLE');
      }
    }
    ctx.audit.record(actorOf(req), 'device.screen.requested', { type: 'device', id: d.id, tenantId: d.tenant_id }, { session: session.id, mode: body.mode, ticket: body.ticket, reason: body.reason, recording });
    return { ...session, recorded };
  });

  app.get('/v1/admin/screen/:sid', { preHandler: auth }, async (req) => {
    const s = mine(req);
    const r = await ctx.screen.call<{ state: string; mode: string }>(s.deviceId, 'session', { id: s.id });
    if (r.state === 'ended' || r.state === 'denied') {
      ctx.screen.sessions.delete(s.id);
      ctx.recorder.end(s.id);
    }
    return { ...r, recorded: ctx.recorder.recording(s.id) };
  });

  app.get('/v1/admin/screen/:sid/frame', { preHandler: auth }, async (req) => {
    const s = mine(req);
    const q = z.object({ after: z.coerce.number().int().optional(), display: z.coerce.number().int().min(0).max(16).optional(), maxWidth: z.coerce.number().int().min(320).max(2560).optional() }).parse(req.query);
    const f = (await ctx.screen.call<{ seq?: number; width?: number; height?: number; jpeg?: string } | null>(s.deviceId, 'frame', { id: s.id, ...q })) ?? null;
    ctx.recorder.frame(s.id, f);
    return f;
  });

  app.post('/v1/admin/screen/:sid/input', { preHandler: auth }, async (req) => {
    const s = mine(req);
    const body = z.object({ events: z.array(z.any()).max(200) }).parse(req.body);
    const problem = remoteInputProblem(body.events);
    if (problem) throw badRequest(problem);
    const r = await ctx.screen.call(s.deviceId, 'input', { id: s.id, events: body.events });
    ctx.recorder.input(s.id);
    return r;
  });

  app.post('/v1/admin/screen/:sid/end', { preHandler: auth }, async (req) => {
    const s = mine(req);
    ctx.screen.sessions.delete(s.id);
    ctx.recorder.end(s.id);
    const r = await ctx.screen.call<{ endedAt: string | null }>(s.deviceId, 'end', { id: s.id }).catch(() => null);
    ctx.audit.record(actorOf(req), 'device.screen.ended', { type: 'device', id: s.deviceId, tenantId: s.tenantId }, { session: s.id, ticket: s.ticket, seconds: Math.round((Date.now() - Date.parse(s.startedAt)) / 1000) });
    return r ?? { ok: true };
  });

  // ------------------------------------------------------------------------------------- recordings
  // Owners and administrators (who read the audit log) watch them; operators who run sessions do not. Watching one
  // and deleting one are both in the audit log.

  const recordingOf = (req: FastifyRequest) => {
    requirePerm(req, 'audit.read');
    const { rid } = req.params as { rid: string };
    if (!/^rec_[0-9a-f-]{36}$/.test(rid)) throw notFound('No such recording');
    const r = ctx.db.get<RecordingRow>('SELECT * FROM screen_recordings WHERE id = ?', rid);
    if (!r) throw notFound('No such recording');
    assertTenantAccess(req, r.tenant_id);
    return r;
  };
  const view = (r: RecordingRow) => ({
    id: r.id,
    deviceId: r.device_id,
    device: r.device_name,
    admin: r.admin,
    ticket: r.ticket,
    reason: r.reason,
    mode: r.mode,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    frames: r.frames,
    bytes: r.bytes,
    inputUsed: r.input_used === 1,
    cut: r.cut,
  });

  app.get('/v1/admin/screen-recordings', { preHandler: auth }, async (req) => {
    requirePerm(req, 'audit.read');
    const tenant = tenantScope(req);
    if (!tenant) throw badRequest('Select an organization');
    const q = z.object({ deviceId: z.string().max(80).optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query);
    const rows = q.deviceId
      ? ctx.db.all<RecordingRow>('SELECT * FROM screen_recordings WHERE tenant_id = ? AND device_id = ? AND ended_at IS NOT NULL ORDER BY started_at DESC LIMIT ?', tenant, q.deviceId, q.limit)
      : ctx.db.all<RecordingRow>('SELECT * FROM screen_recordings WHERE tenant_id = ? AND ended_at IS NOT NULL ORDER BY started_at DESC LIMIT ?', tenant, q.limit);
    const t = ctx.db.get<{ screen_recording: number; screen_recording_days: number }>('SELECT screen_recording, screen_recording_days FROM tenants WHERE id = ?', tenant);
    return { on: Number(t?.screen_recording ?? 0) === 1, days: Number(t?.screen_recording_days ?? 30), recordings: rows.map(view) };
  });

  app.get('/v1/admin/screen-recordings/:rid', { preHandler: auth }, async (req) => {
    const r = recordingOf(req);
    if (!r.ended_at) throw conflict('That session is still going');
    const marks = ctx.recorder.marks(r.id);
    ctx.audit.record(actorOf(req), 'device.screen.recording.viewed', { type: 'device', id: r.device_id, tenantId: r.tenant_id }, { recording: r.id, ticket: r.ticket });
    return {
      ...view(r),
      // The player's timeline: each picture by its number, and the moments the mouse or keyboard was used.
      frames: marks.filter((m) => m.kind === 'frame').map((m) => ({ t: m.t, width: m.width, height: m.height })),
      inputs: marks.filter((m) => m.kind === 'input').map((m) => m.t),
    };
  });

  app.get('/v1/admin/screen-recordings/:rid/frames/:n', { preHandler: auth }, async (req, reply) => {
    const r = recordingOf(req);
    const n = Number((req.params as { n: string }).n);
    const frames = ctx.recorder.marks(r.id).filter((m) => m.kind === 'frame');
    if (!Number.isInteger(n) || n < 0 || n >= frames.length) throw notFound('No such picture');
    reply.header('content-type', 'image/jpeg').header('cache-control', 'private, max-age=3600').header('x-content-type-options', 'nosniff');
    return reply.send(ctx.recorder.picture(r.id, frames[n]));
  });

  app.delete('/v1/admin/screen-recordings/:rid', { preHandler: auth }, async (req) => {
    const r = recordingOf(req);
    requirePerm(req, 'config.manage');
    if (!r.ended_at) throw conflict('That session is still going');
    ctx.recorder.remove(r.id);
    ctx.audit.record(actorOf(req), 'device.screen.recording.deleted', { type: 'device', id: r.device_id, tenantId: r.tenant_id }, { recording: r.id, ticket: r.ticket, startedAt: r.started_at });
    return { ok: true };
  });
}
