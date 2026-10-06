import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { HelpdeskStatus, SystemStatus, TicketDetail, TicketSummary } from '@fbrx/shared';
import { buildServer, type BuiltServer } from '../src/server';
import { loadConfig } from '../src/config';
import { Kernel } from '../../../packages/core/src/kernel';
import { createNodePlatform } from '../../../packages/core/src/node-platform';
import { StaticKeyKeychain } from '../../../packages/core/src/platform';

const USER = { origin: 'user' as const, actor: 'tester' };
const PASSWORD = 'Super-Secret-Admin-Pass-1';

async function waitFor<T>(fn: () => T | Promise<T>, ms = 15_000): Promise<T> {
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
 * FBRX Command set up as a Home: the kind is picked at first-run setup, quick setup makes Parents and Children groups,
 * children's computers run FBRX OS Home, and their requests for help go to a parent's computer. Other tenants can be
 * Work or School on the same FBRX Command.
 */
describe('FBRX Command for a family', () => {
  let server: BuiltServer;
  let base: string;
  let dataDir: string;
  let token: string;
  let tenantId: string;
  let publicKeyPem: string;
  const kernels: Array<{ k: Kernel; dir: string }> = [];

  const api = async (method: string, path: string, body?: unknown, tenant = tenantId) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'x-fbrx-tenant': tenant ?? '', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status >= 400) throw Object.assign(new Error(`${res.status} ${JSON.stringify(json)}`), { status: res.status });
    return json as any;
  };

  const computer = async (name: string, enrollToken: string, audience?: 'student') => {
    const dir = mkdtempSync(join(tmpdir(), 'fbrx-home-'));
    const k = await Kernel.create({ dataDir: dir, platform: createNodePlatform({ dataDir: dir, devMode: false, keychain: new StaticKeyKeychain(randomBytes(32), 'memory'), licensePublicKeys: [publicKeyPem] }) });
    kernels.push({ k, dir });
    k.settings.update({ localApi: { enabled: false }, runtime: { enabled: false }, profile: { name } });
    await k.start();
    // The background monitor and alert checks only add load here (PowerShell on Windows).
    k.alerts.stop();
    k.monitor.stop();
    await k.call('fleet.enroll', { serverUrl: base, token: enrollToken, deviceName: name, ...(audience ? { audience } : {}) }, USER);
    await waitFor(() => k.fleet.status().state === 'online');
    return k;
  };
  const edition = async (k: Kernel) => ((await k.call('system.status', undefined, USER)) as SystemStatus).edition;

  beforeAll(async () => {
    process.env.FBRX_ALLOW_INSECURE_FLEET = '1';
    dataDir = mkdtempSync(join(tmpdir(), 'fbrx-cp-home-'));
    server = await buildServer(loadConfig({}, { dataDir, port: 0, host: '127.0.0.1', logLevel: 'silent', setupToken: 'setup-token-123', adminConsoleDir: null, heartbeatSeconds: 10 }));
    await server.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
    server.ctx.config.publicUrl = base;
  });

  afterAll(async () => {
    for (const { k, dir } of kernels) {
      await k.stop().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
    await server?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('picks Home at first-run setup', async () => {
    const res = await fetch(`${base}/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setupToken: 'setup-token-123', organization: 'The Rivera family', kind: 'home', name: 'Alex', email: 'alex@rivera.example', password: PASSWORD }) });
    expect(res.status).toBe(200);
    tenantId = (await res.json()).tenantId;
    token = (await (await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'alex@rivera.example', password: PASSWORD }) })).json()).token;
    publicKeyPem = (await api('GET', '/v1/admin/licensing/public-key')).publicKeyPem;
    expect((await api('GET', '/v1/admin/tenants'))[0]).toMatchObject({ name: 'The Rivera family', vertical: 'home' });
    expect((await api('GET', '/v1/auth/me')).tenants[0]).toMatchObject({ vertical: 'home' });
    // Licensing keeps the kind.
    await api('POST', '/v1/admin/licenses', { edition: 'enterprise', seats: 0, vertical: 'home' });
    expect((await api('GET', '/v1/admin/tenants'))[0].vertical).toBe('home');
  });

  let parentToken: string;
  let childToken: string;
  let parent: Kernel;
  let child: Kernel;

  it('makes Parents and Children groups with a token each, once', async () => {
    const r = await api('POST', `/v1/admin/tenants/${tenantId}/quick-setup`, {});
    expect(r.kind).toBe('home');
    expect(r.groups.map((g: any) => [g.group.name, g.audience])).toEqual([
      ['Parents', 'parent'],
      ['Children', 'child'],
    ]);
    expect(r.groups[1].provisioning).toMatchObject({ fbrxProvisioning: 1, serverUrl: base, audience: 'child' });
    parentToken = r.groups[0].token;
    childToken = r.groups[1].token;
    // Running it again reuses the groups and only makes new tokens.
    const again = await api('POST', `/v1/admin/tenants/${tenantId}/quick-setup`, {});
    expect(again.groups.map((g: any) => g.group.id)).toEqual(r.groups.map((g: any) => g.group.id));
    expect((await api('GET', '/v1/admin/groups')).map((g: any) => g.name).sort()).toEqual(['Children', 'Parents']);
  });

  it("runs parents on FBRX Endpoint and children on FBRX OS Home, with help going to a parent", async () => {
    parent = await computer('Alex laptop', parentToken);
    child = await computer('Milo laptop', childToken);
    await waitFor(async () => (await edition(child)).vertical === 'home');
    expect(await edition(parent)).toMatchObject({ vertical: 'home', audience: 'parent', learner: false, productName: 'FBRX Endpoint Ultra' });
    expect(await edition(child)).toMatchObject({ vertical: 'home', audience: 'child', learner: true, productName: 'FBRX OS Home' });
    expect(child.settings.effective().locked).toEqual(expect.arrayContaining(['appearance.easterEggs', 'localApi.enabled', 'ai.providers']));

    // A parent's computer gets the children's requests for help without any setup.
    await waitFor(async () => ((await parent.call('helpdesk.status', undefined, USER)) as HelpdeskStatus).receiver);
    const t = (await child.call('helpdesk.create', { subject: 'The game will not start', body: 'It shows a black screen.', category: 'computer', priority: 'normal' }, USER)) as TicketDetail;
    const queue = await waitFor(async () => ((await parent.call('helpdesk.tickets', { scope: 'queue' }, USER)) as TicketSummary[]).filter((q) => q.id === t.id));
    expect(queue[0]).toMatchObject({ subject: 'The game will not start', requesterName: 'Milo laptop' });

    // A worrying message gets a caring answer that points to a parent, and the family is told which computer only.
    const run = child.agent.start({ message: 'i want to die', origin: 'user', actor: 'child' });
    expect((await run.done).answer).toMatch(/parent/);
    const alert = await waitFor(async () => (await api('GET', '/v1/admin/events')).find((e: any) => e.message.startsWith('Child safety')));
    expect(alert).toMatchObject({ severity: 'critical', deviceName: 'Milo laptop' });
    expect(alert.message).toContain('the child using Milo laptop');
    expect(JSON.stringify(alert)).not.toContain('want to die');
  }, 60_000);

  it('turns "a student computer" into a child computer in a family', async () => {
    const k = await computer('Kitchen tablet', parentToken, 'student');
    expect(await edition(k)).toMatchObject({ audience: 'child', productName: 'FBRX OS Home' });
    const dev = (await api('GET', '/v1/admin/devices')).find((d: any) => d.name === 'Kitchen tablet');
    expect(dev).toMatchObject({ audience: 'child', helpdeskReceiver: false });
  });

  it('runs Work and School tenants next to the family, each with its own quick setup', async () => {
    const work = await api('POST', '/v1/admin/tenants', { name: 'Rivera Design', vertical: 'business' });
    const school = await api('POST', '/v1/admin/tenants', { name: 'Hillside Co-op', vertical: 'education' });
    expect(work.vertical).toBe('business');
    expect(school.vertical).toBe('education');
    const w = await api('POST', `/v1/admin/tenants/${work.id}/quick-setup`, {}, work.id);
    const s = await api('POST', `/v1/admin/tenants/${school.id}/quick-setup`, {}, school.id);
    expect(w.groups.map((g: any) => g.group.name)).toEqual(['Staff', 'IT']);
    expect(w.groups[0].group).toMatchObject({ audience: 'staff', tier: 'basic' });
    expect(s.groups.map((g: any) => [g.group.name, g.audience])).toEqual([
      ['Teachers', 'staff'],
      ['IT', 'staff'],
      ['Students', 'student'],
    ]);
    // Each tenant keeps its own groups.
    expect((await api('GET', '/v1/admin/groups', undefined, work.id)).map((g: any) => g.name).sort()).toEqual(['IT', 'Staff']);
    const kinds = Object.fromEntries((await api('GET', '/v1/auth/me')).tenants.map((t: any) => [t.name, t.vertical]));
    expect(kinds).toEqual({ 'The Rivera family': 'home', 'Rivera Design': 'business', 'Hillside Co-op': 'education' });
  });
});
