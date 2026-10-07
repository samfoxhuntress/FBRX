import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { generateTotpSecret, hashPassword, openString, otpauthUrl, safeEqual, sealString, verifyPassword, verifyTotp } from '@fbrx/shared/node';
import { VERTICALS } from '@fbrx/shared';
import type { AppContext } from '../context';
import { ids } from '../context';
import { actorOf, adminAuth, issueSession } from '../auth';
import { badRequest, forbidden, unauthorized } from '../errors';
import { PERMISSIONS, can, type Permission } from '../rbac';
import { slugify } from './util';
import { passwordBlockedBySso } from './sso';

export const PasswordSchema = z.string().min(12, 'Passwords must be at least 12 characters').max(200);

export function userView(u: any) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    tenantId: u.tenant_id,
    status: u.status,
    mfaEnabled: !!u.mfa_enabled,
    /** Signs in with Google / Microsoft (has used single sign-on). */
    sso: !!u.sso_subject,
    /** Has a password (accounts made for single sign-on may not). */
    hasPassword: !!u.password_hash,
    lastLoginAt: u.last_login_at,
    createdAt: u.created_at,
  };
}

export async function authRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = adminAuth(ctx);

  app.get('/v1/setup/status', async () => ({
    needsSetup: Number(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0) === 0,
    version: ctx.version,
  }));

  app.post('/v1/setup', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const body = z
      .object({
        setupToken: z.string(),
        organization: z.string().min(1).max(120),
        /** What FBRX Command runs: Work, School or Home (the first tenant's kind). */
        kind: z.enum(VERTICALS).default('business'),
        name: z.string().min(1).max(120),
        email: z.string().email(),
        password: PasswordSchema,
      })
      .parse(req.body);
    if (Number(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')?.n ?? 0) > 0) throw forbidden('Setup has already been completed');
    if (!ctx.config.setupToken || !safeEqual(body.setupToken.trim(), ctx.config.setupToken)) {
      throw unauthorized('That is not the setup token. Use the one-time setup token the FBRX Command installer showed (after "Setup token"), or the one printed in the server log on first start.');
    }
    const now = new Date().toISOString();
    const tenantId = ids.tenant();
    const userId = ids.user();
    ctx.db.tx(() => {
      ctx.db.run('INSERT INTO tenants (id, name, slug, contact_email, vertical, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', tenantId, body.organization, slugify(body.organization), body.email, body.kind, now, now);
      ctx.db.run(
        'INSERT INTO users (id, tenant_id, email, name, password_hash, role, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
        userId,
        null,
        body.email,
        body.name,
        '',
        'superadmin',
        now,
        now,
      );
    });
    ctx.db.run('UPDATE users SET password_hash = ? WHERE id = ?', await hashPassword(body.password), userId);
    ctx.audit.record({ type: 'user', id: userId, label: body.email, tenantId: null, ip: req.ip }, 'setup.completed', { type: 'tenant', id: tenantId, tenantId }, { organization: body.organization, kind: body.kind });
    return { ok: true, tenantId };
  });

  app.post('/v1/auth/login', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const body = z.object({ email: z.string(), password: z.string(), totp: z.string().optional() }).parse(req.body);
    const u = ctx.db.get<any>('SELECT * FROM users WHERE email = ?', body.email.trim());
    const fail = (why: string) => {
      ctx.audit.record({ type: 'user', id: u?.id ?? null, label: body.email.slice(0, 200), tenantId: u?.tenant_id ?? null, ip: req.ip }, 'auth.login.failed', {}, { reason: why });
      return unauthorized('Invalid email, password or code');
    };
    if (!u || u.status !== 'active') throw fail('unknown or disabled user');
    if (u.locked_until && u.locked_until > new Date().toISOString()) throw unauthorized('Account temporarily locked after repeated failures. Try again later.');
    // Organizations can require Google / Microsoft sign-in; accounts made for it have no password at all.
    if (passwordBlockedBySso(ctx, u) || !u.password_hash) {
      ctx.audit.record({ type: 'user', id: u.id, label: u.email, tenantId: u.tenant_id, ip: req.ip }, 'auth.login.failed', {}, { reason: 'single sign-on required' });
      throw unauthorized('Your organization signs in with Google or Microsoft. Use the button below.');
    }
    if (!(await verifyPassword(body.password, u.password_hash))) {
      const fails = Number(u.failed_logins) + 1;
      ctx.db.run(
        'UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?',
        fails,
        fails >= 5 ? new Date(Date.now() + 15 * 60_000).toISOString() : null,
        u.id,
      );
      throw fail('bad password');
    }
    if (u.mfa_enabled) {
      if (!body.totp) return { mfaRequired: true };
      const secret = openString(ctx.keys.master, u.mfa_secret, `mfa:${u.id}`);
      if (!verifyTotp(secret, body.totp)) throw fail('bad mfa code');
    }
    ctx.db.run('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', new Date().toISOString(), u.id);
    const session = await issueSession(ctx, u, req);
    ctx.audit.record({ type: 'user', id: u.id, label: u.email, tenantId: u.tenant_id, ip: req.ip }, 'auth.login', { type: 'session', id: session.sessionId });
    return { token: session.token, expiresAt: session.expiresAt, user: userView(u) };
  });

  app.post('/v1/auth/logout', { preHandler: auth }, async (req) => {
    if (req.principal?.sessionId) ctx.db.run('UPDATE sessions SET revoked_at = ? WHERE id = ?', new Date().toISOString(), req.principal.sessionId);
    ctx.audit.record(actorOf(req), 'auth.logout');
    return { ok: true };
  });

  app.get('/v1/auth/me', { preHandler: auth }, async (req) => {
    const p = req.principal!;
    const permissions = (Object.keys(PERMISSIONS) as Permission[]).filter((perm) => can(p.role, perm));
    const tenants =
      p.role === 'superadmin'
        ? ctx.db.all<any>("SELECT id, name, slug, status, COALESCE(vertical, 'business') AS vertical FROM tenants ORDER BY name")
        : ctx.db.all<any>("SELECT id, name, slug, status, COALESCE(vertical, 'business') AS vertical FROM tenants WHERE id = ?", p.tenantId ?? '');
    const user = p.kind === 'user' ? userView(ctx.db.get<any>('SELECT * FROM users WHERE id = ?', p.id)) : { id: p.id, email: p.label, name: p.label, role: p.role, tenantId: p.tenantId, mfaEnabled: false };
    return { principal: { kind: p.kind, role: p.role, tenantId: p.tenantId }, user, tenants, permissions, version: ctx.version };
  });

  app.post('/v1/auth/password', { preHandler: auth }, async (req) => {
    const p = req.principal!;
    if (p.kind !== 'user') throw forbidden();
    const body = z.object({ current: z.string(), next: PasswordSchema }).parse(req.body);
    const u = ctx.db.get<any>('SELECT * FROM users WHERE id = ?', p.id);
    if (!(await verifyPassword(body.current, u.password_hash))) throw unauthorized('Current password is incorrect');
    ctx.db.run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', await hashPassword(body.next), new Date().toISOString(), p.id);
    ctx.db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL', new Date().toISOString(), p.id, p.sessionId ?? '');
    ctx.audit.record(actorOf(req), 'auth.password.changed', { type: 'user', id: p.id });
    return { ok: true };
  });

  app.post('/v1/auth/mfa/setup', { preHandler: auth }, async (req) => {
    const p = req.principal!;
    if (p.kind !== 'user') throw forbidden();
    const secret = generateTotpSecret();
    ctx.db.run('UPDATE users SET mfa_secret = ?, mfa_enabled = 0 WHERE id = ?', sealString(ctx.keys.master, secret, `mfa:${p.id}`), p.id);
    return { secret, otpauthUrl: otpauthUrl(secret, p.label) };
  });

  app.post('/v1/auth/mfa/enable', { preHandler: auth }, async (req) => {
    const p = req.principal!;
    const { code } = z.object({ code: z.string() }).parse(req.body);
    const u = ctx.db.get<any>('SELECT * FROM users WHERE id = ?', p.id);
    if (!u?.mfa_secret) throw badRequest('Start MFA setup first');
    if (!verifyTotp(openString(ctx.keys.master, u.mfa_secret, `mfa:${u.id}`), code)) throw badRequest('Code is not valid; check the time on your device');
    ctx.db.run('UPDATE users SET mfa_enabled = 1, updated_at = ? WHERE id = ?', new Date().toISOString(), p.id);
    ctx.audit.record(actorOf(req), 'auth.mfa.enabled', { type: 'user', id: p.id });
    return { ok: true };
  });

  app.post('/v1/auth/mfa/disable', { preHandler: auth }, async (req) => {
    const p = req.principal!;
    const { password } = z.object({ password: z.string() }).parse(req.body);
    const u = ctx.db.get<any>('SELECT * FROM users WHERE id = ?', p.id);
    if (!u || !(await verifyPassword(password, u.password_hash))) throw unauthorized('Password is incorrect');
    ctx.db.run('UPDATE users SET mfa_enabled = 0, mfa_secret = NULL, updated_at = ? WHERE id = ?', new Date().toISOString(), p.id);
    ctx.audit.record(actorOf(req), 'auth.mfa.disabled', { type: 'user', id: p.id });
    return { ok: true };
  });
}
