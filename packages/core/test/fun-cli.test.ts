import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDERS, TROPHIES, type AgentEvent, type CliResult } from '@fbrx/shared';
import { makeKernel, waitFor, USER } from './helpers';
import { mockOpenAI } from './mock-llm';
import { AiCoordination } from '../src/aicoord/aicoord';
import { words } from '../src/cli/fbrx1';
import { chatEgg } from '../src/fun/chat-eggs';
import { resourcePlan } from '../src/ai/resources';
import { constants } from 'node:os';

const API = { origin: 'api' as const, actor: 'localapi:agent' };

describe('trophy case', () => {
  it('records trophies once, awards the golden goose for all of them, and stays quiet with fun extras off', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      // Locked until someone enters 418.
      expect(await kernel.call('fun.unlock', { id: 'loom' }, USER)).toEqual({ unlocked: false, golden: false });
      kernel.settings.update({ appearance: { funUnlocked: true } });
      const events: any[] = [];
      kernel.events.on('fun.trophy', (e) => events.push(e));
      expect(await kernel.call('fun.unlock', { id: 'loom' }, USER)).toEqual({ unlocked: true, golden: false });
      expect(await kernel.call('fun.unlock', { id: 'loom' }, USER)).toEqual({ unlocked: false, golden: false });
      await expect(kernel.call('fun.unlock', { id: 'golden' }, USER)).rejects.toThrow(/Unknown trophy/);
      await expect(kernel.call('fun.unlock', { id: 'loom' }, API)).rejects.toThrow(/person at this workstation/);
      for (const t of TROPHIES) await kernel.call('fun.unlock', { id: t.id }, USER);
      const state = (await kernel.call('fun.trophies', undefined, USER)) as any;
      expect(Object.keys(state.unlocked)).toHaveLength(TROPHIES.length + 1);
      expect(events.some((e) => e.id === 'golden' && e.golden)).toBe(true);

      const { kernel: k2, cleanup: c2 } = await makeKernel();
      try {
        k2.settings.update({ appearance: { easterEggs: false, funUnlocked: true } });
        expect(await k2.call('fun.unlock', { id: 'loom' }, USER)).toEqual({ unlocked: false, golden: false });
      } finally {
        await c2();
      }
    } finally {
      await cleanup();
    }
  });
});

describe('emergency stop', () => {
  it('cancels runs, blocks the agent and other AI apps until resumed, and survives in the status', async () => {
    const { kernel, cleanup } = await makeKernel();
    // A slow model, so a run is still going when the stop is pressed.
    const llm = await mockOpenAI(() => ({ text: 'ok' }));
    try {
      kernel.settings.update({ ai: { defaultProvider: 'mock', defaultModel: 'm', providers: [...DEFAULT_PROVIDERS, { id: 'mock', type: 'openai-compatible', name: 'Mock', enabled: true, baseUrl: `${llm.url}/v1`, cloud: false }] } });
      const halted: any[] = [];
      kernel.events.on('ai.halted', (e) => halted.push(e));
      const r = (await kernel.call('ai.hardStop', undefined, USER)) as any;
      expect(r).toMatchObject({ cancelledRuns: 0, deniedApprovals: 0 });
      expect(((await kernel.call('system.status', undefined, USER)) as any).aiHalt).toMatchObject({ by: USER.actor });
      await expect(kernel.call('ai.chat', { message: 'hello' }, USER)).rejects.toThrow(/emergency stop/);
      await expect(kernel.call('tools.invoke', { name: 'time.now', input: {} }, API)).rejects.toThrow(/emergency stop/);
      // The person at the computer can still use tools directly, and resume.
      expect(((await kernel.call('tools.invoke', { name: 'time.now', input: {} }, USER)) as any).ok).toBe(true);
      await expect(kernel.call('ai.resume', undefined, API)).rejects.toThrow(/person at this workstation/);
      await kernel.call('ai.resume', undefined, USER);
      expect(((await kernel.call('system.status', undefined, USER)) as any).aiHalt).toBeNull();
      expect(halted.map((h) => h.halted)).toEqual([true, false]);
      expect(kernel.audit.query({ category: 'agent', limit: 5 }).map((e) => e.action)).toEqual(expect.arrayContaining(['emergency-stop', 'emergency-stop.resumed']));
    } finally {
      await llm.close();
      await cleanup();
    }
  });
});

