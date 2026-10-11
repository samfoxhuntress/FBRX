import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ApprovalRequest, AssistJob, HelpdeskStatus, MessagesOverview, SystemStatus, ThreadMessage, TicketDetail, TicketSummary } from '@fbrx/shared';
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
    k.settings.update({ localApi: { enabled: false }, runtime: { enabled: false }, protection: { shield: { updateSignatures: false } }, profile: { name } });
    await k.start();
    // The background monitor and alert checks only add load here (PowerShell on Windows).
    k.alerts.stop();
    k.monitor.stop();
    k.protection.stop();
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

  it('lets the family message each other in Messages, without the help desk', async () => {
    const parentId = parent.fleet.deviceId!;
    const childId = child.fleet.deviceId!;
    const overview = (k: Kernel) => k.call('messages.overview', undefined, USER) as Promise<MessagesOverview>;
    const o = await overview(child);
    expect(o.org).toMatchObject({ on: true, name: 'The Rivera family' });
    expect(o.threads.map((t) => t.id)).toEqual(expect.arrayContaining(['org:all', `org:${parentId}`]));
    expect(o.threads.find((t) => t.id === `org:${parentId}`)).toMatchObject({ title: 'Alex laptop', kind: 'direct', online: true });

    // One computer to another: it arrives at once, unread, with a notification.
    const notes: string[] = [];
    parent.events.on('notification', (n) => n.source === 'messages' && notes.push(`${n.title}|${n.open}`));
    const sent = (await child.call('messages.send', { id: `org:${parentId}`, text: 'Can I play for ten more minutes?' }, USER)) as ThreadMessage;
    expect(sent).toMatchObject({ mine: true, threadId: `org:${parentId}`, fromName: 'Milo laptop' });
    await waitFor(() => notes.length > 0);
    expect(notes[0]).toBe(`Milo laptop|messages/org:${childId}`);
    const p = await overview(parent);
    expect(p.threads.find((t) => t.id === `org:${childId}`)).toMatchObject({ unread: 1, last: { text: 'Can I play for ten more minutes?', mine: false } });
    expect((await parent.call('messages.unread', undefined, USER)) as { unread: number }).toEqual({ unread: 1 });
    const thread = (await parent.call('messages.thread', { id: `org:${childId}` }, USER)) as ThreadMessage[];
    expect(thread.map((m) => [m.fromName, m.mine, m.text])).toEqual([['Milo laptop', false, 'Can I play for ten more minutes?']]);

    // Read on screen: no pop-up for the open conversation, and the count clears.
    await parent.call('messages.focus', { id: `org:${childId}` }, USER);
    expect((await overview(parent)).unread).toBe(0);
    await parent.call('messages.send', { id: `org:${childId}`, text: 'Five, then dinner.' }, USER);
    await child.call('messages.send', { id: `org:${parentId}`, text: 'OK!' }, USER);
    await waitFor(async () => ((await parent.call('messages.thread', { id: `org:${childId}` }, USER)) as ThreadMessage[]).length === 3);
    expect(notes).toHaveLength(1);
    expect((await overview(parent)).unread).toBe(0);
    await parent.call('messages.focus', { id: null }, USER);

    // A parent in FBRX Command writes to everyone.
    const posted = await api('POST', '/v1/admin/chat/messages', { text: 'Pizza night!' });
    expect(posted).toMatchObject({ with: 'all', fromKind: 'admin', fromName: 'Alex' });
    const all = await waitFor(async () => ((await child.call('messages.thread', { id: 'org:all' }, USER)) as ThreadMessage[]).find((m) => m.text === 'Pizza night!'));
    expect(all).toMatchObject({ fromAdmin: true, mine: false });
    expect((await api('GET', '/v1/admin/chat/messages')).messages.map((m: any) => m.text)).toEqual(['Pizza night!']);

    // The family can turn it off.
    await api('PATCH', `/v1/admin/tenants/${tenantId}`, { chatEnabled: false });
    expect((await overview(child)).org).toMatchObject({ on: false, note: 'Your organization has turned off messages between computers' });
    await expect(child.call('messages.send', { id: `org:${parentId}`, text: 'Hello?' }, USER)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await api('PATCH', `/v1/admin/tenants/${tenantId}`, { chatEnabled: true });
  }, 60_000);

  it("lets a parent work on the child's computer from a request for help", async () => {
    const t = (await child.call('helpdesk.create', { subject: 'Wi-Fi keeps dropping', body: 'It drops every few minutes.', category: 'network', priority: 'normal' }, USER)) as TicketDetail;
    await waitFor(async () => ((await parent.call('helpdesk.tickets', { scope: 'queue' }, USER)) as TicketSummary[]).some((q) => q.id === t.id));
    const jobs = async () => (await parent.call('helpdesk.assistJobs', { ticketId: t.id }, USER)) as AssistJob[];
    const asked: ApprovalRequest[] = [];
    child.events.on('approval.requested', (a) => asked.push(a));

    // The child's computer asks once before the help desk may look; saying yes lets the check run.
    const job = (await parent.call('helpdesk.assist', { ticketId: t.id, action: 'diagnostics' }, USER)) as AssistJob;
    expect(job).toMatchObject({ action: 'diagnostics', ticketId: t.id });
    await waitFor(() => asked.some((a) => a.tool === 'helpdesk.assist'));
    expect(asked[0].toolTitle).toBe('Let Alex laptop from the help desk work on this computer');
    child.approvals.resolve(asked[0].id, 'approve', 'Milo');
    // A real look at the computer (processes, antivirus, disks): seconds on a busy Windows runner.
    const done = await waitFor(async () => (await jobs()).find((j) => j.id === job.id && j.status === 'succeeded'), 40_000);
    expect(done!.result).toMatchObject({ computer: 'Milo laptop', busiestApps: expect.any(Array) });

    // Each command still asks.
    const cmd = (await parent.call('helpdesk.assist', { ticketId: t.id, action: 'run', text: 'echo hello-from-the-help-desk' }, USER)) as AssistJob;
    await waitFor(() => asked.some((a) => a.tool === 'shell.run'));
    expect(asked.filter((a) => a.tool === 'helpdesk.assist')).toHaveLength(1);
    child.approvals.resolve(asked.find((a) => a.tool === 'shell.run')!.id, 'approve', 'Milo');
    const ran = await waitFor(async () => (await jobs()).find((j) => j.id === cmd.id && j.status === 'succeeded'));
    expect(ran!.result).toMatchObject({ ok: true, output: expect.stringContaining('hello-from-the-help-desk') });

    // A command the child turns down does not run.
    const no = (await parent.call('helpdesk.assist', { ticketId: t.id, action: 'run', text: 'echo nope' }, USER)) as AssistJob;
    await waitFor(() => asked.filter((a) => a.tool === 'shell.run').length === 2);
    child.approvals.resolve(asked.filter((a) => a.tool === 'shell.run')[1].id, 'deny', 'Milo');
    expect((await waitFor(async () => (await jobs()).find((j) => j.id === no.id && j.status === 'succeeded')))!.result).toMatchObject({ ok: false, status: 'denied' });

    // The ticket says what was done, for everyone following it.
    const thread = ((await parent.call('helpdesk.ticket', { id: t.id }, USER)) as TicketDetail).thread.map((m) => m.body);
    expect(thread).toEqual(expect.arrayContaining(['Alex laptop checked how Milo laptop is doing', 'Alex laptop ran a command on Milo laptop: echo hello-from-the-help-desk']));

    // Turned off on the child's computer: refused, with why.
    child.settings.update({ helpdesk: { assist: 'off' } });
    const off = (await parent.call('helpdesk.assist', { ticketId: t.id, action: 'diagnostics' }, USER)) as AssistJob;
    const refused = await waitFor(async () => (await jobs()).find((j) => j.id === off.id && j.status === 'failed'));
    expect(refused!.error).toMatch(/does not let the help desk work on it/);
    // Only the help desk may ask.
    await expect(child.call('helpdesk.assist', { ticketId: t.id, action: 'diagnostics' }, USER)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  }, 120_000);

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
