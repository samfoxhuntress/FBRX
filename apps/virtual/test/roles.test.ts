import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rolesProblem } from '@fbrx/shared';
import { loadConfig } from '../src/config';
import { buildServer, type BuiltVirtual } from '../src/server';
import { physicalPorts } from '../src/routes/roles';

// The console changing the server's roles, with a stand-in fbrx-server that notes what it was asked.
let dir: string;
let s: BuiltVirtual;
let admin = '';
let viewer = '';
let calls: string;

const req = async (method: string, url: string, token: string, payload?: unknown) => {
  const r = await s.app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${token}` }, payload: payload as never });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 20));
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fbrx-roles-'));
  calls = join(dir, 'calls.txt');
  const cmd = join(dir, 'fbrx-server');
  const state = join(dir, 'state');
  writeFileSync(cmd, `#!/usr/bin/env bash\necho "$*" >>"${calls}"\necho "installer output" >>"${join(dir, 'roles.log')}"\nprintf 'STATE=done\\nROLES=%s\\nSTARTED=x\\nFINISHED=y\\n' "$3" >"${state}/roles.env"\n`);
  chmodSync(cmd, 0o755);
  const config = loadConfig({
    FBRX_V_DATA_DIR: join(dir, 'data'),
    FBRX_V_ROLES: 'virtual,ai',
    FBRX_V_DRIVER: 'simulated',
    FBRX_V_TLS: 'off',
    FBRX_V_LOG_LEVEL: 'silent',
    FBRX_V_SYS_ROOT: join(dir, 'no-sysfs'),
    FBRX_V_ADMIN_USER: 'sam',
    FBRX_V_ADMIN_PASSWORD: 'correct horse battery',
    FBRX_V_CORE_TOKEN_FILE: join(dir, 'none.token'),
    FBRX_V_SERVER_CMD: cmd,
    FBRX_V_BUNDLE_DIR: join(dir, 'bundle'),
    FBRX_V_SERVER_STATE_DIR: state,
    FBRX_V_ROLES_LOG: join(dir, 'roles.log'),
    FBRX_V_SPAWN: 'direct',
  });
  s = await buildServer(config);
  const login = async (username: string, password: string) => (await s.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username, password } })).json().token as string;
  admin = await login('sam', 'correct horse battery');
  await req('POST', '/v1/users', admin, { username: 'vic', password: 'viewer password', role: 'viewer' });
  viewer = await login('vic', 'viewer password');
});
afterAll(async () => {
  await s.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Changing FBRX Server’s roles from the console', () => {
  it('shows the roles, and why they cannot change until the server keeps its installer', async () => {
    const st = (await req('GET', '/v1/server/roles', viewer)).body;
    expect(st).toMatchObject({ roles: ['virtual', 'ai'], canChange: false, why: expect.stringContaining('keeps no copy of its installer'), change: null });
    expect(st.catalog.map((r: { id: string }) => r.id)).toEqual(['virtual', 'ai', 'gate', 'minidome', 'time']);
    expect((await req('POST', '/v1/server/roles', admin, { roles: ['virtual', 'ai', 'time'] })).status).toBe(409);
  });

  // FBRX Server runs on Linux; the stand-in fbrx-server is a bash script.
  it.skipIf(process.platform === 'win32')('runs fbrx-server roles set for administrators, with what each role needs', async () => {
    mkdirSync(join(dir, 'bundle'), { recursive: true });
    writeFileSync(join(dir, 'bundle', 'install.sh'), '#!/usr/bin/env bash\n');
    expect((await req('GET', '/v1/server/roles', viewer)).body).toMatchObject({ canChange: true, why: null });
    expect((await req('POST', '/v1/server/roles', viewer, { roles: ['virtual', 'time'] })).status).toBe(403);
    expect((await req('POST', '/v1/server/roles', admin, { roles: ['ai', 'time'] })).body.error.message).toMatch(/FBRX Time works through FBRX Virtual/);
    expect((await req('POST', '/v1/server/roles', admin, { roles: ['virtual', 'gate'] })).body.error.message).toMatch(/needs its two ports/);
    expect((await req('POST', '/v1/server/roles', admin, { roles: ['virtual', 'gate'], gateWan: 'eno1', gateLan: 'eno1' })).status).toBe(400);

    const r = await req('POST', '/v1/server/roles', admin, { roles: ['virtual', 'ai', 'time'] });
    expect(r.body).toEqual({ started: true, roles: ['virtual', 'ai', 'time'] });
    await until(() => existsSync(calls));
    expect(readFileSync(calls, 'utf8').trim()).toBe('roles set virtual,ai,time --yes');
    const stateFile = join(dir, 'state', 'roles.env');
    await until(() => existsSync(stateFile) && readFileSync(stateFile, 'utf8').includes('STATE=done'));
    const st = (await req('GET', '/v1/server/roles', viewer)).body;
    expect(st.change).toMatchObject({ state: 'done', roles: 'virtual,ai,time', log: expect.stringContaining('installer output') });

    await req('POST', '/v1/server/roles', admin, { roles: ['virtual', 'gate', 'minidome'], gateWan: 'eno1', gateLan: 'eno2' });
    await until(() => readFileSync(calls, 'utf8').trim().split('\n').length === 2);
    expect(readFileSync(calls, 'utf8').trim().split('\n')[1]).toBe('roles set virtual,gate,minidome --yes --gate-wan eno1 --gate-lan eno2');
    const audit = (await req('GET', '/v1/audit', admin)).body.entries.find((e: { action: string }) => e.action === 'server.roles');
    expect(audit).toMatchObject({ outcome: 'success', target: 'virtual,gate,minidome' });
  });

  it('knows what a set of roles needs, and which ports are the server’s own', () => {
    expect(rolesProblem([])).toBe('Pick at least one role');
    expect(rolesProblem(['virtual', 'command'])).toBe('There is no command role');
    expect(rolesProblem(['gate', 'minidome'])).toBeNull();
    expect(rolesProblem(['minidome'])).toMatch(/through FBRX Gate/);
    expect(physicalPorts({ lo: [], eno1: [], eno2: [], virbr0: [], vnet3: [], 'br-lan': [], wg0: [] } as never)).toEqual(['eno1', 'eno2']);
  });
});
