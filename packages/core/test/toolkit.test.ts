import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDERS, toolkitToolName, type ToolkitAction } from '@fbrx/shared';
import { fillCommand, looksOnly, usesNetwork } from '../src/ai/toolkit';
import { TOOLKIT_LIBRARY } from '../src/ai/toolkit-library';
import { makeKernel, waitFor, USER } from './helpers';
import { mockOpenAI } from './mock-llm';

describe('AI Toolkit commands', () => {
  it('puts inputs in quoted, so a value never becomes a command', () => {
    const inputs = [
      { name: 'host', label: 'Host', kind: 'host' as const },
      { name: 'adapter', label: 'Adapter', kind: 'name' as const },
      { name: 'port', label: 'Port', kind: 'number' as const },
    ];
    expect(fillCommand('nc -vz {{host}} {{port}}', inputs, { host: 'example.com', port: '443' }, 'linux')).toBe("nc -vz 'example.com' 443");
    expect(fillCommand('ipconfig /renew {{adapter}}', inputs, { adapter: "Bob's Wi-Fi" }, 'windows')).toBe("ipconfig /renew 'Bob''s Wi-Fi'");
    expect(fillCommand('x {{adapter}}', inputs, { adapter: "it's" }, 'linux')).toBe(`x 'it'\\''s'`);
    expect(() => fillCommand('ping {{host}}', inputs, { host: 'a.com; rm -rf ~' }, 'linux')).toThrow(/host name or an IP/);
    expect(() => fillCommand('x {{port}}', inputs, { port: '22 && reboot' }, 'linux')).toThrow(/whole number/);
    expect(() => fillCommand('x {{nope}}', inputs, {}, 'linux')).toThrow(/not one of its inputs/);
  });

  it('tells a command that only looks from one that changes something', () => {
    for (const c of ['ipconfig', 'ipconfig /all', 'ip -brief address show; ip route show default', 'Get-NetAdapter | Format-Table Name, Status', 'nslookup example.com 2>&1', 'netsh wlan show interfaces', 'arp -a', 'nmcli device status']) expect(looksOnly(c), c).toBe(true);
    for (const c of ['ipconfig /release', 'ipconfig /flushdns', 'ip addr add 10.0.0.2/24 dev eth0', 'rm -rf /tmp/x', 'echo hi > /etc/hosts', 'Set-NetIPInterface -Dhcp Enabled', 'netsh interface set interface Wi-Fi disable', 'sudo ip link', 'nmcli connection up home', 'cat $(whoami)', 'cat ~/.ssh/id_rsa', 'Get-Content $HOME\\notes.txt', 'grep -r password ~', 'netsh wlan show profile name=Home key=clear', 'nmcli -s connection show Home', 'arp -a | sed -i s/a/b/ x']) expect(looksOnly(c), c).toBe(false);
    expect(looksOnly('ipconfig /all | findstr IPv4'), 'a filter after a pipe').toBe(true);
  });

  it('tells a command that reaches the network from one that stays on this computer', () => {
    for (const c of ['ping -c 2 1.1.1.1', 'tracert -d {{host}}', 'nslookup example.com', 'dig +short example.com', 'getent ahosts example.com', 'nc -vz -G 4 h 22', "timeout 5 bash -c 'exec 3<>/dev/tcp/$0/$1' h 22", 'Test-NetConnection h -Port 443', 'Resolve-DnsName example.com', 'curl -s https://example.com', 'wget -qO- x', 'iwr https://example.com', 'Invoke-RestMethod https://example.com', 'traceroute -n h 2>/dev/null || tracepath -n h', 'PING.EXE 1.1.1.1', 'ssh admin@router'])
      expect(usesNetwork(c), c).toBe(true);
    for (const c of ['ipconfig', 'ip -brief address show', 'arp -a', 'netstat -an', 'Get-NetAdapter | Format-Table Name, NameHost', 'hostname', 'df -h', 'resolvectl dns', '$host.UI.RawUI', 'nmcli device status', 'du -sh * | sort -h'])
      expect(usesNetwork(c), c).toBe(false);
    // The library says so for its own, and agrees with the commands.
    const flagged = TOOLKIT_LIBRARY.filter((l) => l.network).map((l) => l.tool);
    expect(flagged.sort()).toEqual(['kit.check_the_internet', 'kit.is_a_port_open', 'kit.look_up_a_name', 'kit.trace_the_route']);
    expect(TOOLKIT_LIBRARY.filter((l) => Object.values(l.commands).some((c) => c && usesNetwork(c))).map((l) => l.tool).sort()).toEqual(flagged.sort());
  });

  it('names each action as a tool of its own', () => {
    expect(toolkitToolName('My IP address')).toBe('kit.my_ip_address');
    expect(toolkitToolName('Wi-Fi 6 check!')).toBe('kit.wi_fi_check');
    expect(toolkitToolName('My IP address', ['kit.my_ip_address'])).toBe('kit.my_ip_address_b');
  });
});

