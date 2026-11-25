import { createSocket } from 'node:dgram';
import { createServer } from 'node:http';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDERS, FbrxAlertSchema, type AgentEvent } from '@fbrx/shared';
import { verifyFbrxAlertSignature } from '@fbrx/shared/node';
import { makeKernel, waitFor, USER } from './helpers';
import { mockOpenAI } from './mock-llm';
import { calc, convert } from '../src/spotlight/spotlight';
import { staticAnalysis } from '../src/security/linkcheck';
import { encodeCommand, psq } from '../src/windows/ps';
import { parseWingetTable } from '../src/windows/updates';
import { vmCreateScript } from '../src/windows/lab';
import { cidrHosts, maskToPrefix } from '../src/network/netdiag';

const API = { origin: 'api' as const, actor: 'localapi:full' };

describe('workspace', () => {
  it('manages tasks, notes, projects and snippets', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      const proj = (await kernel.call('projects.save', { name: 'Launch', milestones: [{ title: 'Beta' }] }, USER)) as any;
      expect(proj.milestones[0].id).toMatch(/^ms_/);
      const t1 = (await kernel.call('tasks.save', { title: 'Write docs', projectId: proj.id, due: '2000-01-01' }, USER)) as any;
      await kernel.call('tasks.save', { title: 'Ship', priority: 'critical' }, USER);
      expect(t1.status).toBe('todo');
      const done = (await kernel.call('tasks.save', { id: t1.id, title: t1.title, status: 'done' }, USER)) as any;
      expect(done.completedAt).toBeTruthy();
      expect(done.projectId).toBe(proj.id);
      await kernel.call('notes.save', { title: 'Plan', content: 'Quarterly launch plan', projectId: proj.id }, USER);
      await kernel.call('notes.save', { title: 'Pinned', content: 'x', pinned: true }, USER);
      const notes = (await kernel.call('notes.list', {}, USER)) as any[];
      expect(notes[0].title).toBe('Pinned');
      expect(((await kernel.call('notes.list', { query: 'quarterly' }, USER)) as any[]).map((n) => n.title)).toEqual(['Plan']);
      await kernel.call('snippets.save', { title: 'Flush DNS', language: 'powershell', content: 'ipconfig /flushdns' }, USER);
      expect(((await kernel.call('snippets.list', { query: 'flush' }, USER)) as any[]).length).toBe(1);

      const summary = ((await kernel.call('projects.list', undefined, USER)) as any[])[0];
      expect(summary).toMatchObject({ tasks: 1, done: 1, notes: 1, overdue: 0 });
      await expect(kernel.call('tasks.save', { title: 'Bad date', due: 'tomorrow' }, USER)).rejects.toThrow();

      // Deleting a project keeps its items unless asked to cascade.
      await kernel.call('projects.delete', { id: proj.id }, USER);
      expect(((await kernel.call('tasks.list', {}, USER)) as any[]).find((t) => t.id === t1.id).projectId).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it('lets the agent manage tasks without approval (built-in workspace rule)', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      const r = await kernel.gate.invoke('workspace.add_task', { title: 'From the agent', priority: 'high' }, { origin: 'agent', actor: 'agent:test' });
      expect(r.ok).toBe(true);
      expect(kernel.workspace.listTasks()[0]).toMatchObject({ title: 'From the agent', priority: 'high' });
    } finally {
      await cleanup();
    }
  });
});

