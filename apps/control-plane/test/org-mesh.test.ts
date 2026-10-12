import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MeshStatus } from '@fbrx/shared';
import { buildServer, type BuiltServer } from '../src/server';
import { loadConfig } from '../src/config';
import { Kernel } from '../../../packages/core/src/kernel';
import { createNodePlatform } from '../../../packages/core/src/node-platform';
import { StaticKeyKeychain } from '../../../packages/core/src/platform';

const USER = { origin: 'user' as const, actor: 'tester' };
const PASSWORD = 'Super-Secret-Admin-Pass-1';

async function waitFor<T>(fn: () => T | Promise<T>, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout${last ? `: ${(last as Error).message}` : ''}`);
}

/**
 * An organization's FBRX Mesh: computers enrolled in FBRX Command meet each other without pairing codes (FBRX Command
 * vouches for their keys), and the organization decides which groups may use its servers' AI (the hive).
 */
describe("an organization's computers mesh together", () => {
  let server: BuiltServer;
  let base: string;
  let dataDir: string;
  let token: string;
  let tenantId: string;
  let staffGroup: string;
  const kernels: Array<{ k: Kernel; dir: string }> = [];

  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'x-fbrx-tenant': tenantId ?? '', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status >= 400) throw Object.assign(new Error(`${res.status} ${JSON.stringify(json)}`), { status: res.status });
    return json as any;
  };

  const computer = async (name: string, enrollToken: string, port: number, roles: string[] = []) => {
    const dir = mkdtempSync(join(tmpdir(), 'fbrx-orgmesh-'));
    const k = await Kernel.create({ dataDir: dir, platform: createNodePlatform({ dataDir: dir, devMode: true, keychain: new StaticKeyKeychain(randomBytes(32), 'memory') }) });
    kernels.push({ k, dir });
    // Mesh off: the organization turns it on.
    k.settings.update({ localApi: { enabled: false }, runtime: { enabled: false }, protection: { shield: { updateSignatures: false } }, general: { deviceName: name }, mesh: { enabled: false, port, assist: { roles } } });
    await k.start();
    k.alerts.stop();
    k.monitor.stop();
    k.protection.stop();
    await k.call('fleet.enroll', { serverUrl: base, token: enrollToken, deviceName: name }, USER);
    await waitFor(() => k.fleet.status().state === 'online');
    return k;
  };
  const peers = (k: Kernel) => k.mesh.devices().filter((d) => d.source === 'org');
  const peer = (k: Kernel, name: string) => peers(k).find((d) => d.name === name);

  beforeAll(async () => {
    process.env.FBRX_ALLOW_INSECURE_FLEET = '1';
    dataDir = mkdtempSync(join(tmpdir(), 'fbrx-cp-orgmesh-'));
    server = await buildServer(loadConfig({}, { dataDir, port: 0, host: '127.0.0.1', logLevel: 'silent', setupToken: 'setup-token-123', adminConsoleDir: null, heartbeatSeconds: 10 }));
    await server.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
    server.ctx.config.publicUrl = base;
    const res = await fetch(`${base}/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setupToken: 'setup-token-123', organization: 'Rivera Design', kind: 'business', name: 'Sam', email: 'sam@rivera.example', password: PASSWORD }) });
    tenantId = (await res.json()).tenantId;
    token = (await (await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'sam@rivera.example', password: PASSWORD }) })).json()).token;
  });

  afterAll(async () => {
    for (const { k, dir } of kernels) {
      await k.stop().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
    await server?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  let desk: Kernel;
  let it1: Kernel;
  let rack: Kernel;

  it('introduces every computer to the others, and turns FBRX Mesh on', async () => {
    const setup = await api('POST', `/v1/admin/tenants/${tenantId}/quick-setup`, {});
    const [staff, itGroup] = setup.groups as Array<{ group: { id: string; name: string }; token: string }>;
    expect([staff.group.name, itGroup.group.name]).toEqual(['Staff', 'IT']);
    staffGroup = staff.group.id;
    desk = await computer('Front desk', staff.token, 47861);
    it1 = await computer('IT laptop', itGroup.token, 47862);
    rack = await computer('rack-server', itGroup.token, 47863, ['virtual', 'ai']);

    for (const k of [desk, it1, rack]) await waitFor(() => k.settings.get().mesh.enabled && k.mesh.running);
    await waitFor(() => peers(desk).length === 2 && peers(it1).length === 2 && peers(rack).length === 2, 30_000);
    expect(peers(desk).map((d) => d.name).sort()).toEqual(['IT laptop', 'rack-server']);
    const status = (await desk.call('mesh.status', undefined, USER)) as MeshStatus;
    expect(status.organization).toMatchObject({ organization: 'Rivera Design', enabled: true, peers: 2 });

    // What each may do is the organization's choice: see each other and talk; nothing of the agent, tasks or approvals.
    expect(peer(rack, 'Front desk')!.permissions).toMatchObject({ status: true, chat: true, assist: true, ask: false, approve: false, workspace: false, control: false });
    // Only a server with the ai role lends its AI.
    expect(peer(desk, 'IT laptop')!.permissions.assist).toBe(false);

    // They really talk: the server knows the desk by the key FBRX Command vouched for, and the other way round.
    const hello = await waitFor(() => desk.mesh.hello(peer(desk, 'rack-server')!.id));
    expect(hello).toMatchObject({ name: 'rack-server', roles: ['virtual', 'ai'] });
    expect(await rack.mesh.hello(peer(rack, 'Front desk')!.id)).toMatchObject({ name: 'Front desk' });

    // The organization's computers cannot be removed or given more rights by hand.
    await expect(desk.call('mesh.removeDevice', { id: peer(desk, 'rack-server')!.id }, USER)).rejects.toMatchObject({ code: 'MANAGED' });
    await expect(desk.call('mesh.setPermissions', { id: peer(desk, 'rack-server')!.id, permissions: { control: true } }, USER)).rejects.toMatchObject({ code: 'MANAGED' });

    const view = await api('GET', '/v1/admin/mesh');
    expect(view).toMatchObject({ meshAuto: true, hive: { groups: 'all' } });
    expect(view.servers.map((s: any) => s.name)).toEqual(['rack-server']);
  }, 90_000);

  it('lends the server AI only to the groups the hive allows', async () => {
    await api('PUT', '/v1/admin/mesh', { hive: { groups: [staffGroup] } });
    await waitFor(() => peer(rack, 'IT laptop')?.permissions.assist === false);
    expect(peer(rack, 'Front desk')!.permissions.assist).toBe(true);
    await expect(api('PUT', '/v1/admin/mesh', { hive: { groups: ['grp_nope'] } })).rejects.toMatchObject({ status: 400 });
  }, 30_000);

  it('forgets the organization’s computers when it stops meshing them, and when a computer leaves', async () => {
    await api('PUT', '/v1/admin/mesh', { meshAuto: false });
    await waitFor(() => peers(desk).length === 0 && peers(rack).length === 0);
    await api('PUT', '/v1/admin/mesh', { meshAuto: true });
    await waitFor(() => peers(desk).length === 2);

    await it1.call('fleet.unenroll', undefined, USER);
    await waitFor(() => peers(it1).length === 0);
  }, 60_000);
});
