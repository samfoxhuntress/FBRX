import type { FastifyReply, FastifyRequest } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import { safeEqual, sha256Hex } from '@fbrx/shared/node';
import type { AppContext } from './context';
import { ids } from './context';
import type { Actor } from './audit';
import { forbidden, unauthorized, badRequest } from './errors';
import { can, type Permission, type Role } from './rbac';

export interface Principal {
  kind: 'user' | 'apikey';
  id: string;
  label: string;
  role: Role;
  tenantId: string | null;
  sessionId?: string;
}

export interface DeviceRow {
  id: string;
  tenant_id: string;
  group_id: string | null;
  name: string;
  status: string;
  machine_id: string;
  [k: string]: unknown;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
    device?: DeviceRow;
  }
}

export async function issueSession(ctx: AppContext, user: { id: string; role: Role; tenant_id: string | null }, req: FastifyRequest) {
  const sid = ids.session();
  const now = new Date();
  const expires = new Date(now.getTime() + ctx.config.sessionHours * 3600_000);
  ctx.db.run(
    'INSERT INTO sessions (id, user_id, ip, user_agent, created_at, expires_at, last_seen_at) VALUES (?,?,?,?,?,?,?)',
    sid,
    user.id,
    req.ip,
    String(req.headers['user-agent'] ?? '').slice(0, 300),
    now.toISOString(),
    expires.toISOString(),
    now.toISOString(),
  );
  const token = await new SignJWT({ sid, role: user.role, tid: user.tenant_id })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setIssuer('fbrx-control-plane')
    .setExpirationTime(Math.floor(expires.getTime() / 1000))
    .sign(ctx.keys.jwt);
  return { token, expiresAt: expires.toISOString(), sessionId: sid };
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7).trim();
  const q = (req.query as Record<string, string> | undefined)?.access_token;
  return q ?? null;
}

/** Resolves a user session JWT or an API key into a principal. */
export async function resolvePrincipal(ctx: AppContext, token: string): Promise<Principal | null> {
  if (token.startsWith('fbrx_ak_')) {
    const row = ctx.db.get<any>('SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL', sha256Hex(token));
    if (!row) return null;
    if (row.expires_at && row.expires_at < new Date().toISOString()) return null;
    ctx.db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', new Date().toISOString(), row.id);
    return { kind: 'apikey', id: row.id, label: `apikey:${row.name}`, role: row.role, tenantId: row.tenant_id };
  }
  try {
    const { payload } = await jwtVerify(token, ctx.keys.jwt, { issuer: 'fbrx-control-plane', algorithms: ['HS256'] });
    const sid = String(payload.sid ?? '');
    const session = ctx.db.get<any>('SELECT * FROM sessions WHERE id = ? AND revoked_at IS NULL', sid);
    if (!session || session.expires_at < new Date().toISOString()) return null;
    const user = ctx.db.get<any>("SELECT * FROM users WHERE id = ? AND status = 'active'", String(payload.sub ?? ''));
    if (!user) return null;
    ctx.db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', new Date().toISOString(), sid);
    return { kind: 'user', id: user.id, label: user.email, role: user.role, tenantId: user.tenant_id, sessionId: sid };
  } catch {
    return null;
  }
}

export function adminAuth(ctx: AppContext) {
  return async (req: FastifyRequest) => {
    const token = bearer(req);
    if (!token) throw unauthorized();
    const p = await resolvePrincipal(ctx, token);
    if (!p) throw unauthorized('Session expired or invalid');
    req.principal = p;
  };
}

export function deviceAuth(ctx: AppContext) {
  return async (req: FastifyRequest) => {
    const token = bearer(req);
    if (!token || !token.startsWith('fbrx_dev_')) throw unauthorized('Device credential required');
    const d = ctx.db.get<DeviceRow>('SELECT * FROM devices WHERE token_hash = ?', sha256Hex(token));
    if (!d) throw unauthorized('Unknown device credential');
    if (d.status !== 'active') throw forbidden(`Device is ${d.status}`);
    req.device = d;
  };
}

export function requirePerm(req: FastifyRequest, perm: Permission): Principal {
  const p = req.principal;
  if (!p) throw unauthorized();
  if (!can(p.role, perm)) throw forbidden();
  return p;
}

/** Tenant a request acts on. Tenant users are pinned to their tenant; superadmins choose via header/query. */
export function tenantScope(req: FastifyRequest): string | null {
  const p = req.principal!;
  if (p.role !== 'superadmin') return p.tenantId;
  const h = req.headers['x-fbrx-tenant'];
  const q = (req.query as Record<string, string> | undefined)?.tenantId;
  return (typeof h === 'string' && h) || q || null;
}

export function requireTenant(req: FastifyRequest): string {
  const t = tenantScope(req);
  if (!t) throw badRequest('Select a tenant for this operation');
  return t;
}

/** Ensures a tenant-owned row is visible to the caller. */
export function assertTenantAccess(req: FastifyRequest, tenantId: string | null) {
  const p = req.principal!;
  if (p.role === 'superadmin') return;
  if (tenantId !== p.tenantId) throw forbidden();
}

export function actorOf(req: FastifyRequest): Actor {
  if (req.device) return { type: 'device', id: req.device.id, label: `device:${req.device.name}`, tenantId: req.device.tenant_id, ip: req.ip };
  const p = req.principal;
  if (!p) return { type: 'system', id: null, label: 'anonymous', tenantId: null, ip: req.ip };
  return { type: p.kind, id: p.id, label: p.label, tenantId: p.tenantId, ip: req.ip };
}

export function constantTimeCheck(a: string, b: string) {
  return safeEqual(a, b);
}

export type Reply = FastifyReply;