describe.runIf(process.platform === 'linux')('AI Toolkit', () => {
  it('runs library actions as tools, and runs them your way once you change them', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      const { actions, system } = (await kernel.call('toolkit.list', undefined, USER)) as { actions: ToolkitAction[]; system: string };
      expect(system).toBe('linux');
      expect(actions.map((a) => a.kit)).toEqual(expect.arrayContaining(['Networking', 'This computer', 'Troubleshooting']));
      const ip = actions.find((a) => a.tool === 'kit.my_ip_address')!;
      expect(ip).toMatchObject({ source: 'library', ask: false, changed: false });
      expect(kernel.registry.get('kit.my_ip_address')?.risk).toBe('read');
      expect(kernel.registry.get('kit.set_a_fixed_address')?.risk).toBe('execute');
      expect(kernel.registry.get('kit.check_the_internet')?.risk).toBe('network');
      expect(kernel.toolkit.match('Fabrix, what is my IP address?')[0].tool).toBe('kit.my_ip_address');

      // Too much? Change it: the tool runs the new command at once, and Reset puts FBRX's back.
      await kernel.call('toolkit.save', { id: ip.id, name: 'My IP address', commands: { linux: 'echo basic-ip-only' } }, USER);
      const r = (await kernel.call('tools.invoke', { name: 'kit.my_ip_address', input: {} }, USER)) as { ok: boolean; output: string };
      expect(r).toMatchObject({ ok: true, output: 'basic-ip-only' });
      expect(kernel.toolkit.get(ip.id)).toMatchObject({ changed: true, uses: 1 });
      expect((await kernel.call('toolkit.reset', { id: ip.id }, USER)) as ToolkitAction).toMatchObject({ changed: false, commands: { linux: expect.stringContaining('ip -brief address') } });

      // Off means off: the tool is gone until it is turned back on. Library actions are not removed.
      await kernel.call('toolkit.setEnabled', { id: ip.id, enabled: false }, USER);
      expect(kernel.registry.get('kit.my_ip_address')).toBeUndefined();
      await kernel.call('toolkit.setEnabled', { id: ip.id, enabled: true }, USER);
      expect(kernel.registry.get('kit.my_ip_address')).toBeDefined();
      await expect(kernel.call('toolkit.remove', { id: ip.id }, USER)).rejects.toThrow(/turned off or reset/);
      // Only the person at the computer changes the toolkit (not another app on the Local API).
      await expect(kernel.call('toolkit.save', { name: 'Sneaky', commands: { linux: 'id' }, ask: false }, { origin: 'api', actor: 'script' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    } finally {
      await cleanup();
    }
  });

  it('builds new actions with inputs: one that only looks runs straight away, one that changes things asks', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      const built = (await kernel.call('tools.invoke', { name: 'toolkit.build', input: { name: 'Say hello', when: 'The person wants a greeting for someone', command: 'echo hello {{who}}', inputs: [{ name: 'who', label: 'Who to greet', kind: 'name' }], changes: false } }, USER)) as { ok: boolean; output: string };
      expect(built.output).toMatch(/as kit\.say_hello/);
      const a = kernel.toolkit.get('kit.say_hello');
      expect(a).toMatchObject({ source: 'built', kit: 'Built by Fabrix', ask: false, inputs: [{ name: 'who' }] });
      expect((await kernel.call('tools.invoke', { name: 'kit.say_hello', input: { who: 'Sam Fox' } }, USER)) as { output: string }).toMatchObject({ output: 'hello Sam Fox' });
      const bad = (await kernel.call('tools.invoke', { name: 'kit.say_hello', input: { who: 'x; reboot' } }, USER)) as { ok: boolean; output: string };
      expect(bad.ok).toBe(false);
      // Fabrix says it only looks, but the command writes a file: it asks first anyway.
      await kernel.call('tools.invoke', { name: 'toolkit.build', input: { name: 'Note the time', when: 'Write the time down', command: 'date > /tmp/fbrx-time.txt', changes: false } }, USER);
      expect(kernel.registry.get('kit.note_the_time')?.risk).toBe('execute');
      // An input no command uses, or a command using an input that is not there, is caught.
      expect(((await kernel.call('tools.invoke', { name: 'toolkit.build', input: { name: 'Broken', when: 'x', command: 'echo {{what}}', changes: false } }, USER)) as { output: string }).output).toMatch(/add an input named what/);
    } finally {
      await cleanup();
    }
  });

  it('puts a change back unless the person keeps it', async () => {
    const { kernel, sandbox, cleanup } = await makeKernel();
    try {
      const file = join(sandbox, 'mode.txt');
      const a = (await kernel.call('toolkit.save', { name: 'Switch mode', commands: { linux: `echo fixed > '${file}'` }, undo: { seconds: 20, commands: { linux: `echo automatic > '${file}'` } } }, USER)) as ToolkitAction;
      expect(a).toMatchObject({ source: 'yours', kit: 'Mine', ask: true, undo: { seconds: 20 } });
      // Not kept: put back.
      const run = kernel.call('tools.invoke', { name: a.tool, input: {} }, USER) as Promise<{ output: string }>;
      await waitFor(() => kernel.approvals.list().length === 1);
      expect(readFileSync(file, 'utf8').trim()).toBe('fixed');
      const keep = kernel.approvals.list()[0];
      expect(keep.toolTitle).toBe('Keep the change: Switch mode');
      kernel.approvals.resolve(keep.id, 'deny', 'test-user');
      expect((await run).output).toMatch(/Not kept, so FBRX put it back/);
      expect(readFileSync(file, 'utf8').trim()).toBe('automatic');
      // Kept: stays.
      const again = kernel.call('tools.invoke', { name: a.tool, input: {} }, USER) as Promise<{ output: string }>;
      await waitFor(() => kernel.approvals.list().length === 1);
      kernel.approvals.resolve(kernel.approvals.list()[0].id, 'approve', 'test-user');
      expect((await again).output).toMatch(/kept the change/);
      expect(readFileSync(file, 'utf8').trim()).toBe('fixed');
    } finally {
      await cleanup();
    }
  });

  it('sends the actions that fit with the message, as tools, even to a small model', async () => {
    const llm = await mockOpenAI(() => ({ text: 'Here it is.' }));
    const { kernel, cleanup } = await makeKernel();
    try {
      kernel.settings.update({ ai: { defaultProvider: 'lan', defaultModel: 'mock-model', providers: [...DEFAULT_PROVIDERS, { id: 'lan', type: 'openai-compatible', name: 'lan', enabled: true, baseUrl: `${llm.url}/v1`, cloud: false }] } } as never);
      const { runId } = (await kernel.call('ai.chat', { message: 'Fabrix, what is my IP address?', model: 'mock-model' }, USER)) as { runId: string };
      await waitFor(() => llm.requests.length > 0 && !kernel.agent.activities().some((a) => a.runId === runId));
      const body = llm.requests.at(-1)!.body;
      expect(body.messages[0].content).toContain('## AI Toolkit');
      expect(body.messages.at(-1).content).toMatch(/<toolkit>\n- kit\.my_ip_address: My IP address\./);
      expect(body.tools.map((t: { function: { name: string } }) => t.function.name)).toContain('kit__my_ip_address');
    } finally {
      await llm.close();
      await cleanup();
    }
  });
  // Noah report 2.3.2, item 2: these four sent traffic from an offline chat without asking.
  it('asks before an action that reaches the network runs in an offline chat, and runs nothing when the answer is no', async () => {
    const calls: Record<string, Record<string, string>> = {
      kit__check_the_internet: {},
      kit__look_up_a_name: { name: 'localhost' },
      kit__trace_the_route: { host: '127.0.0.1' },
      kit__is_a_port_open: { host: '127.0.0.1', port: '9' },
    };
    for (const [tool, args] of Object.entries(calls)) {
      const llm = await mockOpenAI((_b, turn) => (turn === 0 ? { tool: { name: tool, args } } : { text: 'Done.' }));
      const { kernel, cleanup } = await makeKernel();
      try {
        kernel.settings.update({ ai: { defaultProvider: 'lan', defaultModel: 'mock-model', providers: [...DEFAULT_PROVIDERS, { id: 'lan', type: 'openai-compatible', name: 'lan', enabled: true, baseUrl: `${llm.url}/v1`, cloud: false }] } } as never);
        const { conversationId, runId } = (await kernel.call('ai.chat', { message: 'Check it.', model: 'mock-model' }, USER)) as { conversationId: string; runId: string };
        expect(kernel.conversations.isOffline(conversationId)).toBe(true);
        const ask = await waitFor(() => kernel.approvals.list()[0] ?? null);
        expect(ask.toolTitle, tool).toMatch(/^Go online: /);
        kernel.approvals.resolve(ask.id, 'deny', 'test-user');
        await waitFor(() => !kernel.agent.activities().some((a) => a.runId === runId));
        const result = kernel.conversations.get(conversationId).messages.find((m) => m.role === 'tool')!.content;
        expect(result, tool).toContain('the user chose to stay offline');
        expect(kernel.toolkit.get(tool.replace('__', '.')).uses, tool).toBe(0);
        expect(kernel.conversations.isOffline(conversationId)).toBe(true);
      } finally {
        await llm.close();
        await cleanup();
      }
    }

    // A yes puts the chat online and the action runs as before; an action someone builds that pings is the same.
    const llm = await mockOpenAI((_b, turn) => (turn === 0 ? { tool: { name: 'kit__look_up_a_name', args: { name: 'localhost' } } } : { text: 'Done.' }));
    const { kernel, cleanup } = await makeKernel();
    try {
      kernel.settings.update({ ai: { defaultProvider: 'lan', defaultModel: 'mock-model', providers: [...DEFAULT_PROVIDERS, { id: 'lan', type: 'openai-compatible', name: 'lan', enabled: true, baseUrl: `${llm.url}/v1`, cloud: false }] } } as never);
      const { conversationId, runId } = (await kernel.call('ai.chat', { message: 'Look up localhost.', model: 'mock-model' }, USER)) as { conversationId: string; runId: string };
      const ask = await waitFor(() => kernel.approvals.list()[0] ?? null);
      kernel.approvals.resolve(ask.id, 'approve', 'test-user');
      await waitFor(() => !kernel.agent.activities().some((a) => a.runId === runId));
      expect(kernel.conversations.isOffline(conversationId)).toBe(false);
      expect(kernel.toolkit.get('kit.look_up_a_name').uses).toBe(1);
      expect(kernel.conversations.get(conversationId).messages.find((m) => m.role === 'tool')!.content).toMatch(/127\.0\.0\.1|::1/);
      const mine = (await kernel.call('toolkit.save', { name: 'Ping the printer', commands: { linux: 'ping -c 1 192.168.1.20' }, ask: false }, USER)) as ToolkitAction;
      expect(kernel.registry.get(mine.tool)).toMatchObject({ risk: 'network', network: true });
      const asking = (await kernel.call('toolkit.save', { name: 'Fetch the status page', commands: { linux: 'curl -s https://example.com' }, ask: true }, USER)) as ToolkitAction;
      expect(kernel.registry.get(asking.tool)).toMatchObject({ risk: 'execute', network: true });
    } finally {
      await llm.close();
      await cleanup();
    }
  });
});
