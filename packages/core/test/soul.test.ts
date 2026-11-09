import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDERS, soulCommandIn, soulCommands, soulSection, soulSections, toolkitToolName, withSoulSection, type AgentEvent, type SoulStatus } from '@fbrx/shared';
import { DEFAULT_SOUL } from '../src/ai/soul';
import { TOOLKIT_LIBRARY } from '../src/ai/toolkit-library';
import { makeKernel, USER, waitFor } from './helpers';
import { mockOpenAI } from './mock-llm';

const useMock = (kernel: any, url: string) =>
  kernel.settings.update({ ai: { defaultProvider: 'mock', defaultModel: 'm', providers: [...DEFAULT_PROVIDERS, { id: 'mock', type: 'openai-compatible', name: 'Mock', enabled: true, baseUrl: `${url}/v1`, cloud: false }] } });

async function chat(kernel: any, message: string) {
  const events: AgentEvent[] = [];
  const off = kernel.events.on('agent', (e: AgentEvent) => events.push(e));
  await kernel.call('ai.chat', { message }, USER);
  await waitFor(() => events.some((e) => e.type === 'run.completed' || e.type === 'run.failed'));
  off();
  return events;
}

describe('the default soul', () => {
  it('has its sections, and dozens of commands in groups', () => {
    expect(soulSections(DEFAULT_SOUL).map((s) => s.title)).toEqual(['Who I am', 'What I care about', 'How I talk', 'Options', 'Commands', 'Toolkits', 'Notes']);
    const commands = soulCommands(DEFAULT_SOUL);
    expect(commands.length).toBeGreaterThanOrEqual(60);
    expect(new Set(commands.map((c) => c.group))).toEqual(new Set(['Getting around', 'This computer', 'Network', 'Security', 'FBRX Server and Gate', 'Mesh and devices', 'Work', 'You and me']));
    expect(commands.find((c) => c.name === 'ping')).toMatchObject({ hint: 'host', group: 'Network' });
    expect(soulSection(DEFAULT_SOUL, 'options')!.body.split('\n').filter((l) => l.startsWith('- ')).length).toBeGreaterThanOrEqual(15);
  });

  it('names only tools FBRX has', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      const kits = TOOLKIT_LIBRARY.map((a) => toolkitToolName(a.name));
      // Some tools are there only on some systems (pc.security_status and its kind): they are in FBRX all the same.
      const everywhere = readFileSync(join(__dirname, '../src/tools/builtin/command-center-tools.ts'), 'utf8').match(/name: '[a-z_.]+'/g)!.map((m) => m.slice(7, -1));
      const known = new Set([...kernel.registry.list().map((t) => t.name), ...kits, ...everywhere]);
      const named = [...new Set(DEFAULT_SOUL.match(/\b[a-z_]+\.[a-z_]+\b/g) ?? [])].filter((n) => !/^(soul\.md|fbrx\.|[a-z]+\.(md|html))$/.test(n) || known.has(n));
      const missing = named.filter((n) => !known.has(n) && n !== 'soul.md');
      expect(missing).toEqual([]);
      expect(named.length).toBeGreaterThan(50);
    } finally {
      await cleanup();
    }
  });

  it('names no other company’s products', () => {
    expect(DEFAULT_SOUL).not.toMatch(/\b(Windows|Microsoft|Google|Apple|macOS|Slack|WhatsApp|ChatGPT|OpenAI|Claude|UniFi)\b/);
  });
});

