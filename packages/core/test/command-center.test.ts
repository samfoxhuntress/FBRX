import { createServer } from 'node:http';
import { createServer as createTcpServer, type AddressInfo } from 'node:net';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDERS, type AgentEvent } from '@fbrx/shared';
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

  it('builds VM scripts with sanitised names and clamped resources', () => {
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
