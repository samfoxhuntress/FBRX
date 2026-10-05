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
 * A school on FBRX Command: an Education license, staff on Endpoint Basic, IT on Ultra, student computers on
 * FBRX OS Education, tickets from a classroom to the IT computer, and updates pushed to everyone.
 */
describe('FBRX Command for a school', () => {
  let server: BuiltServer;
  let base: string;
  let dataDir: string;
  let token: string;
  let tenantId: string;
  let publicKeyPem: string;
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

  const computer = async (name: string, enrollToken: string, audience?: 'student') => {
    const dir = mkdtempSync(join(tmpdir(), 'fbrx-school-'));
    const k = await Kernel.create({ dataDir: dir, platform: createNodePlatform({ dataDir: dir, devMode: false, keychain: new StaticKeyKeychain(randomBytes(32), 'memory'), licensePublicKeys: [publicKeyPem] }) });
    kernels.push({ k, dir });
    k.settings.update({ localApi: { enabled: false }, runtime: { enabled: false }, profile: { name } });
    await k.start();
    await k.call('fleet.enroll', { serverUrl: base, token: enrollToken, deviceName: name, ...(audience ? { audience } : {}) }, USER);
    await waitFor(() => k.fleet.status().state === 'online');
    return k;
  };

  beforeAll(async () => {
    process.env.FBRX_ALLOW_INSECURE_FLEET = '1';
    dataDir = mkdtempSync(join(tmpdir(), 'fbrx-cp-school-'));
    server = await buildServer(loadConfig({}, { dataDir, port: 0, host: '127.0.0.1', logLevel: 'silent', setupToken: 'setup-token-123', adminConsoleDir: null, heartbeatSeconds: 10 }));
    await server.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
    server.ctx.config.publicUrl = base;
    const setup = await (await fetch(`${base}/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setupToken: 'setup-token-123', organization: 'Hillside Co-op', name: 'Sam', email: 'sam@hillside.example', password: PASSWORD }) })).json();
    tenantId = setup.tenantId;
    token = (await (await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'sam@hillside.example', password: PASSWORD }) })).json()).token;
    publicKeyPem = (await api('GET', '/v1/admin/licensing/public-key')).publicKeyPem;
  });

  afterAll(async () => {
    for (const { k, dir } of kernels) {
      await k.stop().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
    await server?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('makes the organization a school with an Education license', async () => {
    const lic = await api('POST', '/v1/admin/licenses', { edition: 'enterprise', seats: 0, vertical: 'education' });
    expect(lic.vertical).toBe('education');
    expect((await api('GET', '/v1/admin/tenants'))[0]).toMatchObject({ vertical: 'education', autoUpdate: 'notify', helpdeskEnabled: true });
  });

  let staff: Kernel;
  let it_: Kernel;
  let student: Kernel;
  let staffToken: string;

  it('runs teachers on Basic in classroom mode, IT on Ultra, and students on FBRX OS Education', async () => {
    const teachers = await api('POST', '/v1/admin/groups', { name: 'Teachers', audience: 'staff', tier: 'basic' });
    const itGroup = await api('POST', '/v1/admin/groups', { name: 'IT', audience: 'staff' });
    const students = await api('POST', '/v1/admin/groups', { name: 'Students', audience: 'student' });
    expect(teachers).toMatchObject({ audience: 'staff', tier: 'basic' });
    staffToken = (await api('POST', '/v1/admin/enrollment-tokens', { label: 'Teachers', groupId: teachers.id })).token;
    const itToken = (await api('POST', '/v1/admin/enrollment-tokens', { label: 'IT', groupId: itGroup.id })).token;
    const studentToken = (await api('POST', '/v1/admin/enrollment-tokens', { label: 'Student laptops', groupId: students.id, audience: 'student' })).token;

    staff = await computer('Ms Lee', staffToken);
    it_ = await computer('Sam (IT)', itToken);
    student = await computer('Cart laptop 7', studentToken);

    const ed = async (k: Kernel) => ((await k.call('system.status', undefined, USER)) as SystemStatus).edition;
    await waitFor(async () => (await ed(staff)).vertical === 'education');
    expect(await ed(staff)).toMatchObject({ tier: 'basic', audience: 'staff', learner: false, productName: 'FBRX Endpoint Basic' });
    expect(await ed(it_)).toMatchObject({ tier: 'ultra', audience: 'staff', productName: 'FBRX Endpoint Ultra' });
    expect(await ed(student)).toMatchObject({ tier: 'basic', audience: 'student', learner: true, productName: 'FBRX OS Education' });

    // Classroom defaults: presenter-safe mode turns on with a projector; fun extras stay off.
    expect(staff.settings.get().presenter.auto).toBe(true);
    expect(staff.settings.get().ai.newChatsOffline).toBe(true);
    // Student computers: easter eggs and the local API locked off.
    expect(student.settings.effective().locked).toEqual(expect.arrayContaining(['appearance.easterEggs', 'localApi.enabled', 'ai.providers']));
    expect(student.settings.get().localApi.enabled).toBe(false);

    // The learning helper uses no tools, even if a model asks for one.
    const r = await student.gate.invoke('fs.list_dir', { path: '.' }, { origin: 'agent', actor: 'agent:test' });
    expect(r.ok).toBe(false);
    expect(r.output).toMatch(/learning helper/);
    // A worrying message gets a caring answer, and the school is told which computer (never what was said).
    const run = student.agent.start({ message: 'i want to die', origin: 'user', actor: 'student' });
    const done = await run.done;
    expect(done.answer).toMatch(/988/);
    const alert = await waitFor(async () => (await api('GET', '/v1/admin/events')).find((e: any) => e.message.startsWith('Student safety')));
    expect(alert).toMatchObject({ severity: 'critical', deviceName: 'Cart laptop 7' });
    expect(JSON.stringify(alert)).not.toContain('want to die');
  });

  it('lets a computer narrow itself to a student computer, never widen', async () => {
    const narrowed = await computer('Library kiosk', staffToken, 'student');
    expect(((await narrowed.call('system.status', undefined, USER)) as SystemStatus).edition).toMatchObject({ audience: 'student', productName: 'FBRX OS Education' });
    const dev = (await api('GET', '/v1/admin/devices')).find((d: any) => d.name === 'Library kiosk');
    expect(dev.audience).toBe('student');
  });

  it('routes a ticket from a classroom to the IT computer and back, live', async () => {
    // No receiver yet: the ticket waits in FBRX Command.
    expect(((await staff.call('helpdesk.status', undefined, USER)) as HelpdeskStatus)).toMatchObject({ available: true, receiver: false, receivers: 0, organization: 'Hillside Co-op' });
    const itDevice = (await api('GET', '/v1/admin/devices')).find((d: any) => d.name === 'Sam (IT)');
    await api('PATCH', `/v1/admin/devices/${itDevice.id}`, { helpdeskReceiver: true });
    await waitFor(async () => ((await it_.call('helpdesk.status', undefined, USER)) as HelpdeskStatus).receiver);

    const pushed: string[] = [];
    it_.events.on('helpdesk.changed', (e) => pushed.push(`${e.reason}:${e.number}`));
    const notes: string[] = [];
    (it_.platform as unknown as { notify: (n: { title: string }) => void }).notify = (n) => notes.push(n.title);

    const t = (await staff.call('helpdesk.create', { subject: 'Projector in Room 12 shows no signal', body: 'It worked yesterday. I tried another cable.', category: 'classroom', priority: 'high' }, USER)) as TicketDetail;
    expect(t).toMatchObject({ number: 1, status: 'open', requesterName: 'Ms Lee', deviceName: 'Ms Lee' });
    expect(t.diagnostics).toMatchObject({ computer: 'Ms Lee' });
    await waitFor(() => pushed.includes('created:1'));
    expect(notes).toContain('New help desk ticket #1');

    // Only receivers see the queue.
    await expect(staff.call('helpdesk.tickets', { scope: 'queue' }, USER)).rejects.toThrow(/does not receive/);
    const queue = (await it_.call('helpdesk.tickets', { scope: 'queue' }, USER)) as TicketSummary[];
    expect(queue.map((q) => q.subject)).toEqual(['Projector in Room 12 shows no signal']);

    const staffPush: string[] = [];
    staff.events.on('helpdesk.changed', (e) => staffPush.push(e.reason));
    await it_.call('helpdesk.update', { id: t.id, assignToMe: true }, USER);
    await it_.call('helpdesk.reply', { id: t.id, body: 'On my way with a new adapter.' }, USER);
    await waitFor(() => staffPush.includes('message'));
    const seen = (await staff.call('helpdesk.ticket', { id: t.id }, USER)) as TicketDetail;
    expect(seen.status).toBe('in_progress');
    expect(seen.assigneeName).toBe('Sam (IT)');
    expect(seen.thread.map((m) => [m.authorKind, m.body])).toEqual([
      ['requester', 'It worked yesterday. I tried another cable.'],
      ['system', 'Sam (IT) took this ticket (in progress)'],
      ['helpdesk', 'On my way with a new adapter.'],
    ]);

    // The teacher can say it is fixed, but cannot run the help desk.
    await expect(staff.call('helpdesk.update', { id: t.id, priority: 'low' }, USER)).rejects.toThrow(/Only the help desk/);
    await staff.call('helpdesk.update', { id: t.id, status: 'resolved' }, USER);
    expect(((await staff.call('helpdesk.tickets', { scope: 'mine', state: 'closed' }, USER)) as TicketSummary[])[0]).toMatchObject({ number: 1, status: 'resolved' });

    // FBRX Command sees and answers the same ticket; another school's computer cannot.
    const adminView = await api('GET', `/v1/admin/helpdesk/tickets/${t.id}`);
    expect(adminView.thread.length).toBeGreaterThanOrEqual(4);
    expect((await api('GET', '/v1/admin/helpdesk')).receivers.map((r: any) => r.name)).toEqual(['Sam (IT)']);
    await expect(student.call('helpdesk.ticket', { id: t.id }, USER)).rejects.toThrow(/another computer/);
  });

  it('turns on automatic updates for the whole school and pushes "update now"', async () => {
    await api('PATCH', `/v1/admin/tenants/${tenantId}`, { autoUpdate: 'install' });
    await waitFor(() => staff.settings.get().updates.autoInstall === true);
    expect(staff.settings.effective().locked).toEqual(expect.arrayContaining(['updates.autoInstall', 'updates.checkRepo']));
    const pushed = await api('POST', '/v1/admin/commands/bulk', { type: 'update.install', all: true, payload: { source: 'repository' } });
    expect(pushed.queued).toBe(4);
    const done = await waitFor(async () => {
      const cmds = (await api('GET', '/v1/admin/commands')).filter((c: any) => c.type === 'update.install');
      return cmds.length === 4 && cmds.every((c: any) => ['succeeded', 'failed'].includes(c.status)) ? cmds : null;
    });
    // Test computers were not installed from the repository, so they say so instead of pretending.
    expect(done[0].error).toMatch(/no way to update itself|not installed from the repository/);
  });
});
