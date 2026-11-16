import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RemoteInput } from '@fbrx/shared';
import { buildServer, type BuiltServer } from '../src/server';
import { loadConfig } from '../src/config';
import { Kernel } from '../../../packages/core/src/kernel';
import { createNodePlatform } from '../../../packages/core/src/node-platform';
import { StaticKeyKeychain, type ScreenShare } from '../../../packages/core/src/platform';

/** Remote screen from FBRX Command: the administrator's switch, a ticket, the person's yes, only the asker's session. */
const USER = { origin: 'user' as const, actor: 'tester' };
const PASSWORD = 'Super-Secret-Admin-Pass-1';

async function waitFor<T>(fn: () => T | Promise<T>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timeout');
}

const inputs: RemoteInput[][] = [];
const asked: string[] = [];
const share: ScreenShare = {
  capture: async () => ({ jpeg: Buffer.from('office screen'), width: 1280, height: 720, displays: 1 }),
  input: async (events) => void inputs.push(events),
  canControl: async () => ({ ok: true, why: null }),
  ask: async (q) => (asked.push(`${q.who}|${q.ticket}|${q.reason}`), 'control'),
  banner: () => undefined,
};

let server: BuiltServer;
let base = '';
let token = '';
let tenantId = '';
let kernel: Kernel;
let dataDir = '';
let kernelDir = '';
let deviceId = '';

const call = async (method: string, path: string, body?: unknown, as = token) => {
  const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${as}`, 'x-fbrx-tenant': tenantId, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};
const login = async (email: string, password: string) => (await (await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })).json()).token as string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'fbrx-cp-screen-'));
  server = await buildServer(loadConfig({}, { dataDir, port: 0, host: '127.0.0.1', logLevel: 'silent', setupToken: 'setup-token-123', adminConsoleDir: null, heartbeatSeconds: 10 }));
  await server.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
  server.ctx.config.publicUrl = base;
  const setup = await (await fetch(`${base}/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setupToken: 'setup-token-123', organization: 'Fox Lab', name: 'Sam', email: 'sam@fox.example', password: PASSWORD }) })).json();
  tenantId = setup.tenantId;
  token = await login('sam@fox.example', PASSWORD);

  const enr = (await call('POST', '/v1/admin/enrollment-tokens', { label: 'Office', maxUses: 2, expiresInDays: 1 })).body;
  kernelDir = mkdtempSync(join(tmpdir(), 'fbrx-cp-screen-dev-'));
  process.env.FBRX_ALLOW_INSECURE_FLEET = '1';
  kernel = await Kernel.create({ dataDir: kernelDir, platform: { ...createNodePlatform({ dataDir: kernelDir, devMode: false, keychain: new StaticKeyKeychain(randomBytes(32), 'memory') }), screenShare: share } });
  kernel.settings.update({ localApi: { enabled: false }, runtime: { enabled: false }, protection: { shield: { updateSignatures: false } } });
  await kernel.start();
  await kernel.call('fleet.enroll', { serverUrl: base, token: enr.token, deviceName: 'Front desk' }, USER);
  await waitFor(() => kernel.fleet.status().state === 'online');
  deviceId = await waitFor(async () => (await call('GET', '/v1/admin/devices')).body?.find?.((d: { name: string; online: boolean }) => d.name === 'Front desk' && d.online)?.id);
}, 60_000);

afterAll(async () => {
  await kernel?.stop().catch(() => undefined);
  await server?.close();
  rmSync(dataDir, { recursive: true, force: true });
  if (kernelDir) rmSync(kernelDir, { recursive: true, force: true });
});

describe('remote screen from FBRX Command', () => {
  it('needs the switch on the administrator and a ticket; the person at the computer is asked with both', async () => {
    expect((await call('POST', `/v1/admin/devices/${deviceId}/screen`, { mode: 'control', ticket: '4521' })).status).toBe(403);
    expect((await call('GET', '/v1/auth/me')).body.permissions).not.toContain('devices.remote');
    const me = (await call('GET', '/v1/auth/me')).body.user;
    server.ctx.db.run('UPDATE users SET remote_control = 1 WHERE id = ?', me.id);
    expect((await call('GET', '/v1/auth/me')).body.permissions).toContain('devices.remote');
    expect((await call('POST', `/v1/admin/devices/${deviceId}/screen`, { mode: 'control', ticket: '' })).status).toBe(400);

    const s = await call('POST', `/v1/admin/devices/${deviceId}/screen`, { mode: 'control', ticket: '4521', reason: 'Printer setup they asked for' });
    expect(s.status).toBe(200);
    expect(asked).toEqual(['Sam, ticket 4521|4521|Printer setup they asked for']);
    const sid = s.body.id as string;
    await waitFor(async () => (await call('GET', `/v1/admin/screen/${sid}`)).body?.state === 'live');
    const f = await call('GET', `/v1/admin/screen/${sid}/frame?after=-1`);
    expect(Buffer.from(f.body.jpeg, 'base64').toString()).toBe('office screen');
    expect((await call('POST', `/v1/admin/screen/${sid}/input`, { events: [{ t: 'text', text: 'hello' }] })).status).toBe(200);
    expect(inputs).toEqual([[{ t: 'text', text: 'hello' }]]);
    expect((await call('POST', `/v1/admin/screen/${sid}/input`, { events: [{ t: 'move', x: 5, y: 0 }] })).status).toBe(400);

    // Another administrator, even with the switch on, cannot use Sam's session.
    await call('POST', '/v1/admin/users', { name: 'Olly', email: 'olly@fox.example', role: 'operator', password: PASSWORD });
    const olly = await login('olly@fox.example', PASSWORD);
    server.ctx.db.run("UPDATE users SET remote_control = 1 WHERE email = 'olly@fox.example'");
    expect((await call('GET', `/v1/admin/screen/${sid}/frame`, undefined, olly)).status).toBe(404);

    expect((await call('POST', `/v1/admin/screen/${sid}/end`)).status).toBe(200);
    expect((await call('GET', `/v1/admin/screen/${sid}/frame`)).status).toBe(404);
    const audit = server.ctx.db.all<{ action: string }>("SELECT action FROM audit_log WHERE action LIKE 'device.screen.%'").map((r) => r.action);
    expect(audit).toEqual(expect.arrayContaining(['device.screen.requested', 'device.screen.ended']));
    expect(kernel.audit.query({ limit: 50 }).map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['screen.requested', 'screen.started', 'screen.ended']));
  }, 60_000);

  it('says so when the computer is not connected', async () => {
    await kernel.call('fleet.unenroll', undefined, USER).catch(() => undefined);
    await kernel.fleet.stop();
    await waitFor(async () => !(await call('GET', '/v1/admin/devices')).body?.find?.((d: { id: string; online: boolean }) => d.id === deviceId)?.online);
    expect((await call('POST', `/v1/admin/devices/${deviceId}/screen`, { mode: 'view', ticket: '1' })).status).toBe(409);
  }, 30_000);
});