describe('spotlight', () => {
  it('calculates and converts without eval', () => {
    expect(calc('2+3*4')).toBe(14);
    expect(calc('(1+2)^2 / 3')).toBe(3);
    expect(calc('sqrt(16) + 10%')).toBeCloseTo(4.1);
    expect(calc('process.exit()')).toBeNull();
    expect(calc('hello')).toBeNull();
    expect(convert('5 km to mi')!.value).toBeCloseTo(3.10686, 4);
    expect(convert('100 f to c')!.value).toBeCloseTo(37.7778, 3);
    expect(convert('1 gib in mb')!.value).toBeCloseTo(1073.741824, 5);
    expect(convert('3 apples to pears')).toBeNull();
  });

  it('finds pages and workspace items and refuses unsafe launches', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      await kernel.call('notes.save', { title: 'Quarterly numbers', content: 'Revenue up' }, USER);
      const items = (await kernel.call('spotlight.query', { q: 'quarterly' }, USER)) as any[];
      expect(items.some((i) => i.kind === 'note' && i.title === 'Quarterly numbers')).toBe(true);
      const calcItems = (await kernel.call('spotlight.query', { q: '12*12' }, USER)) as any[];
      expect(calcItems[0]).toMatchObject({ kind: 'calc', title: '= 144' });
      const pages = (await kernel.call('spotlight.query', { q: 'network' }, USER)) as any[];
      expect(pages.find((i) => i.kind === 'page')?.action).toEqual({ type: 'nav', route: 'network' });

      const run = (action: unknown) => kernel.call('spotlight.run', { item: { id: 'x', kind: 'web', title: 'x', score: 0, action } }, USER);
      await expect(run({ type: 'url', url: 'file:///etc/passwd' })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
      await expect(run({ type: 'app', appId: 'tool:not-a-tool' })).rejects.toBeTruthy();
      await expect(run({ type: 'open', path: '/definitely/missing' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(await run({ type: 'nav', route: 'tasks' })).toMatchObject({ navigate: 'tasks' });
      // Running Spotlight items is reserved for the person at the workstation.
      await expect(kernel.call('spotlight.run', { item: { id: 'x', kind: 'page', title: 'x', score: 0, action: { type: 'nav', route: 'x' } } }, API)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      await cleanup();
    }
  });
});

describe('alerts', () => {
  it('stores, cools down and routes alerts to a webhook', async () => {
    const received: any[] = [];
    const hook = createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        received.push(JSON.parse(b));
        res.end('ok');
      });
    });
    await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
    const { kernel, cleanup } = await makeKernel();
    try {
      kernel.settings.update({ alerts: { routing: { warning: ['inbox', 'webhook', 'organisation'] }, channels: { desktop: false, webhook: { enabled: true, url: `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`, format: 'slack' } } } });
      const a = await kernel.alerts.fire('cpu_high', 'CPU busy', 'Average 97%');
      expect(a?.deliveries).toMatchObject({ inbox: 'ok', webhook: 'ok', organisation: 'not enrolled' });
      expect(received[0].text).toContain('*CPU busy*');
      expect(await kernel.alerts.fire('cpu_high', 'CPU busy', 'again')).toBeNull(); // cooldown
      expect(await kernel.alerts.fire('mesh_online', 'x', 'y')).toBeNull(); // rule off by default
      expect((await kernel.call('alerts.counts', undefined, USER)) as any).toEqual({ unread: 1, critical: 0 });
      await kernel.call('alerts.markRead', { id: '*' }, USER);
      expect(((await kernel.call('alerts.inbox', { unreadOnly: true }, USER)) as any[]).length).toBe(0);

      // Rules can be switched off and thresholds changed in settings.
      kernel.settings.update({ alerts: { rules: { disk_low: { enabled: false, threshold: 5 } } } });
      expect(kernel.alerts.rules().find((r) => r.id === 'disk_low')).toMatchObject({ enabled: false, threshold: 5 });

      // Quiet hours hold back desktop notifications that are not critical.
      const now = new Date();
      const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      kernel.settings.update({ alerts: { routing: { warning: ['inbox', 'desktop'] }, channels: { desktop: true, webhook: { enabled: false } }, quietHours: { enabled: true, start: hhmm(new Date(now.getTime() - 3600_000)), end: hhmm(new Date(now.getTime() + 3600_000)) } } });
      const q = await kernel.alerts.fire('mem_high', 'Memory', 'full');
      expect(q?.deliveries.desktop).toBe('held (quiet hours)');
    } finally {
      await cleanup();
      hook.close();
    }
  });

  it('tells the outside about a problem once, then its all-clear, as signed FBRX Alerts', async () => {
    const got: Array<{ body: string; sig: string }> = [];
    const hook = createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        got.push({ body: b, sig: String(req.headers['fbrx-signature']) });
        res.end('ok');
      });
    });
    await new Promise<void>((r) => hook.listen(0, '127.0.0.1', () => r()));
    const udp = createSocket('udp4');
    const lines: string[] = [];
    udp.on('message', (m) => lines.push(m.toString()));
    await new Promise<void>((r) => udp.bind(0, '127.0.0.1', () => r()));
    const { kernel, cleanup } = await makeKernel();
    try {
      kernel.vault.set({ name: 'HOOK_SECRET', value: 'shh-secret' });
      kernel.settings.update({
        alerts: {
          cooldownMinutes: 1,
          routing: { info: ['inbox', 'webhook'], warning: ['inbox', 'webhook', 'syslog'], critical: ['inbox', 'webhook'] },
          channels: { desktop: false, mobile: false, webhook: { enabled: true, url: `http://127.0.0.1:${(hook.address() as AddressInfo).port}/alerts`, format: 'fbrx', secretName: 'HOOK_SECRET' }, syslog: { enabled: true, host: '127.0.0.1', port: udp.address().port, protocol: 'udp' } },
        },
      });
      const a = await kernel.alerts.fire('disk_low', 'Drive D: is running out of space', '2 GB free', { key: 'D:' });
      expect(a?.deliveries).toMatchObject({ webhook: 'ok', syslog: 'ok' });
      const first = FbrxAlertSchema.parse(JSON.parse(got[0]!.body));
      expect(first).toMatchObject({ state: 'open', rule: 'disk_low', severity: 'warning', source: { app: 'fbrx-os' }, detail: '2 GB free' });
      expect(first.key).toMatch(/\|disk_low\|D:$/);
      expect(verifyFbrxAlertSignature(got[0]!.body, got[0]!.sig, 'shh-secret')).toBe(true);
      // A reminder stays on this computer: the outside heard about it once.
      (kernel.alerts as unknown as { last: Map<string, number> }).last.clear();
      const again = await kernel.alerts.fire('disk_low', 'Drive D: is running out of space', '1 GB free', { key: 'D:' });
      expect(again?.deliveries.inbox).toBe('ok');
      expect(again?.deliveries.webhook).toBeUndefined();
      expect(got.length).toBe(1);
      // Over: the same key, resolved, to where the alert went.
      expect(kernel.alerts.clear('disk_low', 'D:')).toBe(true);
      await waitFor(() => got.length === 2 && lines.length === 2);
      const clear = FbrxAlertSchema.parse(JSON.parse(got[1]!.body));
      expect(clear).toMatchObject({ key: first.key, state: 'resolved', startedAt: first.startedAt });
      expect(clear.endedAt).toBeTruthy();
      expect(lines[1]).toContain('All clear: Drive D: is running out of space');
      expect(kernel.alerts.clear('disk_low', 'D:')).toBe(false);
      // Something that just happened is an event, with no all-clear to come.
      await kernel.alerts.fire('shield_threat', 'FBRX Shield found a threat', 'invoice.pdf.exe', { key: 'f1' });
      expect(FbrxAlertSchema.parse(JSON.parse(got[2]!.body)).state).toBe('event');
      // The internet coming back is net_down's all-clear, not news of its own.
      await kernel.alerts.fire('net_down', 'Internet connection lost', 'FBRX OS cannot reach the internet.');
      expect(got.length).toBe(4);
      const back = await kernel.alerts.fire('net_restored', 'Internet connection restored', 'Back online after about 3 minute(s).');
      expect(back?.deliveries.webhook).toBeUndefined();
      kernel.alerts.clear('net_down');
      await waitFor(() => got.length === 5);
      expect(JSON.parse(got[4]!.body)).toMatchObject({ rule: 'net_down', state: 'resolved', title: 'Internet connection lost' });
    } finally {
      await cleanup();
      hook.close();
      udp.close();
    }
  });

  it('says a lasting condition once a day at most, even after a restart, and takes it away when it is over', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      kernel.settings.update({ alerts: { cooldownMinutes: 1, channels: { desktop: false } } });
      expect(await kernel.alerts.fire('av_problem', 'FBRX Shield needs attention', 'The threat database is more than a week old.', { key: 'shield:The threat database is more than a week old.' })).not.toBeNull();
      // A restart forgets the cooldown; the condition is still not said again the same day.
      (kernel.alerts as unknown as { last: Map<string, number> }).last.clear();
      expect(await kernel.alerts.fire('av_problem', 'FBRX Shield needs attention', 'The threat database is more than a week old.', { key: 'shield:The threat database is more than a week old.' })).toBeNull();
      // Clearing the inbox does not bring it back either.
      await kernel.call('alerts.delete', { id: '*' }, USER);
      expect(await kernel.alerts.fire('av_problem', 'x', 'y', { key: 'shield:The threat database is more than a week old.' })).toBeNull();
      // Over: its alerts go, and if it comes back it is said at once.
      await kernel.alerts.fire('av_problem', 'FBRX Shield needs attention', 'Download checks are off.', { key: 'shield:Download checks are off.' });
      expect(kernel.alerts.settle('av_problem', [])).toBe(1);
      expect(((await kernel.call('alerts.inbox', {}, USER)) as unknown[]).length).toBe(0);
      expect(await kernel.alerts.fire('av_problem', 'FBRX Shield needs attention', 'The threat database is more than a week old.', { key: 'shield:The threat database is more than a week old.' })).not.toBeNull();
    } finally {
      await cleanup();
    }
  });
});

