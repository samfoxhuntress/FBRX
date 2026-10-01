import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { UPDATE_CHANNELS, compareSemver } from '@fbrx/shared';
import { hashPassword, randomToken, sha256Hex } from '@fbrx/shared/node';
import type { AppContext } from '../context';
import { ids } from '../context';
import { actorOf, adminAuth, assertTenantAccess, requirePerm, requireTenant, tenantScope } from '../auth';
import { badRequest, conflict, forbidden, notFound } from '../errors';
import { ROLES, TENANT_ROLES, assignableRoles, type Role } from '../rbac';
import { PasswordSchema, userView } from './auth';
import { deviceView } from '../services/devices';
import { slugify } from './util';

export async function adminOrgRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', adminAuth(ctx));

  // ---------------------------------------------------------------------------------- overview
  app.get('/v1/admin/overview', async (req) => {
    requirePerm(req, 'devices.read');
    const tenant = tenantScope(req);
    const where = tenant ? 'WHERE tenant_id = ?' : '';
    const args = tenant ? [tenant] : [];
    const devices = ctx.db.all<any>(`SELECT * FROM devices ${where}`, ...args).map((d) => deviceView(ctx, d));
    const active = devices.filter((d) => d.status === 'active');
    const count = <T extends string>(arr: T[]) => arr.reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
    const latest = ctx.db
      .all<{ version: string }>("SELECT version FROM releases WHERE published = 1 AND channel = 'stable'")
      .map((r) => r.version)
      .sort((a, b) => compareSemver(b, a))[0];
    const since = new Date(Date.now() - 86400_000).toISOString();
    const commands = ctx.db.all<{ status: string; n: number }>(
      `SELECT status, COUNT(*) AS n FROM commands WHERE created_at >= ? ${tenant ? 'AND tenant_id = ?' : ''} GROUP BY status`,
      since,
      ...args,
    );
    const events = ctx.db
      .all<any>(`SELECT e.*, d.name AS device_name FROM device_events e JOIN devices d ON d.id = e.device_id ${tenant ? 'WHERE e.tenant_id = ?' : ''} ORDER BY e.ts DESC LIMIT 15`, ...args)
      .map((e) => ({ id: e.id, deviceId: e.device_id, deviceName: e.device_name, ts: e.ts, kind: e.kind, severity: e.severity, message: e.message }));
    const lic = tenant
      ? ctx.db.get<any>('SELECT edition, seats, expires_at FROM licenses WHERE tenant_id = ? AND revoked_at IS NULL ORDER BY issued_at DESC LIMIT 1', tenant)
      : null;
    return {
      devices: {
        total: active.length,
        online: active.filter((d) => d.online).length,
        offline: active.filter((d) => !d.online).length,
        retired: devices.filter((d) => d.status === 'retired').length,
        disabled: devices.filter((d) => d.status === 'disabled').length,
        critical: active.filter((d) => d.health?.state === 'critical').length,
        warning: active.filter((d) => d.health?.state === 'warning').length,
        outdated: latest ? active.filter((d) => compareSemver(d.appVersion, latest) < 0).length : 0,
      },
      latestStableVersion: latest ?? null,
      versions: count(active.map((d) => d.appVersion)),
      platforms: count(active.map((d) => d.platform)),
      agent: {
        runs24h: active.reduce((n, d) => n + (d.health?.agentRuns24h ?? 0), 0),
        toolCalls24h: active.reduce((n, d) => n + (d.health?.toolCalls24h ?? 0), 0),
        denials24h: active.reduce((n, d) => n + (d.health?.policyDenials24h ?? 0), 0),
        errors24h: active.reduce((n, d) => n + (d.health?.errors24h ?? 0), 0),
        pendingApprovals: active.reduce((n, d) => n + (d.health?.pendingApprovals ?? 0), 0),
      },
      commands24h: Object.fromEntries(commands.map((c) => [c.status, Number(c.n)])),
      recentEvents: events,
      license: lic ? { edition: lic.edition, seats: Number(lic.seats), used: active.length, expiresAt: lic.expires_at } : null,
      tenants: tenant ? undefined : Number(ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM tenants')?.n ?? 0),
    };
  });

  // ----------------------------------------------------------------------------------- tenants
  const TenantInput = z.object({
    name: z.string().min(1).max(120),
    contactEmail: z.string().email().optional().nullable(),
    notes: z.string().max(5000).optional(),
    status: z.enum(['active', 'suspended']).optional(),
    updateChannel: z.enum(UPDATE_CHANNELS).optional(),
    defaultProfileId: z.string().nullable().optional(),
  });
  const tenantView = (t: any) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    status: t.status,
    contactEmail: t.contact_email,
    notes: t.notes,
    updateChannel: t.update_channel,
    defaultProfileId: t.default_profile_id,
    configVersion: Number(t.config_version),
    createdAt: t.created_at,
    deviceCount: Number(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM devices WHERE tenant_id = ? AND status = 'active'", t.id)?.n ?? 0),
    onlineCount: ctx.realtime.onlineCount(t.id),
  });

  app.get('/v1/admin/tenants', async (req) => {
    const p = req.principal!;
    const rows = p.role === 'superadmin' ? ctx.db.all<any>('SELECT * FROM tenants ORDER BY name') : ctx.db.all<any>('SELECT * FROM tenants WHERE id = ?', p.tenantId ?? '');
    return rows.map(tenantView);
  });

  app.post('/v1/admin/tenants', async (req) => {
    requirePerm(req, 'tenants.manage');
    const body = TenantInput.parse(req.body);
    const id = ids.tenant();
    const now = new Date().toISOString();
    let slug = slugify(body.name);
    if (ctx.db.get('SELECT 1 FROM tenants WHERE slug = ?', slug)) slug = `${slug}-${id.slice(-4)}`;
    ctx.db.run(
      'INSERT INTO tenants (id, name, slug, contact_email, notes, update_channel, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      id,
      body.name,
      slug,
      body.contactEmail ?? null,
      body.notes ?? '',
      body.updateChannel ?? 'stable',
      now,
      now,
    );
    ctx.audit.record(actorOf(req), 'tenant.created', { type: 'tenant', id, tenantId: id }, { name: body.name });
    return tenantView(ctx.db.get('SELECT * FROM tenants WHERE id = ?', id));
  });

  app.patch('/v1/admin/tenants/:id', async (req) => {
    const { id } = req.params as { id: string };
    const p = req.principal!;
    if (p.role !== 'superadmin') {
      requirePerm(req, 'config.manage');
      assertTenantAccess(req, id);
    }
    const body = TenantInput.partial().parse(req.body);
    if (body.status && p.role !== 'superadmin') throw forbidden('Only the platform operator can suspend tenants');
    const t = ctx.db.get<any>('SELECT * FROM tenants WHERE id = ?', id);
    if (!t) throw notFound();
    if (body.defaultProfileId && !ctx.db.get('SELECT 1 FROM profiles WHERE id = ? AND tenant_id = ?', body.defaultProfileId, id)) throw badRequest('Unknown profile');
    ctx.db.run(
      'UPDATE tenants SET name = ?, contact_email = ?, notes = ?, status = ?, update_channel = ?, default_profile_id = ?, updated_at = ? WHERE id = ?',
      body.name ?? t.name,
      body.contactEmail !== undefined ? body.contactEmail : t.contact_email,
      body.notes ?? t.notes,
      body.status ?? t.status,
      body.updateChannel ?? t.update_channel,
      body.defaultProfileId !== undefined ? body.defaultProfileId : t.default_profile_id,
      new Date().toISOString(),
      id,
    );
    if (body.defaultProfileId !== undefined || body.updateChannel) ctx.bumpConfig(id);
    if (body.status === 'suspended') for (const d of ctx.db.all<{ id: string }>('SELECT id FROM devices WHERE tenant_id = ?', id)) ctx.realtime.disconnectDevice(d.id, 'tenant suspended');
    ctx.audit.record(actorOf(req), 'tenant.updated', { type: 'tenant', id, tenantId: id }, body);
    return tenantView(ctx.db.get('SELECT * FROM tenants WHERE id = ?', id));
  });

  // ------------------------------------------------------------------------------------- users
  app.get('/v1/admin/users', async (req) => {
    requirePerm(req, 'users.manage');
    const p = req.principal!;
    const tenant = tenantScope(req);
    const rows =
      p.role === 'superadmin' && !tenant
        ? ctx.db.all<any>('SELECT * FROM users ORDER BY email')
        : ctx.db.all<any>('SELECT * FROM users WHERE tenant_id = ? ORDER BY email', tenant ?? '');
    return rows.map(userView);
  });

  app.post('/v1/admin/users', async (req) => {
    const p = requirePerm(req, 'users.manage');
    const body = z.object({ email: z.string().email(), name: z.string().min(1).max(120), role: z.enum(ROLES), password: PasswordSchema }).parse(req.body);
    if (!assignableRoles(p.role).includes(body.role)) throw forbidden(`You cannot assign the ${body.role} role`);
    const tenantId = body.role === 'superadmin' ? null : requireTenant(req);
    if (ctx.db.get('SELECT 1 FROM users WHERE email = ?', body.email)) throw conflict('A user with that email already exists');
    const id = ids.user();
    const now = new Date().toISOString();
    ctx.db.run(
      'INSERT INTO users (id, tenant_id, email, name, password_hash, role, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
      id,
      tenantId,
      body.email,
      body.name,
      await hashPassword(body.password),
      body.role,
      now,
      now,
    );
    ctx.audit.record(actorOf(req), 'user.created', { type: 'user', id, tenantId }, { email: body.email, role: body.role });
    return userView(ctx.db.get('SELECT * FROM users WHERE id = ?', id));
  });

  app.patch('/v1/admin/users/:id', async (req) => {
    const p = requirePerm(req, 'users.manage');
    const { id } = req.params as { id: string };
    const u = ctx.db.get<any>('SELECT * FROM users WHERE id = ?', id);
    if (!u) throw notFound();
    if (p.role !== 'superadmin') assertTenantAccess(req, u.tenant_id);
    const body = z.object({ name: z.string().min(1).max(120).optional(), role: z.enum(ROLES).optional(), status: z.enum(['active', 'disabled']).optional(), password: PasswordSchema.optional(), resetMfa: z.boolean().optional() }).parse(req.body);
    if (!assignableRoles(p.role).includes(u.role as Role)) throw forbidden('You cannot modify this user');
    if (body.role && !assignableRoles(p.role).includes(body.role)) throw forbidden(`You cannot assign the ${body.role} role`);
    if (body.role && (body.role === 'superadmin') !== (u.role === 'superadmin')) throw badRequest('Platform and tenant roles cannot be swapped');
    if (id === p.id && (body.status === 'disabled' || (body.role && body.role !== u.role))) throw badRequest('You cannot demote or disable yourself');
    ctx.db.run(
      'UPDATE users SET name = ?, role = ?, status = ?, password_hash = ?, mfa_enabled = ?, mfa_secret = ?, updated_at = ? WHERE id = ?',
      body.name ?? u.name,
      body.role ?? u.role,
      body.status ?? u.status,
      body.password ? await hashPassword(body.password) : u.password_hash,
      body.resetMfa ? 0 : u.mfa_enabled,
      body.resetMfa ? null : u.mfa_secret,
      new Date().toISOString(),
      id,
    );
    if (body.status === 'disabled' || body.password) ctx.db.run('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', new Date().toISOString(), id);
    ctx.audit.record(actorOf(req), 'user.updated', { type: 'user', id, tenantId: u.tenant_id }, { ...body, password: body.password ? '[changed]' : undefined });
    return userView(ctx.db.get('SELECT * FROM users WHERE id = ?', id));
  });

  // ----------------------------------------------------------------------------------- API keys
  app.get('/v1/admin/api-keys', async (req) => {
    requirePerm(req, 'apikeys.manage');
    const tenant = tenantScope(req);
    const rows = tenant ? ctx.db.all<any>('SELECT * FROM api_keys WHERE tenant_id = ? ORDER BY created_at DESC', tenant) : ctx.db.all<any>('SELECT * FROM api_keys WHERE tenant_id IS NULL ORDER BY created_at DESC');
    return rows.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, role: k.role, tenantId: k.tenant_id, createdAt: k.created_at, lastUsedAt: k.last_used_at, expiresAt: k.expires_at, revokedAt: k.revoked_at }));
  });

  app.post('/v1/admin/api-keys', async (req) => {
    const p = requirePerm(req, 'apikeys.manage');
    const body = z.object({ name: z.string().min(1).max(120), role: z.enum(ROLES), expiresInDays: z.number().int().min(1).max(3650).optional() }).parse(req.body);
    if (!assignableRoles(p.role).includes(body.role)) throw forbidden(`You cannot create a ${body.role} key`);
    const tenantId = body.role === 'superadmin' ? null : requireTenant(req);
    if (body.role !== 'superadmin' && !TENANT_ROLES.includes(body.role)) throw badRequest('Invalid role');
    const key = randomToken('fbrx_ak');
    const id = ids.apiKey();
    ctx.db.run(
      'INSERT INTO api_keys (id, tenant_id, name, prefix, key_hash, role, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?)',
      id,
      tenantId,
      body.name,
      key.slice(0, 14),
      sha256Hex(key),
      body.role,
      p.id,
      new Date().toISOString(),
      body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86400_000).toISOString() : null,
    );
    ctx.audit.record(actorOf(req), 'apikey.created', { type: 'apikey', id, tenantId }, { name: body.name, role: body.role });
    return { id, key, name: body.name, role: body.role };
  });

  app.delete('/v1/admin/api-keys/:id', async (req) => {
    requirePerm(req, 'apikeys.manage');
    const { id } = req.params as { id: string };
    const k = ctx.db.get<any>('SELECT * FROM api_keys WHERE id = ?', id);
    if (!k) throw notFound();
    if (req.principal!.role !== 'superadmin') assertTenantAccess(req, k.tenant_id);
    ctx.db.run('UPDATE api_keys SET revoked_at = ? WHERE id = ?', new Date().toISOString(), id);
    ctx.audit.record(actorOf(req), 'apikey.revoked', { type: 'apikey', id, tenantId: k.tenant_id });
    return { ok: true };
  });
}
