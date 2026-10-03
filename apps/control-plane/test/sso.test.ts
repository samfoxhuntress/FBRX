import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { buildServer, type BuiltServer } from '../src/server';
import { loadConfig } from '../src/config';
import { ssoIdentity } from '../src/routes/sso';

const ADMIN_PASSWORD = 'Super-Secret-Admin-Pass-1';

/** A small OpenID Connect provider: discovery, keys, and a token endpoint that checks PKCE and signs ID tokens. */
async function mockIdp() {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { challenge: string; claims: Record<string, unknown>; clientId: string }>();
  let issuer = '';
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url!, issuer);
    const json = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (url.pathname === '/.well-known/openid-configuration') return json(200, { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', async () => {
        const f = new URLSearchParams(body);
        const entry = codes.get(f.get('code') ?? '');
        codes.delete(f.get('code') ?? '');
        const verifier = f.get('code_verifier') ?? '';
        if (!entry || createHash('sha256').update(verifier).digest('base64url') !== entry.challenge || f.get('client_secret') !== 'shh-its-a-secret') return json(400, { error: 'invalid_grant' });
        const idToken = await new SignJWT(entry.claims)
          .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
          .setIssuer(issuer)
          .setAudience(entry.clientId)
          .setSubject(String(entry.claims.sub ?? 'subject-1'))
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(privateKey);
        json(200, { access_token: 'at', id_token: idToken, token_type: 'Bearer' });
      });
      return;
    }
    json(404, {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    issuer,
    /** What the provider does after someone signs in: remember who, and hand back a code. */
    authorize(authUrl: string, claims: Record<string, unknown>) {
      const u = new URL(authUrl);
      const code = `code-${Math.random().toString(36).slice(2)}`;
      codes.set(code, { challenge: u.searchParams.get('code_challenge')!, clientId: u.searchParams.get('client_id')!, claims: { nonce: u.searchParams.get('nonce'), ...claims } });
      return { code, state: u.searchParams.get('state')! };
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('FBRX Command single sign-on (Google / Microsoft style OpenID Connect)', () => {
  let server: BuiltServer;
  let base: string;
  let dataDir: string;
  let token: string;
  let tenantId: string;
  let idp: Awaited<ReturnType<typeof mockIdp>>;

  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, auth: string | null = token) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(auth ? { authorization: `Bearer ${auth}` } : {}), 'x-fbrx-tenant': tenantId ?? '', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status >= 400) throw Object.assign(new Error(`${res.status} ${JSON.stringify(json)}`), { status: res.status, json });
    return json as any;
  };
  /** Runs a whole sign-in: start, the provider, the callback, and the exchange. Returns the session or the error shown. */
  const signIn = async (claims: Record<string, unknown>, start: Record<string, unknown> = { provider: 'oidc' }) => {
    const { url } = await api('POST', '/v1/auth/sso/start', start, {}, null);
    const { code, state } = idp.authorize(url, claims);
    const cb = await fetch(`${base}/v1/auth/sso/callback?${new URLSearchParams({ code, state })}`, { redirect: 'manual' });
    expect(cb.status).toBe(302);
    const back = new URL(cb.headers.get('location')!, base);
    if (back.searchParams.get('sso_error')) return { error: back.searchParams.get('sso_error')!, state };
    const session = await api('POST', '/v1/auth/sso/exchange', { code: back.searchParams.get('sso') }, {}, null);
    return { session, state, exchangeCode: back.searchParams.get('sso')! };
  };

  beforeAll(async () => {
    idp = await mockIdp();
    dataDir = mkdtempSync(join(tmpdir(), 'fbrx-sso-'));
    server = await buildServer(loadConfig({}, { dataDir, port: 0, host: '127.0.0.1', logLevel: 'silent', setupToken: 'setup-token-123', adminConsoleDir: null }));
    await server.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
    server.ctx.config.publicUrl = base;
    const setup = await (await fetch(`${base}/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setupToken: 'setup-token-123', organization: 'Platform', name: 'Sam', email: 'sam@fbrx.example', password: ADMIN_PASSWORD }) })).json();
    expect(setup.ok).toBe(true);
    token = (await (await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'sam@fbrx.example', password: ADMIN_PASSWORD }) })).json()).token;
    tenantId = (await api('POST', '/v1/admin/tenants', { name: 'Hillside Co-op' })).id;
  });

  afterAll(async () => {
    await server?.close();
    await idp?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('knows who signed in, per provider rules', () => {
    expect(ssoIdentity('google', { email: 'Ms.Lee@Hillside.org', email_verified: true, hd: 'hillside.org', name: 'Ms Lee' }, ['hillside.org'])).toEqual({ email: 'ms.lee@hillside.org', name: 'Ms Lee' });
    expect(ssoIdentity('google', { email: 'lee@hillside.org', email_verified: true }, ['hillside.org'])).toMatchObject({ error: expect.stringMatching(/Workspace/) });
    expect(ssoIdentity('google', { email: 'lee@hillside.org', email_verified: false, hd: 'hillside.org' }, ['hillside.org'])).toMatchObject({ error: expect.stringMatching(/verified/) });
    expect(ssoIdentity('google', { email: 'lee@gmail.com', email_verified: true }, ['gmail.com'])).toMatchObject({ email: 'lee@gmail.com' });
    expect(ssoIdentity('microsoft', { preferred_username: 'lee@hillside.org', name: 'Lee' }, ['hillside.org'])).toEqual({ email: 'lee@hillside.org', name: 'Lee' });
    expect(ssoIdentity('microsoft', { email: 'lee@other.org' }, ['hillside.org'])).toMatchObject({ error: expect.stringMatching(/not one of/) });
    expect(ssoIdentity('oidc', { sub: 'x' }, ['hillside.org'])).toMatchObject({ error: expect.stringMatching(/email/) });
  });

  it('sets up a connection, signs invited staff in, and keeps everyone else out', async () => {
    expect(await api('GET', '/v1/auth/sso/options', undefined, {}, null)).toEqual({ google: false, microsoft: false, oidc: false });
    // Inviting without a password needs single sign-on first.
    await expect(api('POST', '/v1/admin/users', { email: 'ms.lee@hillside.org', name: 'Ms Lee', role: 'operator' })).rejects.toMatchObject({ status: 400 });
    await expect(api('POST', '/v1/admin/sso', { provider: 'microsoft', directory: 'common', clientId: 'app', clientSecret: 'x', domains: ['hillside.org'] })).rejects.toMatchObject({ status: 400 });

    const conn = await api('POST', '/v1/admin/sso', { provider: 'oidc', name: 'Co-op sign-in', issuer: idp.issuer, clientId: 'fbrx-command', clientSecret: 'shh-its-a-secret', domains: ['@Hillside.org', 'nonsense'] });
    expect(conn).toMatchObject({ provider: 'oidc', domains: ['hillside.org'], autoProvision: false, defaultRole: 'viewer', requireSso: false });
    expect(JSON.stringify(conn)).not.toContain('shh-its-a-secret');
    expect((await api('GET', '/v1/admin/sso')).callbackUrl).toBe(`${base}/v1/auth/sso/callback`);
    expect(await api('GET', '/v1/auth/sso/options', undefined, {}, null)).toEqual({ google: false, microsoft: false, oidc: true });

    // Not invited yet, and no accounts made on first sign-in: refused.
    expect((await signIn({ email: 'ms.lee@hillside.org', name: 'Ms Lee' })).error).toMatch(/has not been added/);

    const invited = await api('POST', '/v1/admin/users', { email: 'ms.lee@hillside.org', name: 'Ms Lee', role: 'operator' });
    expect(invited).toMatchObject({ hasPassword: false, sso: false });
    const ok = await signIn({ email: 'MS.LEE@hillside.org', name: 'Ms Lee', sub: 'idp-user-7' }, { email: 'ms.lee@hillside.org' });
    expect(ok.session).toMatchObject({ user: { email: 'ms.lee@hillside.org', role: 'operator', sso: true } });
    const me = await api('GET', '/v1/auth/me', undefined, {}, ok.session.token);
    expect(me.principal).toMatchObject({ role: 'operator', tenantId });
    // The one-time code works once.
    await expect(api('POST', '/v1/auth/sso/exchange', { code: ok.exchangeCode }, {}, null)).rejects.toMatchObject({ status: 400 });
    // So does the sign-in state.
    const replay = await fetch(`${base}/v1/auth/sso/callback?${new URLSearchParams({ code: 'whatever', state: ok.state })}`, { redirect: 'manual' });
    expect(new URL(replay.headers.get('location')!, base).searchParams.get('sso_error')).toMatch(/expired/);

    // A password does not work for an account made for single sign-on.
    const pw = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ms.lee@hillside.org', password: 'anything-at-all-123' }) });
    expect(pw.status).toBe(401);
    expect((await pw.json()).error.message).toMatch(/Google or Microsoft/);

    // Wrong domain, a forged nonce, and a different organization's account are all refused.
    expect((await signIn({ email: 'someone@elsewhere.org' })).error).toMatch(/not one of/);
    const { url } = await api('POST', '/v1/auth/sso/start', { provider: 'oidc' }, {}, null);
    const forged = idp.authorize(url, { email: 'ms.lee@hillside.org', nonce: 'not-the-nonce' });
    const bad = await fetch(`${base}/v1/auth/sso/callback?${new URLSearchParams(forged)}`, { redirect: 'manual' });
    expect(new URL(bad.headers.get('location')!, base).searchParams.get('sso_error')).toBeTruthy();
    const other = (await api('POST', '/v1/admin/tenants', { name: 'Another School' })).id;
    await api('POST', '/v1/admin/users', { email: 'principal@hillside.org', name: 'Elsewhere', role: 'owner', password: 'Owner-Password-12345' }, { 'x-fbrx-tenant': other });
    expect((await signIn({ email: 'principal@hillside.org' })).error).toMatch(/cannot use this sign-in/);
    expect((await signIn({ email: 'sam@fbrx.example' })).error).toBeTruthy();

    const audit = await api('GET', '/v1/admin/audit?limit=100');
    expect(audit.map((a: any) => a.action)).toEqual(expect.arrayContaining(['sso.created', 'auth.login', 'auth.login.failed']));
  });

  it('can create accounts on first sign-in, and can require single sign-on with the owner as the way back in', async () => {
    const [conn] = (await api('GET', '/v1/admin/sso')).connections;
    await api('PATCH', `/v1/admin/sso/${conn.id}`, { autoProvision: true, defaultRole: 'viewer', requireSso: true });
    const fresh = await signIn({ email: 'new.teacher@hillside.org', name: 'New Teacher' });
    expect(fresh.session.user).toMatchObject({ email: 'new.teacher@hillside.org', role: 'viewer', hasPassword: false });

    await api('POST', '/v1/admin/users', { email: 'office@hillside.org', name: 'Office', role: 'admin', password: 'Office-Password-1234' });
    await api('POST', '/v1/admin/users', { email: 'owner@hillside.org', name: 'Owner', role: 'owner', password: 'Owner-Password-12345' });
    const login = (email: string, password: string) => fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    expect((await login('office@hillside.org', 'Office-Password-1234')).status).toBe(401);
    expect((await login('owner@hillside.org', 'Owner-Password-12345')).status).toBe(200);
    expect((await login('sam@fbrx.example', ADMIN_PASSWORD)).status).toBe(200);

    // Operators and admins cannot set up sign-in (it can sign people in as anyone in the organization).
    const officeToken = (await signIn({ email: 'office@hillside.org' })).session.token;
    await expect(api('POST', '/v1/admin/sso', { provider: 'google', clientId: 'x', clientSecret: 'y', domains: ['hillside.org'] }, {}, officeToken)).rejects.toMatchObject({ status: 403 });

    // Turned off, the button disappears and nobody gets in through it.
    await api('PATCH', `/v1/admin/sso/${conn.id}`, { enabled: false });
    expect((await api('GET', '/v1/auth/sso/options', undefined, {}, null)).oidc).toBe(false);
    await expect(api('POST', '/v1/auth/sso/start', { provider: 'oidc' }, {}, null)).rejects.toMatchObject({ status: 400 });
    expect((await login('office@hillside.org', 'Office-Password-1234')).status).toBe(200);
  });
});
