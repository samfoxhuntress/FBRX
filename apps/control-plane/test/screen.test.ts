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

/**
 * Remote screen from FBRX Command: the administrator's switch, a ticket, the person's yes, only the asker's session.
 */
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
const told: boolean[] = [];
let picture = Buffer.from('office screen');
let answer: 'control' | 'view' | 'deny' = 'control';
const share: ScreenShare = {
  capture: async () => ({ jpeg: picture, width: 1280, height: 720, displays: 1 }),
  input: async (events) => void inputs.push(events),
  canControl: async () => ({ ok: true, why: null }),
  ask: async (q) => (asked.push(`${q.who}|${q.ticket}|${q.reason}`), told.push(q.recorded), answer),
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

  it('keeps a recording when the organization turns it on, and the person is told', async () => {
    const olly = await login('olly@fox.example', PASSWORD);
    expect((await call('PATCH', `/v1/admin/tenants/${tenantId}`, { screenRecording: true, screenRecordingDays: 30 }, olly)).status).toBe(403);
    expect((await call('PATCH', `/v1/admin/tenants/${tenantId}`, { screenRecording: true, screenRecordingDays: 30 })).body.screenRecording).toBe(true);

    // A JPEG (FF D8 FF ...): only pictures go in a recording.
    picture = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('the front desk screen')]);
    const s = await call('POST', `/v1/admin/devices/${deviceId}/screen`, { mode: 'control', ticket: '4600', reason: 'Email will not send' });
    expect(s.body.recorded).toBe(true);
    expect(told[told.length - 1]).toBe(true);
    const sid = s.body.id as string;
    await waitFor(async () => (await call('GET', `/v1/admin/screen/${sid}`)).body?.state === 'live');
    expect((await call('GET', `/v1/admin/screen/${sid}/frame?after=-1`)).status).toBe(200);
    expect((await call('POST', `/v1/admin/screen/${sid}/input`, { events: [{ t: 'text', text: 'my password' }] })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 1100));
    expect((await call('GET', `/v1/admin/screen/${sid}/frame?after=-1`)).status).toBe(200);
    expect((await call('POST', `/v1/admin/screen/${sid}/end`)).status).toBe(200);

    // Operators run sessions; owners and administrators watch them.
    expect((await call('GET', '/v1/admin/screen-recordings', undefined, olly)).status).toBe(403);
    const list = (await call('GET', '/v1/admin/screen-recordings')).body;
    expect(list.on).toBe(true);
    expect(list.recordings).toHaveLength(1);
    const rec = list.recordings[0];
    expect(rec).toMatchObject({ device: 'Front desk', admin: 'Sam', ticket: '4600', reason: 'Email will not send', frames: 2, inputUsed: true, cut: null });
    const detail = (await call('GET', `/v1/admin/screen-recordings/${rec.id}`)).body;
    expect(detail.frames).toHaveLength(2);
    expect(detail.frames[1].t).toBeGreaterThanOrEqual(1000);
    expect(detail.inputs).toHaveLength(1);
    const pic = await fetch(`${base}/v1/admin/screen-recordings/${rec.id}/frames/0`, { headers: { authorization: `Bearer ${token}`, 'x-fbrx-tenant': tenantId } });
    expect(pic.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await pic.arrayBuffer()).equals(picture)).toBe(true);
    expect((await call('GET', `/v1/admin/screen-recordings/${rec.id}/frames/2`)).status).toBe(404);
    expect((await call('GET', '/v1/admin/screen-recordings/rec_../../keys')).status).toBe(404);
    // What was typed is nowhere in the recording.
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(server.ctx.recorder.file(rec.id)).includes(Buffer.from('my password'))).toBe(false);

    // A session the person said no to leaves no recording.
    answer = 'deny';
    const no = await call('POST', `/v1/admin/devices/${deviceId}/screen`, { mode: 'view', ticket: '4601' });
    await waitFor(async () => (await call('GET', `/v1/admin/screen/${no.body.id}`)).body?.state === 'denied');
    answer = 'control';
    expect((await call('GET', '/v1/admin/screen-recordings')).body.recordings).toHaveLength(1);
    expect(server.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM screen_recordings')?.n).toBe(1);
    // Its end is in the audit log all the same, said by the computer.
    const ended = server.ctx.db.all<{ details: string }>("SELECT details FROM audit_log WHERE action = 'device.screen.ended'").map((r) => JSON.parse(r.details));
    expect(ended).toEqual(expect.arrayContaining([expect.objectContaining({ session: no.body.id, ticket: '4601', state: 'denied', by: 'computer' })]));

    // Kept for the organization's days, then gone.
    server.ctx.db.run('UPDATE screen_recordings SET started_at = ? WHERE id = ?', new Date(Date.now() - 31 * 86400_000).toISOString(), rec.id);
    expect(server.ctx.recorder.sweep()).toBe(1);
    expect((await call('GET', `/v1/admin/screen-recordings/${rec.id}`)).status).toBe(404);

    // Deleting one is in the audit log.
    const s2 = await call('POST', `/v1/admin/devices/${deviceId}/screen`, { mode: 'view', ticket: '4602' });
    await waitFor(async () => (await call('GET', `/v1/admin/screen/${s2.body.id}`)).body?.state === 'live');
    await call('GET', `/v1/admin/screen/${s2.body.id}/frame?after=-1`);
    await call('POST', `/v1/admin/screen/${s2.body.id}/end`);
    const id2 = (await call('GET', '/v1/admin/screen-recordings')).body.recordings[0].id;
    expect((await call('DELETE', `/v1/admin/screen-recordings/${id2}`)).status).toBe(200);
    const { existsSync } = await import('node:fs');
    expect(existsSync(server.ctx.recorder.file(id2))).toBe(false);
    const audit = server.ctx.db.all<{ action: string }>("SELECT action FROM audit_log WHERE action LIKE 'device.screen.recording.%'").map((r) => r.action);
    expect(audit).toEqual(expect.arrayContaining(['device.screen.recording.viewed', 'device.screen.recording.deleted']));
  }, 60_000);

  it('says so when the computer is not connected', async () => {
    await kernel.call('fleet.unenroll', undefined, USER).catch(() => undefined);
    await kernel.fleet.stop();
    await waitFor(async () => !(await call('GET', '/v1/admin/devices')).body?.find?.((d: { id: string; online: boolean }) => d.id === deviceId)?.online);
    expect((await call('POST', `/v1/admin/devices/${deviceId}/screen`, { mode: 'view', ticket: '1' })).status).toBe(409);
  }, 30_000);
});