describe('soul.md', () => {
  it('reads commands from a message, not paths', () => {
    expect(soulCommandIn('/ping 1.1.1.1')).toEqual({ name: 'ping', args: '1.1.1.1' });
    expect(soulCommandIn('  /checkup')).toEqual({ name: 'checkup', args: '' });
    expect(soulCommandIn('/etc/hosts is broken')).toBeNull();
    expect(soulCommandIn('what does /wifi do')).toBeNull();
  });

  it('changes one section, adding a new one before Notes', () => {
    const a = withSoulSection(DEFAULT_SOUL, 'Notes', '- Call me Sam.', 'append');
    expect(soulSection(a, 'Notes')!.body).toMatch(/approve each change\.\n- Call me Sam\.$/);
    const b = withSoulSection(a, 'Household', '- Three laptops and a printer.', 'replace');
    expect(soulSections(b).map((s) => s.title).slice(-2)).toEqual(['Household', 'Notes']);
    const c = withSoulSection(b, 'options', '- emoji: on.', 'replace');
    expect(soulSection(c, 'Options')!.body).toBe('- emoji: on.');
    expect(soulCommands(c).length).toBe(soulCommands(DEFAULT_SOUL).length);
  });

  it('is written at the first start, followed by the AI, and changed only with the person’s yes', async () => {
    const { kernel, dataDir, cleanup } = await makeKernel();
    const llm = await mockOpenAI(() => ({ text: 'Done.' }));
    try {
      const file = join(dataDir, 'soul.md');
      expect(readFileSync(file, 'utf8')).toBe(DEFAULT_SOUL);
      expect(((await kernel.call('soul.get', undefined, USER)) as SoulStatus).isDefault).toBe(true);

      // The soul goes into the AI's instructions; a command goes with the message, the tools it names with it.
      useMock(kernel, llm.url);
      await chat(kernel, '/ip');
      const first = llm.requests.find((r) => r.body?.messages)!.body;
      const system = first.messages[0].content as string;
      expect(system).toContain('## Your soul (soul.md)');
      expect(system).toContain('### What I care about');
      expect(system).toContain('/checkup');
      expect(system).not.toContain('### Toolkits');
      expect(system).not.toContain('You are the built-in operations agent');
      expect(first.messages.at(-1).content).toMatch(/<command>\nThe person typed the command \/ip\. From soul\.md, it means: This computer's addresses/);
      expect(first.tools.map((t: { function: { name: string } }) => t.function.name)).toContain('net__ip_address');

      // /help lists the commands; an unknown one says so.
      expect(kernel.soul.command('/help wifi')!.text).toMatch(/\/wifi: The Wi-Fi/);
      expect(kernel.soul.command('/wiifi')!.text).toMatch(/not one of the commands.*\/wifi/);

      // The AI changes it only with the person's yes, and it can be undone.
      const run = kernel.gate.invoke('soul.update', { section: 'Notes', mode: 'append', content: '- Keep answers very short.', why: 'Asked for shorter answers' }, { origin: 'agent', actor: 'agent' });
      const ask = await waitFor(() => kernel.approvals.list()[0] ?? null);
      expect(ask).toMatchObject({ tool: 'soul.update', toolTitle: 'Change your soul' });
      kernel.approvals.resolve(ask.id, 'approve', 'test-user');
      expect((await run).ok).toBe(true);
      expect(readFileSync(file, 'utf8')).toContain('- Keep answers very short.');
      expect(kernel.soul.prompt()).toContain('- Keep answers very short.');
      const back = (await kernel.call('soul.undo', undefined, USER)) as SoulStatus;
      expect(back.isDefault).toBe(true);
      // Only the person at the computer edits it outright (not another app on the Local API).
      await expect(kernel.call('soul.set', { text: '# Soul\n\n## Who I am\n\nSomeone else.' }, { origin: 'api', actor: 'script' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const mine = (await kernel.call('soul.set', { text: `${DEFAULT_SOUL}\n- Prefer metric units.` }, USER)) as SoulStatus;
      expect(mine.isDefault).toBe(false);
      expect(mine.history[0].by).toBe('test-user');
      expect(existsSync(join(dataDir, 'soul.history'))).toBe(true);
      expect(((await kernel.call('soul.reset', undefined, USER)) as SoulStatus).isDefault).toBe(true);
    } finally {
      await llm.close();
      await cleanup();
    }
  });

  it('follows a newer default when it was never changed, and keeps the person’s own', async () => {
    const { kernel, dataDir, cleanup } = await makeKernel();
    try {
      const file = join(dataDir, 'soul.md');
      // As if an older FBRX had written its default: the store remembers it wrote that text.
      const older = DEFAULT_SOUL.replace('## Notes', '## Notes (old)');
      writeFileSync(file, older);
      kernel.meta.set('ai.soul.written', require('node:crypto').createHash('sha256').update(older).digest('hex'));
      kernel.soul.ensure();
      expect(readFileSync(file, 'utf8')).toBe(DEFAULT_SOUL);
      // The person's own is never replaced.
      kernel.soul.set(`${DEFAULT_SOUL}\nMine.`, 'test-user');
      kernel.soul.ensure();
      expect(readFileSync(file, 'utf8')).toContain('Mine.');
    } finally {
      await cleanup();
    }
  });
});

describe('toolkits.read', () => {
  it('lists every family with its tools, and FBRX Server and Gate with what the person can do there', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      const all = (await kernel.call('tools.invoke', { name: 'toolkits.read', input: {} }, USER)) as { ok: boolean; output: string };
      expect(all.ok).toBe(true);
      for (const f of ['AI Toolkit', 'This computer', 'Network', 'Security', 'FBRX itself', 'FBRX Server and Gate', 'Work', 'Me']) expect(all.output).toContain(`${f} — `);
      expect(all.output).toMatch(/- soul\.update: Change your soul \(asks first or changes things\)/);
      const server = (await kernel.call('tools.invoke', { name: 'toolkits.read', input: { family: 'server' } }, USER)) as { output: string };
      expect(server.output).toMatch(/server\.network_check: .* not now: No FBRX Server lets Fabrix look/);
      expect(server.output).toContain('fbrx-gate (on a gate): status');
      expect(server.output).toContain('fbrx-server: status, doctor');
      expect(server.output).not.toContain('This computer — ');
    } finally {
      await cleanup();
    }
  });
});
