import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DirectoryStatus } from '@fbrx/shared';
import { audited, bearer, need, type VirtualContext } from '../context';
import { conflict } from '../errors';

const computers = z.union([z.literal('all'), z.array(z.string().max(64)).max(2000)]);
const userBody = z.object({
  username: z.string().max(40),
  fullName: z.string().max(200).optional(),
  enabled: z.boolean().optional(),
  groups: z.array(z.string().max(40)).max(100).optional(),
  computers: computers.optional(),
  password: z.string().max(200).optional(),
});
const rules = z.object({
  minLength: z.number().int(),
  complex: z.boolean(),
  maxAgeDays: z.number().int(),
  lockoutAttempts: z.number().int(),
  lockoutMinutes: z.number().int(),
});

/**
 * The FBRX directory (the directory role). Administrators change it; viewers look. Computers join with a join code
 * (no sign-in) and then use their own token for what they should have and how applying it went. First passwords
 * only ever leave the server to a computer, and never come back out to the console.
 */
export async function directoryRoutes(app: FastifyInstance, ctx: VirtualContext) {
  const dir = () => {
    if (!ctx.directory) throw conflict('The FBRX directory is not on this server: add the directory role (Roles in this console, or sudo fbrx-server roles add directory)');
    return ctx.directory;
  };
  /** A computer's own request: its token, never a person's session. */
  const device = (req: FastifyRequest) => bearer(req);

  app.get('/v1/directory', async (req): Promise<DirectoryStatus | { enabled: false }> => {
    need(req, 'viewer');
    if (!ctx.directory) return { enabled: false };
    return { ...dir().status(), certificate: ctx.tls?.fingerprint ?? null };
  });

  app.put('/v1/directory/settings', async (req) => {
    need(req, 'admin');
    const body = z.object({ name: z.string().max(200).optional(), rules: rules.partial().optional() }).parse(req.body);
    return audited(ctx, req, 'directory.settings', body.name ?? null, () => ({ ...dir().setup(body), certificate: ctx.tls?.fingerprint ?? null }), { rules: body.rules ?? null });
  });

  app.post('/v1/directory/users', async (req) => {
    need(req, 'admin');
    const body = userBody.parse(req.body);
    return audited(ctx, req, 'directory.user.create', body.username, () => ({ user: dir().addUser(body) }), { groups: body.groups ?? [], computers: body.computers ?? 'all' });
  });

  app.put<{ Params: { username: string } }>('/v1/directory/users/:username', async (req) => {
    need(req, 'admin');
    const body = userBody.omit({ username: true }).parse(req.body);
    const { password, ...shown } = body;
    return audited(ctx, req, 'directory.user.update', req.params.username, () => ({ user: dir().updateUser(req.params.username, body) }), { ...shown, newPassword: password !== undefined });
  });

  app.delete<{ Params: { username: string } }>('/v1/directory/users/:username', async (req) => {
    need(req, 'admin');
    return audited(ctx, req, 'directory.user.delete', req.params.username, () => (dir().removeUser(req.params.username), { ok: true }));
  });

  app.post('/v1/directory/groups', async (req) => {
    need(req, 'admin');
    const body = z.object({ name: z.string().max(40), description: z.string().max(200).optional() }).parse(req.body);
    return audited(ctx, req, 'directory.group.create', body.name, () => ({ group: dir().addGroup(body) }));
  });

  app.put<{ Params: { name: string } }>('/v1/directory/groups/:name', async (req) => {
    need(req, 'admin');
    const body = z.object({ description: z.string().max(200) }).parse(req.body);
    return audited(ctx, req, 'directory.group.update', req.params.name, () => ({ group: dir().updateGroup(req.params.name, body) }));
  });

  app.delete<{ Params: { name: string } }>('/v1/directory/groups/:name', async (req) => {
    need(req, 'admin');
    return audited(ctx, req, 'directory.group.delete', req.params.name, () => (dir().removeGroup(req.params.name), { ok: true }));
  });

  app.post('/v1/directory/codes', async (req) => {
    need(req, 'admin');
    const body = z.object({ label: z.string().max(200).optional(), days: z.number().int().min(1).max(90).optional(), uses: z.number().int().min(1).max(500).optional() }).parse(req.body);
    return audited(ctx, req, 'directory.code.create', body.label ?? null, () => dir().addCode(body), { days: body.days ?? 7, uses: body.uses ?? 1 });
  });

  app.delete<{ Params: { id: string } }>('/v1/directory/codes/:id', async (req) => {
    need(req, 'admin');
    return audited(ctx, req, 'directory.code.delete', req.params.id, () => (dir().removeCode(req.params.id), { ok: true }));
  });

  app.delete<{ Params: { id: string } }>('/v1/directory/computers/:id', async (req) => {
    need(req, 'admin');
    return audited(ctx, req, 'directory.computer.remove', req.params.id, () => ({ computer: dir().removeComputer(req.params.id) }));
  });

  // Computers: joining is the only thing open without a token, and it is slowed down.
  app.post('/v1/directory/join', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const body = z.object({ code: z.string().min(4).max(40), name: z.string().max(200), os: z.enum(['windows', 'mac', 'linux']) }).parse(req.body);
    try {
      const out = dir().join(body);
      ctx.audit.record(`computer:${body.name.slice(0, 64)}`, 'directory.join', out.computerId, 'success', { os: body.os });
      return out;
    } catch (e) {
      ctx.audit.record(`computer:${body.name.slice(0, 64)}`, 'directory.join', null, 'failure', { error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  });

  app.get('/v1/directory/policy', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
    reply.header('cache-control', 'no-store');
    return dir().policy(device(req));
  });

  app.post('/v1/directory/report', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const body = z
      .object({
        version: z.number().int().min(0),
        ok: z.boolean(),
        problems: z.array(z.string().max(1000)).max(200),
        passwords: z.record(z.string().max(40), z.number().int()).refine((r) => Object.keys(r).length <= 1000, 'Too many accounts'),
      })
      .parse(req.body);
    const token = device(req);
    dir().report(token, body);
    ctx.audit.record(`computer:${dir().computerName(token)}`, 'directory.applied', String(body.version), body.ok ? 'success' : 'failure', body.problems.length ? { problems: body.problems.slice(0, 10) } : null);
    return { ok: true };
  });

  app.post('/v1/directory/leave', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const name = dir().leave(device(req));
    ctx.audit.record(`computer:${name}`, 'directory.leave', null);
    return { ok: true };
  });
}