describe('command-center API guards', () => {
  it('keeps automation out of the computer-changing methods and outside allowed folders', async () => {
    const { kernel, sandbox, cleanup } = await makeKernel();
    try {
      writeFileSync(join(sandbox, 'ok.txt'), 'hello');
      expect(((await kernel.call('files.read', { path: join(sandbox, 'ok.txt') }, API)) as any).content).toBe('hello');
      await expect(kernel.call('files.read', { path: join(kernel.paths.root, 'fbrx.db') }, API)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      for (const [m, p] of [
        ['terminal.run', { command: 'whoami' }],
        ['files.write', { path: join(sandbox, 'x'), content: 'x' }],
        ['processes.kill', { pid: 99999 }],
        ['mesh.startPairing', {}],
        ['bugs.fix', { id: 'flushdns' }],
        ['security.setFirewall', { profile: 'Public', enabled: false }],
        ['aicoord.install', { appId: 'cursor' }],
      ] as const) {
        await expect(kernel.call(m, p, API), m).rejects.toMatchObject({ code: 'FORBIDDEN' });
      }
      // Reads used by dashboards are not audited; changes are.
      await kernel.call('sysinfo.live', undefined, USER);
      await kernel.call('tasks.save', { title: 'Audited' }, USER);
      const actions = kernel.audit.query({ category: 'api', limit: 20 }).map((e) => e.action);
      expect(actions).toContain('tasks.save');
      expect(actions).not.toContain('sysinfo.live');
    } finally {
      await cleanup();
    }
  });

  it('runs terminal commands for the user and streams output', async () => {
    const { kernel, sandbox, cleanup } = await makeKernel();
    try {
      const out: string[] = [];
      kernel.events.on('terminal.output', (e) => out.push(e.text));
      const exit = new Promise<number | null>((r) => kernel.events.on('terminal.exit', (e) => r(e.code)));
      await kernel.call('terminal.run', { command: 'echo fbrx-terminal-ok', cwd: sandbox }, USER);
      expect(await exit).toBe(0);
      expect(out.join('')).toContain('fbrx-terminal-ok');
    } finally {
      await cleanup();
    }
  });
});

describe('offline chats', () => {
  async function setup(decision: 'approve' | 'deny') {
    const tcp = createTcpServer((s) => s.end());
    await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', () => r()));
    const port = (tcp.address() as AddressInfo).port;
    const { kernel, cleanup } = await makeKernel();
    const llm = await mockOpenAI((body, turn) => {
      if (turn === 0) return { tool: { name: 'net__port_check', args: { host: '127.0.0.1', port } } };
      const tool = body.messages.find((m: any) => m.role === 'tool');
      return { text: `Tool said: ${tool.content}` };
    });
    kernel.settings.update({ ai: { defaultProvider: 'mock', defaultModel: 'm', providers: [...DEFAULT_PROVIDERS, { id: 'mock', type: 'openai-compatible', name: 'Mock', enabled: true, baseUrl: `${llm.url}/v1`, cloud: false }] } });
    const events: AgentEvent[] = [];
    kernel.events.on('agent', (e) => events.push(e));
    const { conversationId } = (await kernel.call('ai.chat', { message: 'Is my port open?' }, USER)) as any;
    expect(kernel.conversations.isOffline(conversationId)).toBe(true);
    const approval = await waitFor(() => kernel.approvals.list()[0]);
    expect(approval.toolTitle).toBe('Go online: Check port');
    kernel.approvals.resolve(approval.id, decision, 'test-user');
    await waitFor(() => events.find((e) => e.type === 'run.completed'));
    return { kernel, conversationId, events, close: async () => (await llm.close(), tcp.close(), await cleanup()) };
  }

  it('asks to go online before the first internet tool and switches the chat online', async () => {
    const { kernel, conversationId, events, close } = await setup('approve');
    try {
      expect(kernel.conversations.isOffline(conversationId)).toBe(false);
      expect(events.some((e) => e.type === 'mode.changed' && !e.offline)).toBe(true);
      const conv = kernel.conversations.get(conversationId);
      expect(conv.messages.find((m) => m.role === 'tool')!.content).toContain('is open');
    } finally {
      await close();
    }
  });

  it('keeps the chat offline when the user says no', async () => {
    const { kernel, conversationId, close } = await setup('deny');
    try {
      expect(kernel.conversations.isOffline(conversationId)).toBe(true);
      expect(kernel.conversations.get(conversationId).messages.find((m) => m.role === 'tool')!.content).toContain('chat is offline');
    } finally {
      await close();
    }
  });
});

describe('link check (static analysis)', () => {
  const sev = (u: string) => staticAnalysis(u).findings;
  it('flags look-alikes, raw IPs, punycode and @ tricks', () => {
    expect(sev('https://paypa1.com/verify').some((f) => f.severity === 'critical' && /Look-alike of "paypal"/.test(f.text))).toBe(true);
    expect(sev('https://paypal-login.example.net/').some((f) => f.severity === 'critical' && /Mentions "paypal"/.test(f.text))).toBe(true);
    expect(sev('http://192.168.1.1/admin').some((f) => /raw IP/.test(f.text))).toBe(true);
    expect(sev('https://xn--pple-43d.com').some((f) => /punycode/.test(f.text))).toBe(true);
    expect(sev('https://www.microsoft.com@evil.example/x').some((f) => /"@"/.test(f.text))).toBe(true);
    expect(sev('https://login.microsoftonline.com/').some((f) => f.severity === 'ok')).toBe(true);
    expect(sev('hxxps://bit[.]ly/abc').some((f) => /shortener/.test(f.text))).toBe(true);
    expect(() => staticAnalysis('http://')).toThrow();
  });
});

describe('Windows helpers (pure)', () => {
  it('quotes PowerShell strings and encodes commands', () => {
    expect(psq("it's")).toBe("'it''s'");
    expect(psq('a\u2019b')).toBe("'a\u2019\u2019b'");
    expect(Buffer.from(encodeCommand('Write-Output "hi"'), 'base64').toString('utf16le')).toBe('Write-Output "hi"');
  });

  it('parses winget upgrade tables', () => {
    const out = [
      'Name                 Id                    Version  Available Source',
      '---------------------------------------------------------------------',
      'Mozilla Firefox      Mozilla.Firefox       129.0    130.0.1   winget',
      'Notepad++            Notepad++.Notepad++   8.6.9    8.7       winget',
      '2 upgrades available.',
    ].join('\r\n');
    expect(parseWingetTable(out)).toEqual([
      { name: 'Mozilla Firefox', id: 'Mozilla.Firefox', current: '129.0', available: '130.0.1', source: 'winget' },
      { name: 'Notepad++', id: 'Notepad++.Notepad++', current: '8.6.9', available: '8.7', source: 'winget' },
    ]);
  });

  it('builds VM scripts with sanitized names and clamped resources', () => {
    const s = vmCreateScript({ name: "evil'; Remove-Item C:\\ -Recurse #", os: 'linux', cpus: 99, memoryGB: 500, diskGB: 1, network: 'isolated', hardened: true });
    expect(s).toContain("$name='evil Remove-Item C -Recurse'");
    expect(s).toContain('-Count 32');
    expect(s).toContain('-MemoryStartupBytes 64GB');
    expect(s).toContain('-NewVHDSizeBytes 10GB');
    expect(s).toContain("New-VMSwitch -Name 'FBRX-Isolated' -SwitchType Private");
    expect(s).toContain('MicrosoftUEFICertificateAuthority');
  });

  it('expands subnets within safe sizes', () => {
    expect(cidrHosts('192.168.1.7/30')).toEqual({ hosts: ['192.168.1.5', '192.168.1.6'], label: '192.168.1.4/30' });
    expect(cidrHosts('10.0.0.0/22').hosts.length).toBe(1022);
    expect(() => cidrHosts('10.0.0.0/16')).toThrow();
    expect(maskToPrefix('255.255.255.0')).toBe(24);
  });
});