describe('the stapler', () => {
  it('answers at once, then the conversation talks in corporate jargon and ends with "That would be great."', async () => {
    const { kernel, cleanup } = await makeKernel();
    const llm = await mockOpenAI(() => ({ text: 'Your disk has 120 GB free.' }));
    try {
      kernel.settings.update({ appearance: { funUnlocked: true } });
      kernel.settings.update({ ai: { defaultProvider: 'mock', defaultModel: 'm', providers: [...DEFAULT_PROVIDERS, { id: 'mock', type: 'openai-compatible', name: 'Mock', enabled: true, baseUrl: `${llm.url}/v1`, cloud: false }] } });
      const events: AgentEvent[] = [];
      kernel.events.on('agent', (e) => events.push(e));
      const first = (await kernel.call('ai.chat', { message: "Where's my stapler?" }, USER)) as any;
      const reply = events.find((e) => e.type === 'message.completed') as any;
      expect(reply.message.content).toMatch(/downstairs, in storage building B/);
      expect(llm.requests).toHaveLength(0);
      expect(kernel.trophies.has('stapler')).toBe(true);

      await kernel.call('ai.chat', { conversationId: first.conversationId, message: 'How much disk space is free?' }, USER);
      await waitFor(() => events.filter((e) => e.type === 'run.completed').length >= 2);
      const system = llm.requests.at(-1).body.messages[0].content as string;
      expect(system).toMatch(/corporate jargon/);
      const last = kernel.conversations.get(first.conversationId).messages.at(-1)!;
      expect(last.content).toMatch(/120 GB free\.\n\nThat would be great\.$/);

      await kernel.call('ai.chat', { conversationId: first.conversationId, message: 'PC load better' }, USER);
      expect(kernel.conversations.get(first.conversationId).messages.at(-1)!.content).toMatch(/back to talking like a normal assistant/);
      expect(kernel.trophies.has('pcload')).toBe(true);
      await kernel.call('ai.chat', { conversationId: first.conversationId, message: 'And now?' }, USER);
      await waitFor(() => events.filter((e) => e.type === 'run.completed').length >= 4);
      expect(llm.requests.at(-1).body.messages[0].content).not.toMatch(/corporate jargon/);
    } finally {
      await llm.close();
      await cleanup();
    }
  });
});

