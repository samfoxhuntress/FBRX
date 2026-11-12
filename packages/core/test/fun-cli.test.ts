import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDERS, TROPHIES, type CliResult } from '@fbrx/shared';
import { makeKernel, waitFor, USER } from './helpers';
import { mockOpenAI } from './mock-llm';
import { AiCoordination } from '../src/aicoord/aicoord';
import { words } from '../src/cli/fbrx1';
import { resourcePlan } from '../src/ai/resources';
import { constants } from 'node:os';

const API = { origin: 'api' as const, actor: 'localapi:agent' };

describe('trophy case', () => {
  it('records trophies once, awards the golden goose for all of them, and stays quiet with fun extras off', async () => {
    // A new computer on its own (Essentials, no license) has no easter eggs at all.
    const basic = await makeKernel({ devMode: false });
    try {
      expect(basic.kernel.license.status().tier).toBe('essentials');
      expect(await basic.kernel.call('fun.unlock', { id: 'loom' }, USER)).toEqual({ unlocked: false, golden: false });
    } finally {
      await basic.cleanup();
    }
    const { kernel, cleanup } = await makeKernel();
    try {
      expect(kernel.license.status().tier).toBe('blackhole');
      // The fullest edition alone is not enough: they stay hidden until someone enters 418.
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
      expect((await run('show configuration appearance')).output).toMatch(/^appearance \{\n {4}preset tropical;/);
      expect((await run('show configuration appearance | display set | match preset')).output).toBe('set appearance preset tropical');
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

describe('chat with fun extras on', () => {
  it('has no canned answers that quote films: the lines that used to start one go to the AI like any other message', async () => {
    const { kernel, cleanup } = await makeKernel();
    const llm = await mockOpenAI(() => ({ text: 'Plain answer.' }));
    try {
      kernel.settings.update({ appearance: { funUnlocked: true }, ai: { defaultProvider: 'mock', defaultModel: 'm', providers: [...DEFAULT_PROVIDERS, { id: 'mock', type: 'openai-compatible', name: 'Mock', enabled: true, baseUrl: `${llm.url}/v1`, cloud: false }] } });
      const lines = ["Chewie, we're home", 'Talk to me, Goose', 'Have you seen my stapler?', 'PC load letter'];
      for (const message of lines) {
        const r = (await kernel.call('ai.chat', { message }, USER)) as any;
        await waitFor(() => kernel.conversations.get(r.conversationId).messages.at(-1)?.content === 'Plain answer.');
      }
      expect(llm.requests.filter((q) => q.path?.endsWith('/chat/completions'))).toHaveLength(lines.length);
      expect(Object.keys(((await kernel.call('fun.trophies', undefined, USER)) as any).unlocked)).toEqual([]);
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
