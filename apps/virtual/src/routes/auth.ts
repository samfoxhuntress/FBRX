import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { VIRTUAL_ROLES } from '@fbrx/shared';
import { safeEqual } from '@fbrx/shared/node';
import { MIN_PASSWORD } from '../auth';
import { audited, need, type VirtualContext } from '../context';
import { forbidden, unauthorized } from '../errors';
import { clearSetupCode } from '../setup-code';

const Password = z.string().min(MIN_PASSWORD, `Passwords need at least ${MIN_PASSWORD} characters`).max(200);
const Username = z.string().min(2).max(32);

export async function authRoutes(app: FastifyInstance, ctx: VirtualContext) {
  app.get('/v1/setup', async () => ({ needed: ctx.auth.userCount() === 0, version: ctx.version, driver: ctx.hv.kind, roles: ctx.config.roles }));

  app.post('/v1/setup', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const body = z.object({ setupToken: z.string(), username: Username, name: z.string().max(120).default(''), password: Password }).parse(req.body);
    if (ctx.auth.userCount() > 0) throw forbidden('This server is already set up');
    if (!ctx.config.setupToken || !safeEqual(body.setupToken, ctx.config.setupToken)) throw unauthorized('That setup code is not right (it is printed in the server log, and on the FBRX Server screen)');
    const user = await ctx.auth.createUser({ username: body.username, name: body.name, password: body.password, role: 'admin' });
    ctx.config.setupToken = null;
    clearSetupCode(ctx.config.dataDir);
    ctx.audit.record(user.username, 'setup.complete', user.username);
    return { ...ctx.auth.startSession(user.id, req.ip), user };
  });

  app.post('/v1/auth/login', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const body = z.object({ username: z.string().max(64), password: z.string().max(200) }).parse(req.body);
    try {
      const r = await ctx.auth.login(body.username, body.password, req.ip);
      ctx.audit.record(r.user.username, 'auth.login', null, 'success', { ip: req.ip });
      return r;
    } catch (e) {
      ctx.audit.record(body.username, 'auth.login', null, 'failure', { ip: req.ip });
      throw e;
    }
  });

  app.post('/v1/auth/logout', async (req) => {
    if (req.token) ctx.auth.logout(req.token);
    return { ok: true };
  });

  app.get('/v1/auth/me', async (req) => {
    const user = need(req, 'viewer');
    return { user, version: ctx.version, driver: ctx.hv.kind, roles: ctx.config.roles };
  });

  app.post('/v1/auth/password', async (req) => {
    const user = need(req, 'viewer');
    const body = z.object({ current: z.string(), next: Password }).parse(req.body);
    await audited(ctx, req, 'auth.password', user.username, () => ctx.auth.changeOwnPassword(user.id, body.current, body.next, req.token!));
    return { ok: true };
  });

  // ------------------------------------------------------------------------------------- users

  app.get('/v1/users', async (req) => {
    need(req, 'admin');
    return { users: ctx.auth.listUsers() };
  });

  app.post('/v1/users', async (req) => {
    need(req, 'admin');
    const body = z.object({ username: Username, name: z.string().max(120).default(''), password: Password, role: z.enum(VIRTUAL_ROLES as [string, ...string[]]) }).parse(req.body);
    return audited(ctx, req, 'user.create', body.username, () => ctx.auth.createUser(body as never), { role: body.role });
  });

  app.patch('/v1/users/:id', async (req) => {
    need(req, 'admin');
    const { id } = req.params as { id: string };
    const body = z.object({ name: z.string().max(120).optional(), role: z.enum(VIRTUAL_ROLES as [string, ...string[]]).optional(), password: Password.optional() }).parse(req.body);
    const target = ctx.auth.getUser(id);
    return audited(ctx, req, 'user.update', target.username, () => ctx.auth.updateUser(id, body as never), { role: body.role, password: body.password ? 'changed' : undefined });
  });

  app.delete('/v1/users/:id', async (req) => {
    const me = need(req, 'admin');
    const { id } = req.params as { id: string };
    const target = ctx.auth.getUser(id);
    if (target.id === me.id) throw forbidden('You cannot delete yourself');
    await audited(ctx, req, 'user.delete', target.username, () => ctx.auth.deleteUser(id));
    return { ok: true };
  });

  app.get('/v1/audit', async (req) => {
    need(req, 'admin');
    const q = z.object({ limit: z.coerce.number().int().min(1).max(1000).default(200), before: z.coerce.number().int().optional() }).parse(req.query);
    return { entries: ctx.audit.list(q.limit, q.before) };
  });
}