describe('FBRX/1', () => {
  it('shows, configures with commit, pipes and completes', async () => {
    const { kernel, cleanup } = await makeKernel();
    const run = async (line: string) => (await kernel.call('cli.exec', { session: 's1', line }, USER)) as CliResult;
    try {
      expect(words('set ai agentName "Big Goose" | match x')).toEqual(['set', 'ai', 'agentName', 'Big Goose', '|', 'match', 'x']);
      expect((await run('show version')).output).toMatch(/Version: +\d/);
      expect((await run('sh ver')).output).toMatch(/Product: +FBRX OS/);
      expect((await run('show system status')).output).toMatch(/Emergency stop: +off/);
      expect((await run('show services | count')).output).toMatch(/^Count: \d+ lines$/);
      expect((await run('show configuration appearance')).output).toMatch(/^appearance \{\n {4}preset fabrics;/);
      expect((await run('show configuration appearance | display set | match preset')).output).toBe('set appearance preset fabrics');
      expect((await run('show bogus')).output).toMatch(/^error: syntax error/);
      expect((await run('show ?')).output).toMatch(/Possible completions:[\s\S]*version/);

      const cfg = await run('configure');
      expect(cfg.mode).toBe('configure');
      expect(cfg.prompt).toMatch(/^\[edit\]\n.+#$/);
      expect((await run('set appearance preset tropical')).output).toBe('');
      expect((await run('set ai agentName "Big Goose"')).output).toBe('');
      expect((await run('set appearance nope 1')).output).toMatch(/No setting/);
      expect((await run('show | compare')).output).toBe('+ set appearance preset tropical\n+ set ai agentName "Big Goose"');
      expect((await run('commit check')).output).toBe('configuration check succeeds');
      expect((await run('exit')).output).toMatch(/Uncommitted changes/);
      expect((await run('commit')).output).toBe('commit complete (2 changes)');
      expect(kernel.settings.get().appearance.preset).toBe('tropical');
      expect(kernel.settings.get().ai.agentName).toBe('Big Goose');
      expect((await run('set appearance preset nonsense')).output).toBe('');
      expect((await run('commit check')).output).toMatch(/^error: appearance preset/);
      expect((await run('rollback')).output).toMatch(/discarded/);
      expect((await run('run show configuration ai | match agentName')).output).toMatch(/agentName "Big Goose";/);
      expect((await run('exit')).mode).toBe('operational');

      expect(((await kernel.call('cli.complete', { session: 's1', line: 'show sy' }, USER)) as any).completions).toEqual(['system']);
      expect(((await kernel.call('cli.complete', { session: 's1', line: 'request ai ' }, USER)) as any).completions).toEqual(['stop', 'resume']);
      await expect(kernel.call('cli.exec', { session: 'x', line: 'show version' }, API)).rejects.toThrow(/person at this workstation/);
    } finally {
      await cleanup();
    }
  });
});

describe('AI coordination link test', () => {
  it('starts the bridge like an AI app would and lists the FBRX tools', async () => {
    const { kernel, cleanup } = await makeKernel({ localApiPort: 47833 });
    try {
      await waitFor(() => kernel.localApi.running);
      const shim = resolve(__dirname, '../src/aicoord/mcp-shim.ts');
      const co = new AiCoordination({ shim: () => ({ command: process.execPath, args: ['--import', 'tsx', shim], env: { FBRX_DATA_DIR: kernel.paths.root } }), localApiRunning: () => true });
      const r = await co.test('not-an-app');
      expect(r.ok).toBe(true);
      expect(r.tools).toBeGreaterThan(10);
      const off = await new AiCoordination({ shim: () => ({ command: process.execPath, args: [], env: {} }), localApiRunning: () => false }).test('not-an-app');
      expect(off).toMatchObject({ ok: false });
      expect(off.message).toMatch(/Local API is off/);
    } finally {
      await cleanup();
    }
  }, 40_000);
});

describe('chat eggs', () => {
  it('knows the stapler however it is asked, and PC load letter or better', () => {
    for (const q of ["Where's my stapler?", 'Where is my stapler', 'where’s my stapler', 'stapler', 'Stapler?', 'have you seen my red swingline stapler']) {
      expect(chatEgg(q, null)?.trophies).toEqual(['stapler']);
    }
    expect(chatEgg('Write a 2,000 word essay on the history of office supplies, including the humble stapler and the paper clip, with sources and footnotes please', null)).toBeNull();
    expect(chatEgg('PC load letter', 'lumbergh')).toMatchObject({ persona: null, trophies: ['pcload'] });
    expect(chatEgg('pc load better', 'lumbergh')).toMatchObject({ persona: null, trophies: ['pcload'] });
    expect(chatEgg('PC load letter', null)).toMatchObject({ persona: undefined, trophies: ['pcload'] });
    expect(chatEgg('How much disk space is free?', null)).toBeNull();
  });

  it('turns Wookiee on "Chewie, we\'re home" until "Laugh it up, fuzzball", with the father line on Nooo', () => {
    const r = () => 0.3;
    const on = chatEgg("Chewie, we're home", null, r)!;
    expect(on).toMatchObject({ persona: 'wookiee:0', trophies: ['chewie'] });
    let persona = on.persona!;
    const growl = chatEgg('How much disk space is free?', persona, r)!;
    expect(growl.reply).toMatch(/^[A-Z]r|^R|^A|^U|^G|^H|^W/);
    expect(growl.reply).not.toMatch(/disk/i);
    persona = growl.persona!;
    expect(chatEgg('Nooo!', persona, r)).toMatchObject({ reply: 'No, I am your father.', trophies: ['father'] });
    expect(chatEgg('Noo', persona, r)!.trophies).toEqual([]);
    for (let i = 0; i < 4; i++) persona = chatEgg('hello?', persona, r)!.persona!;
    expect(persona).toBe('wookiee:5');
    expect(chatEgg('still there?', 'wookiee:4', r)!.trophies).toEqual(['wookiee']);
    expect(chatEgg('Laugh it up, fuzzball', persona, r)).toMatchObject({ persona: null, trophies: ['fuzzball'] });
  });

  it('stays out of the way until fun extras are unlocked with 418', async () => {
    const { kernel, cleanup } = await makeKernel();
    const llm = await mockOpenAI(() => ({ text: 'Plain answer.' }));
    try {
      kernel.settings.update({ ai: { defaultProvider: 'mock', defaultModel: 'm', providers: [...DEFAULT_PROVIDERS, { id: 'mock', type: 'openai-compatible', name: 'Mock', enabled: true, baseUrl: `${llm.url}/v1`, cloud: false }] } });
      const events: AgentEvent[] = [];
      kernel.events.on('agent', (e) => events.push(e));
      await kernel.call('ai.chat', { message: "Chewie, we're home" }, USER);
      await waitFor(() => events.some((e) => e.type === 'run.completed'));
      expect(llm.requests).toHaveLength(1);
      kernel.settings.update({ appearance: { funUnlocked: true } });
      const r = (await kernel.call('ai.chat', { message: "Chewie, we're home" }, USER)) as any;
      expect(kernel.conversations.get(r.conversationId).messages.at(-1)!.content).toMatch(/^Rrrrrrr-ghghghghgh!/);
      expect(kernel.trophies.has('chewie')).toBe(true);
      expect(llm.requests).toHaveLength(1);
    } finally {
      await llm.close();
      await cleanup();
    }
  });
});

describe('local AI resources', () => {
  it('keeps a core free and runs below normal priority unless asked for full speed', () => {
    expect(resourcePlan('light', 16)).toMatchObject({ threads: 4, priority: constants.priority.PRIORITY_LOW });
    expect(resourcePlan('balanced', 16)).toMatchObject({ threads: 8, priority: constants.priority.PRIORITY_BELOW_NORMAL });
    expect(resourcePlan('full', 16)).toMatchObject({ threads: 15, priority: constants.priority.PRIORITY_NORMAL });
    expect(resourcePlan('balanced', 1).threads).toBe(1);
  });
});
