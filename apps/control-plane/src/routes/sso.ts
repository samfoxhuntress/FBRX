import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { z } from 'zod';
import { openString, sealString } from '@fbrx/shared/node';
import type { AppContext } from '../context';
import { ids } from '../context';
import { actorOf, adminAuth, assertTenantAccess, issueSession, requirePerm, requireTenant } from '../auth';
import { badRequest, notFound } from '../errors';
import { userView } from './auth';
import { parseJson } from './util';

/**
 * Sign in to FBRX Command with Google Workspace or Microsoft 365 (OpenID Connect).
 *
 * Each organization (tenant) adds a connection with its own OAuth app: the provider, the client id and secret, and
 * the email domains it vouches for. Staff then use "Sign in with Google / Microsoft" on the sign-in page:
 *
 *   console ─► POST /v1/auth/sso/start ─► provider sign-in ─► GET /v1/auth/sso/callback
 *           ◄─ /?sso=<one-time code> ◄─ (code exchanged, ID token verified)  ─► POST /v1/auth/sso/exchange ─► session
 *
 * Authorization code flow with PKCE, state and nonce; the ID token is verified against the provider's published keys
 * (issuer, audience, expiry, nonce). A connection only ever signs people into its own organization: someone already
 * in another organization, or the platform administrator, is never matched. Users are invited first (by email) unless
 * the connection creates accounts on first sign-in with a default role.
 */

export const SSO_PROVIDERS = ['google', 'microsoft', 'oidc'] as const;
export type SsoProvider = (typeof SSO_PROVIDERS)[number];
const SSO_ROLES = ['admin', 'operator', 'viewer'] as const;

export const GOOGLE_ISSUER = 'https://accounts.google.com';
export const microsoftIssuer = (directory: string) => `https://login.microsoftonline.com/${encodeURIComponent(directory)}/v2.0`;

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

interface Connection {
  id: string;
  tenant_id: string;
  provider: SsoProvider;
  name: string;
  issuer: string;
  client_id: string;
  client_secret_enc: string;
  domains: string;
  auto_provision: number;
  default_role: string;
  require_sso: number;
  enabled: number;
}

/**
 * Who the provider says signed in, or why they may not. Pure, so the rules are easy to test:
 * Google must have verified the address, and a Workspace address must come from that Workspace (`hd`); Microsoft
 * may only give `preferred_username` (the sign-in name). The address must be in one of the connection's domains.
 */
export function ssoIdentity(provider: SsoProvider, claims: JWTPayload & Record<string, unknown>, domains: string[]): { email: string; name: string } | { error: string } {
  const raw = typeof claims.email === 'string' ? claims.email : provider === 'microsoft' && typeof claims.preferred_username === 'string' ? claims.preferred_username : '';
  const email = raw.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: 'The provider did not share an email address' };
  if (claims.email_verified === false || (provider === 'google' && claims.email_verified !== true)) return { error: 'The provider has not verified this email address' };
  const domain = email.split('@')[1];
  if (domains.length && !domains.includes(domain)) return { error: `${domain} is not one of this organization's sign-in domains` };
  if (provider === 'google' && domain !== 'gmail.com' && claims.hd !== domain) return { error: 'Sign in with the Google Workspace account for this domain' };
  const name = typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim().slice(0, 120) : email.split('@')[0];
  return { email, name };
}

const b64u = (b: Buffer) => b.toString('base64url');

