import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DirectoryPolicy, DirectoryStatus } from '@fbrx/shared';
import { loadConfig } from '../src/config';
import { buildServer, type BuiltVirtual } from '../src/server';

// FBRX Server with only the directory role.
let dir: string;
let s: BuiltVirtual;
let admin = '';
let viewer = '';

const req = async (method: string, url: string, token: string | null, payload?: unknown) => {
  const r = await s.app.inject({ method: method as 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: payload as never });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
const status = async () => (await req('GET', '/v1/directory', viewer)).body as DirectoryStatus;
const join_ = async (code: string, name = 'Front desk', os = 'windows') => req('POST', '/v1/directory/join', null, { code, name, os });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fbrx-dir-'));
  const config = loadConfig({
    FBRX_V_DATA_DIR: dir,
    FBRX_V_ROLES: 'directory',
    FBRX_V_TLS: 'off',
    FBRX_V_LOG_LEVEL: 'silent',
    FBRX_V_SYS_ROOT: join(dir, 'no-sysfs'),
    FBRX_V_ADMIN_USER: 'sam',
    FBRX_V_ADMIN_PASSWORD: 'correct horse battery',
    FBRX_V_CORE_TOKEN_FILE: join(dir, 'none.token'),
  });
  s = await buildServer(config, {});
  const login = async (username: string, password: string) => (await s.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username, password } })).json().token as string;
  admin = await login('sam', 'correct horse battery');
  await req('POST', '/v1/users', admin, { username: 'vic', password: 'viewer password', role: 'viewer' });
  viewer = await login('vic', 'viewer password');
});
afterAll(async () => {
  await s.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('the FBRX directory', () => {
  it('keeps users and groups; only administrators change them, and first passwords never come back out', async () => {
    const st = await status();
    expect(st.enabled).toBe(true);
    expect(st.groups.map((g) => g.name)).toEqual(['administrators']);
    expect((await req('POST', '/v1/directory/groups', viewer, { name: 'accounting' })).status).toBe(403);
    expect((await req('POST', '/v1/directory/groups', admin, { name: 'sudo' })).status).toBe(400);
    expect((await req('POST', '/v1/directory/groups', admin, { name: 'accounting', description: 'The books' })).status).toBe(200);
    // Names the system owns, weak first passwords and groups that do not exist are refused.
    expect((await req('POST', '/v1/directory/users', admin, { username: 'root', password: 'Abcdefgh12345' })).status).toBe(400);
    expect((await req('POST', '/v1/directory/users', admin, { username: 'jane', password: 'short' })).status).toBe(400);
    expect((await req('POST', '/v1/directory/users', admin, { username: 'jane', password: 'alllowercase123' })).status).toBe(400);
    expect((await req('POST', '/v1/directory/users', admin, { username: 'jane', password: 'Abcdefgh12345', groups: ['nope'] })).status).toBe(400);
    expect((await req('POST', '/v1/directory/users', admin, { username: 'jane', fullName: 'Jane: Doe', password: 'Abcdefgh12345' })).status).toBe(400);
    const jane = await req('POST', '/v1/directory/users', admin, { username: 'Jane', fullName: 'Jane Doe', password: 'Abcdefgh12345', groups: ['administrators', 'accounting'] });
    expect(jane.status).toBe(200);
    expect(jane.body.user).toMatchObject({ username: 'jane', passwordWaiting: true, passwordVersion: 1, computers: 'all' });
    expect(JSON.stringify(jane.body)).not.toContain('Abcdefgh12345');
    expect((await req('POST', '/v1/directory/users', admin, { username: 'jane', password: 'Abcdefgh12345' })).status).toBe(409);
    expect((await req('POST', '/v1/directory/users', admin, { username: 'bob', fullName: 'Bob', password: 'Zyxwvut98765' })).status).toBe(200);
    expect(JSON.stringify(await status())).not.toContain('Abcdefgh12345');
    expect((await req('DELETE', '/v1/directory/groups/administrators', admin)).status).toBe(409);
  });

  it('lets a computer join once per code use, and gives it what it should have with each first password once', async () => {
    expect((await req('POST', '/v1/directory/codes', viewer, {})).status).toBe(403);
    const made = await req('POST', '/v1/directory/codes', admin, { label: 'Front desk', uses: 1 });
    expect(made.status).toBe(200);
    expect(made.body.value).toMatch(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
    expect(JSON.stringify(await status())).not.toContain(made.body.value);
    expect((await join_('WRONG-CODE1')).status).toBe(401);
    // Typed any way: small letters, no dash.
    const joined = await join_(made.body.value.toLowerCase().replace('-', ''));
    expect(joined.status).toBe(200);
    expect((await join_(made.body.value)).status).toBe(401);
    const token = joined.body.token as string;
    expect((await req('GET', '/v1/directory/policy', null)).status).toBe(401);
    expect((await req('GET', '/v1/directory/policy', `${joined.body.computerId}.notTheRightSecretAtAllxx`)).status).toBe(401);
    // A person's session is not a computer's token.
    expect((await req('GET', '/v1/directory/policy', admin)).status).toBe(401);

    const p1 = (await req('GET', '/v1/directory/policy', token)).body as DirectoryPolicy;
    const jane = p1.users.find((u) => u.username === 'jane')!;
    expect(jane).toMatchObject({ admin: true, groups: ['accounting'], enabled: true, password: { version: 1, value: 'Abcdefgh12345' } });
    expect(p1.groups).toEqual(['accounting']);
    expect(p1.rules.minLength).toBe(12);

    // Once a computer says it set them, the first passwords are not sent to it again.
    expect((await req('POST', '/v1/directory/report', token, { version: p1.version, ok: true, problems: [], passwords: { jane: 1, bob: 1, ghost: 4 } })).status).toBe(200);
    const p2 = (await req('GET', '/v1/directory/policy', token)).body as DirectoryPolicy;
    expect(p2.users.every((u) => !u.password)).toBe(true);
    const c = (await status()).computers[0];
    expect(c).toMatchObject({ name: 'Front desk', os: 'windows', applied: { version: p1.version, ok: true } });

    // A new first password goes out once more; a report cannot claim a version that was never set.
    await req('PUT', '/v1/directory/users/jane', admin, { password: 'NewFirst12345' });
    expect((await req('POST', '/v1/directory/report', token, { version: 1, ok: true, problems: [], passwords: { jane: 9 } })).status).toBe(200);
    const p3 = (await req('GET', '/v1/directory/policy', token)).body as DirectoryPolicy;
    expect(p3.users.find((u) => u.username === 'jane')!.password).toEqual({ version: 2, value: 'NewFirst12345' });
    expect(p3.version).toBeGreaterThan(p1.version);
  });

  it('retires removed accounts and accounts no longer for a computer; removed computers lose their token', async () => {
    const code = (await req('POST', '/v1/directory/codes', admin, { uses: 2 })).body.value as string;
    const a = (await join_(code, 'Lab 1', 'linux')).body;
    const b = (await join_(code, 'Lab 2', 'mac')).body;
    await req('PUT', '/v1/directory/users/bob', admin, { computers: [a.computerId] });
    const forB = (await req('GET', '/v1/directory/policy', b.token)).body as DirectoryPolicy;
    expect(forB.users.map((u) => u.username)).toEqual(['jane']);
    expect(forB.retired).toContain('bob');
    expect(((await req('GET', '/v1/directory/policy', a.token)).body as DirectoryPolicy).users.map((u) => u.username)).toEqual(['jane', 'bob']);

    await req('DELETE', '/v1/directory/users/bob', admin);
    expect(((await req('GET', '/v1/directory/policy', a.token)).body as DirectoryPolicy).retired).toContain('bob');

    // Removing a group takes it off its members.
    await req('DELETE', '/v1/directory/groups/accounting', admin);
    expect((await status()).users.find((u) => u.username === 'jane')!.groups).toEqual(['administrators']);

    expect((await req('DELETE', `/v1/directory/computers/${a.computerId}`, admin)).status).toBe(200);
    expect((await req('GET', '/v1/directory/policy', a.token)).status).toBe(401);
    // A computer can leave by itself.
    expect((await req('POST', '/v1/directory/leave', b.token)).status).toBe(200);
    expect((await req('GET', '/v1/directory/policy', b.token)).status).toBe(401);
  });

  it('checks the password rules and the directory name', async () => {
    expect((await req('PUT', '/v1/directory/settings', admin, { rules: { minLength: 4 } })).status).toBe(400);
    expect((await req('PUT', '/v1/directory/settings', viewer, { name: 'Lab' })).status).toBe(403);
    const r = await req('PUT', '/v1/directory/settings', admin, { name: 'Fox Lab', rules: { minLength: 14, maxAgeDays: 90 } });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ name: 'Fox Lab', rules: { minLength: 14, maxAgeDays: 90, complex: true, lockoutAttempts: 10 } });
    // First passwords follow the new rules.
    expect((await req('POST', '/v1/directory/users', admin, { username: 'carl', password: 'Abcdefgh123' })).status).toBe(400);
  });

  it('answers clearly on a server without the role', async () => {
    const d2 = mkdtempSync(join(tmpdir(), 'fbrx-dir2-'));
    const other = await buildServer(
      loadConfig({ FBRX_V_DATA_DIR: d2, FBRX_V_ROLES: 'virtual', FBRX_V_DRIVER: 'simulated', FBRX_V_TLS: 'off', FBRX_V_LOG_LEVEL: 'silent', FBRX_V_SYS_ROOT: join(d2, 'x'), FBRX_V_CORE_TOKEN_FILE: join(d2, 'none.token') }),
      {},
    );
    const r = await other.app.inject({ method: 'POST', url: '/v1/directory/join', payload: { code: 'ABCDE-FGHJK', name: 'x', os: 'linux' } });
    expect(r.statusCode).toBe(409);
    await other.close();
    rmSync(d2, { recursive: true, force: true });
  });
});