export async function ssoRoutes(app: FastifyInstance, ctx: AppContext) {
  const auth = adminAuth(ctx);
  const callbackUrl = () => `${ctx.config.publicUrl}/v1/auth/sso/callback`;

  // Discovery documents and key sets, cached for an hour.
  const discovered = new Map<string, { at: number; doc: Discovery; jwks: ReturnType<typeof createRemoteJWKSet> }>();
  async function discover(issuer: string) {
    const hit = discovered.get(issuer);
    if (hit && Date.now() - hit.at < 3600_000) return hit;
    const res = await fetch(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`The provider's sign-in settings could not be read (HTTP ${res.status})`);
    const doc = (await res.json()) as Discovery;
    if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri) throw new Error('The provider sent incomplete sign-in settings');
    const entry = { at: Date.now(), doc, jwks: createRemoteJWKSet(new URL(doc.jwks_uri)) };
    discovered.set(issuer, entry);
    return entry;
  }

  // Sign-ins in progress (10 minutes) and finished sign-ins waiting for the console to pick up their session (1 minute).
  const pending = new Map<string, { connectionId: string; nonce: string; verifier: string; at: number }>();
  const finished = new Map<string, { token: string; expiresAt: string; user: ReturnType<typeof userView>; at: number }>();
  const sweep = () => {
    const now = Date.now();
    for (const [k, v] of pending) if (now - v.at > 10 * 60_000) pending.delete(k);
    for (const [k, v] of finished) if (now - v.at > 60_000) finished.delete(k);
  };

  const connectionView = (c: Connection) => ({
    id: c.id,
    tenantId: c.tenant_id,
    provider: c.provider,
    name: c.name,
    issuer: c.issuer,
    clientId: c.client_id,
    domains: parseJson<string[]>(c.domains, []),
    autoProvision: !!c.auto_provision,
    defaultRole: c.default_role,
    requireSso: !!c.require_sso,
    enabled: !!c.enabled,
  });

  // ------------------------------------------------------------------------------------------- sign-in

  /** Which buttons the sign-in page shows (nothing about which organizations use them). */
  app.get('/v1/auth/sso/options', async () => {
    const rows = ctx.db.all<{ provider: string }>('SELECT DISTINCT provider FROM sso_connections WHERE enabled = 1');
    const has = (p: string) => rows.some((r) => r.provider === p);
    return { google: has('google'), microsoft: has('microsoft'), oidc: has('oidc') };
  });

  app.post('/v1/auth/sso/start', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const body = z.object({ provider: z.enum(SSO_PROVIDERS).optional(), email: z.string().max(320).optional(), connectionId: z.string().optional() }).parse(req.body);
    sweep();
    const enabled = ctx.db.all<Connection>('SELECT * FROM sso_connections WHERE enabled = 1');
    let c: Connection | undefined;
    if (body.connectionId) c = enabled.find((x) => x.id === body.connectionId);
    else if (body.email?.includes('@')) {
      const domain = body.email.trim().toLowerCase().split('@')[1];
      c = enabled.find((x) => (!body.provider || x.provider === body.provider) && parseJson<string[]>(x.domains, []).includes(domain));
    } else if (body.provider) {
      const of = enabled.filter((x) => x.provider === body.provider);
      if (of.length === 1) c = of[0];
      else if (of.length > 1) throw badRequest('Enter your email first, so FBRX Command knows which organization to sign you in to');
    }
    if (!c) throw badRequest(body.email ? 'There is no single sign-on for that email address. Sign in with your password.' : 'Single sign-on is not set up for this provider');
    const { doc } = await discover(c.issuer).catch((e: Error) => {
      throw badRequest(e.message);
    });
    const state = b64u(randomBytes(24));
    const nonce = b64u(randomBytes(24));
    const verifier = b64u(randomBytes(48));
    pending.set(state, { connectionId: c.id, nonce, verifier, at: Date.now() });
    const domains = parseJson<string[]>(c.domains, []);
    const url = new URL(doc.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: c.client_id,
      redirect_uri: callbackUrl(),
      scope: 'openid email profile',
      state,
      nonce,
      code_challenge: b64u(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      prompt: 'select_account',
      ...(body.email ? { login_hint: body.email.trim() } : {}),
      ...(c.provider === 'google' && domains.length === 1 && domains[0] !== 'gmail.com' ? { hd: domains[0] } : {}),
    }).toString();
    return { url: url.toString() };
  });

  app.get('/v1/auth/sso/callback', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    const back = (params: Record<string, string>) => reply.redirect(`/?${new URLSearchParams(params)}`);
    const flow = q.state ? pending.get(q.state) : undefined;
    if (q.state) pending.delete(q.state);
    const c = flow ? ctx.db.get<Connection>('SELECT * FROM sso_connections WHERE id = ? AND enabled = 1', flow.connectionId) : undefined;
    const fail = (why: string, shown = 'Single sign-on did not work. Try again, or sign in with your password.') => {
      ctx.audit.record({ type: 'system', id: null, label: 'sso', tenantId: c?.tenant_id ?? null, ip: req.ip }, 'auth.login.failed', { type: 'sso', id: c?.id ?? null }, { reason: why, provider: c?.provider });
      return back({ sso_error: shown });
    };
    if (!flow || !c) return fail('unknown or expired sign-in', 'That sign-in expired. Start again.');
    if (q.error) return fail(`provider: ${q.error}`, q.error === 'access_denied' ? 'Sign-in was cancelled.' : 'The provider refused the sign-in.');
    if (!q.code) return fail('no code');
    let claims: JWTPayload & Record<string, unknown>;
    try {
      const { doc, jwks } = await discover(c.issuer);
      const res = await fetch(doc.token_endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: q.code,
          redirect_uri: callbackUrl(),
          client_id: c.client_id,
          client_secret: openString(ctx.keys.master, c.client_secret_enc, `sso:${c.id}`),
          code_verifier: flow.verifier,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const tokens = (await res.json().catch(() => ({}))) as { id_token?: string; error?: string };
      if (!res.ok || !tokens.id_token) return fail(`token endpoint: ${tokens.error ?? res.status}`);
      ({ payload: claims } = await jwtVerify(tokens.id_token, jwks, { issuer: doc.issuer, audience: c.client_id, algorithms: ['RS256', 'ES256', 'PS256'] }));
    } catch (err) {
      return fail(`id token: ${(err as Error).message}`);
    }
    if (claims.nonce !== flow.nonce) return fail('nonce mismatch');
    const who = ssoIdentity(c.provider, claims, parseJson<string[]>(c.domains, []));
    if ('error' in who) return fail(who.error, who.error);

    // Only this organization's people: never someone in another organization, never the platform administrator.
    let u = ctx.db.get<any>('SELECT * FROM users WHERE email = ?', who.email);
    if (u && u.tenant_id !== c.tenant_id) return fail('account belongs elsewhere', 'This account cannot use this sign-in. Ask your FBRX Command administrator.');
    if (!u) {
      if (!c.auto_provision) return fail('not invited', `${who.email} has not been added to FBRX Command yet. Ask your administrator to invite you.`);
      const id = ids.user();
      const now = new Date().toISOString();
      ctx.db.run('INSERT INTO users (id, tenant_id, email, name, password_hash, role, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)', id, c.tenant_id, who.email, who.name, '', c.default_role, now, now);
      ctx.audit.record({ type: 'system', id: null, label: `sso:${c.provider}`, tenantId: c.tenant_id, ip: req.ip }, 'user.created', { type: 'user', id, tenantId: c.tenant_id }, { email: who.email, role: c.default_role, via: 'sso' });
      u = ctx.db.get<any>('SELECT * FROM users WHERE id = ?', id);
    }
    if (u.status !== 'active') return fail('user disabled', 'This account is turned off. Ask your administrator.');
    ctx.db.run('UPDATE users SET sso_connection_id = ?, sso_subject = ?, failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', c.id, String(claims.sub ?? ''), new Date().toISOString(), u.id);
    const session = await issueSession(ctx, u, req);
    ctx.audit.record({ type: 'user', id: u.id, label: u.email, tenantId: u.tenant_id, ip: req.ip }, 'auth.login', { type: 'session', id: session.sessionId }, { method: 'sso', provider: c.provider });
    const code = b64u(randomBytes(24));
    finished.set(code, { token: session.token, expiresAt: session.expiresAt, user: userView(ctx.db.get('SELECT * FROM users WHERE id = ?', u.id)), at: Date.now() });
    return back({ sso: code });
  });

  /** The console trades the one-time code from the callback for its session (so the session never sits in a URL). */
  app.post('/v1/auth/sso/exchange', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const { code } = z.object({ code: z.string().min(10).max(100) }).parse(req.body);
    sweep();
    const hit = finished.get(code);
    finished.delete(code);
    if (!hit) throw badRequest('That sign-in expired. Start again.');
    return { token: hit.token, expiresAt: hit.expiresAt, user: hit.user };
  });

  // -------------------------------------------------------------------------------------- administration

  const ConnectionInput = z.object({
    provider: z.enum(SSO_PROVIDERS),
    name: z.string().max(80).optional(),
    /** Microsoft: the Directory (tenant) ID or primary domain. */
    directory: z.string().max(200).optional(),
    /** Other providers: the issuer URL. */
    issuer: z.string().url().optional(),
    clientId: z.string().min(3).max(300),
    clientSecret: z.string().min(3).max(500).optional(),
    domains: z.array(z.string().min(3).max(200)).max(20),
    autoProvision: z.boolean().default(false),
    defaultRole: z.enum(SSO_ROLES).default('viewer'),
    requireSso: z.boolean().default(false),
    enabled: z.boolean().default(true),
  });

  function issuerFor(b: z.infer<typeof ConnectionInput>): string {
    if (b.provider === 'google') return GOOGLE_ISSUER;
    if (b.provider === 'microsoft') {
      const d = b.directory?.trim();
      if (!d || !/^[\w.-]+$/.test(d) || ['common', 'organizations', 'consumers'].includes(d.toLowerCase())) throw badRequest('Enter the Directory (tenant) ID from Microsoft Entra');
      return microsoftIssuer(d);
    }
    const iss = b.issuer?.replace(/\/+$/, '');
    if (!iss) throw badRequest('Enter the issuer URL');
    const u = new URL(iss);
    if (u.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(u.hostname)) throw badRequest('The issuer must be an https:// address');
    return iss;
  }
  const cleanDomains = (d: string[]) => [...new Set(d.map((x) => x.trim().toLowerCase().replace(/^@/, '')).filter((x) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(x)))];
  const PROVIDER_NAMES: Record<SsoProvider, string> = { google: 'Google Workspace', microsoft: 'Microsoft 365', oidc: 'Single sign-on' };

  app.get('/v1/admin/sso', { preHandler: auth }, async (req) => {
    requirePerm(req, 'users.manage');
    const tenantId = requireTenant(req);
    return { callbackUrl: callbackUrl(), connections: ctx.db.all<Connection>('SELECT * FROM sso_connections WHERE tenant_id = ? ORDER BY created_at', tenantId).map(connectionView) };
  });

  app.post('/v1/admin/sso', { preHandler: auth }, async (req) => {
    const p = requirePerm(req, 'sso.manage');
    const tenantId = requireTenant(req);
    const b = ConnectionInput.parse(req.body);
    if (!b.clientSecret) throw badRequest('Enter the client secret');
    const domains = cleanDomains(b.domains);
    if (!domains.length) throw badRequest('Add at least one email domain, like school.org');
    const id = ids.sso();
    const now = new Date().toISOString();
    ctx.db.run(
      'INSERT INTO sso_connections (id, tenant_id, provider, name, issuer, client_id, client_secret_enc, domains, auto_provision, default_role, require_sso, enabled, created_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
      id,
      tenantId,
      b.provider,
      b.name?.trim() || PROVIDER_NAMES[b.provider],
      issuerFor(b),
      b.clientId.trim(),
      sealString(ctx.keys.master, b.clientSecret.trim(), `sso:${id}`),
      JSON.stringify(domains),
      b.autoProvision ? 1 : 0,
      b.defaultRole,
      b.requireSso ? 1 : 0,
      b.enabled ? 1 : 0,
      p.label,
      now,
      now,
    );
    ctx.audit.record(actorOf(req), 'sso.created', { type: 'sso', id, tenantId }, { provider: b.provider, domains, autoProvision: b.autoProvision, requireSso: b.requireSso });
    return connectionView(ctx.db.get<Connection>('SELECT * FROM sso_connections WHERE id = ?', id)!);
  });

  app.patch('/v1/admin/sso/:id', { preHandler: auth }, async (req) => {
    requirePerm(req, 'sso.manage');
    const c = ctx.db.get<Connection>('SELECT * FROM sso_connections WHERE id = ?', (req.params as { id: string }).id);
    if (!c) throw notFound();
    assertTenantAccess(req, c.tenant_id);
    const b = ConnectionInput.partial().parse(req.body);
    const merged = { ...connectionView(c), ...b } as z.infer<typeof ConnectionInput>;
    const issuer = b.directory !== undefined || b.issuer !== undefined || b.provider !== undefined ? issuerFor({ ...merged, provider: b.provider ?? c.provider }) : c.issuer;
    const domains = b.domains ? cleanDomains(b.domains) : parseJson<string[]>(c.domains, []);
    if (!domains.length) throw badRequest('Add at least one email domain, like school.org');
    ctx.db.run(
      'UPDATE sso_connections SET provider = ?, name = ?, issuer = ?, client_id = ?, client_secret_enc = ?, domains = ?, auto_provision = ?, default_role = ?, require_sso = ?, enabled = ?, updated_at = ? WHERE id = ?',
      b.provider ?? c.provider,
      b.name?.trim() || c.name,
      issuer,
      b.clientId?.trim() || c.client_id,
      b.clientSecret ? sealString(ctx.keys.master, b.clientSecret.trim(), `sso:${c.id}`) : c.client_secret_enc,
      JSON.stringify(domains),
      b.autoProvision === undefined ? c.auto_provision : b.autoProvision ? 1 : 0,
      b.defaultRole ?? c.default_role,
      b.requireSso === undefined ? c.require_sso : b.requireSso ? 1 : 0,
      b.enabled === undefined ? c.enabled : b.enabled ? 1 : 0,
      new Date().toISOString(),
      c.id,
    );
    discovered.delete(c.issuer);
    ctx.audit.record(actorOf(req), 'sso.updated', { type: 'sso', id: c.id, tenantId: c.tenant_id }, { ...b, clientSecret: b.clientSecret ? '[changed]' : undefined });
    return connectionView(ctx.db.get<Connection>('SELECT * FROM sso_connections WHERE id = ?', c.id)!);
  });

  app.delete('/v1/admin/sso/:id', { preHandler: auth }, async (req) => {
    requirePerm(req, 'sso.manage');
    const c = ctx.db.get<Connection>('SELECT * FROM sso_connections WHERE id = ?', (req.params as { id: string }).id);
    if (!c) throw notFound();
    assertTenantAccess(req, c.tenant_id);
    ctx.db.run('DELETE FROM sso_connections WHERE id = ?', c.id);
    ctx.audit.record(actorOf(req), 'sso.deleted', { type: 'sso', id: c.id, tenantId: c.tenant_id }, { provider: c.provider });
    return { ok: true };
  });
}

/**
 * Whether someone must use single sign-on instead of a password: tenant users whose organization turned on "require
 * single sign-on". Owners keep their password (and MFA) as the way back in if the provider breaks.
 */
export function passwordBlockedBySso(ctx: AppContext, user: { tenant_id: string | null; role: string }): boolean {
  if (!user.tenant_id || user.role === 'owner' || user.role === 'superadmin') return false;
  return !!ctx.db.get('SELECT 1 FROM sso_connections WHERE tenant_id = ? AND enabled = 1 AND require_sso = 1', user.tenant_id);
}
