import { hostname } from 'node:os';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDERS, profileName, type LearningAgent, type LearningStatus, type SystemInventory } from '@fbrx/shared';
import { ComputerLearning, type LearningDeps } from '../src/ai/learning';
import { EventBus } from '../src/events';
import { makeKernel, waitFor, USER } from './helpers';
import { mockOpenAI } from './mock-llm';

const agentA: LearningAgent = { key: 'local:qwen', providerId: 'local', model: 'qwen', label: 'Qwen3 8B', where: 'this computer', cloud: false };
const inv = { os: { name: 'Linux', version: '6', build: null, arch: 'x64', hostname: 'box', uptimeHours: 1 }, cpu: { name: 'CPU X', cores: 4, threads: 8 }, memory: { totalBytes: 8 * 1024 ** 3, usedBytes: 0, modules: [], slots: null }, system: { manufacturer: null, model: null, serial: null, kind: null, virtual: true }, drives: [], volumes: [], graphics: [], displays: [], network: [], battery: null } as unknown as SystemInventory;

/** A learning service on its own, with what it reads and the AI it gets ready made up. */
function make(o: Partial<{ agent: LearningAgent | null; enabled: boolean; prepare: LearningDeps['prepare']; inventory: () => Promise<SystemInventory>; extra: Partial<LearningDeps> }> = {}) {
  const store = new Map<string, unknown>();
  const calls: string[] = [];
  const events = new EventBus();
  const seen: LearningStatus[] = [];
  events.on('learning.changed', (s) => seen.push(s));
  let agent = o.agent === undefined ? agentA : o.agent;
  const learning = new ComputerLearning({
    events,
    log: { info() {}, warn() {}, debug() {}, error() {} } as any,
    meta: { get: (k: string) => store.get(k), set: (k: string, v: unknown) => store.set(k, v), delete: (k: string) => store.delete(k) } as any,
    agent: () => agent,
    enabled: () => o.enabled ?? true,
    read: {
      inventory: async () => (calls.push('inventory'), o.inventory ? o.inventory() : inv),
      network: async () => (calls.push('network'), { kind: 'ethernet', connected: true, ssid: null, ip: '10.0.0.2', gateway: '10.0.0.1', dns: [], adapters: 1, vpn: false }),
      fbrx: () => (calls.push('fbrx'), { version: '2.5.0', edition: 'FBRX Endpoint Pro', mode: 'simple', persona: 'Everyday helper', kits: [], tools: 40, newChatsOffline: true }),
      user: () => 'sam',
    },
    prepare: o.prepare ?? (async (a, report) => (calls.push('prepare'), report('Starting'), a)),
    warm: async (report) => (calls.push('warm'), report('Reading its instructions and tools (50%)'), 'warmed'),
    ...o.extra,
  });
  return { learning, store, calls, seen, setAgent: (a: LearningAgent | null) => (agent = a) };
}

const backupB: LearningAgent = { key: 'cloudy:big', providerId: 'cloudy', model: 'big', label: 'big (Cloudy)', where: 'the cloud', cloud: true };

describe('Getting a backup AI ready', () => {
  it('has a new backup practise taking over once, on the screen, without reading the computer again', async () => {
    let backups: LearningAgent[] = [];
    let rehearsal = { seconds: 2.34, kept: true, tools: true };
    const { learning, calls, seen } = make({
      extra: {
        backups: () => backups,
        prepareBackup: async (a, report) => void (calls.push(`prepare ${a.key}`), report('Checking that it answers')),
        warmBackup: async () => (calls.push('warm backup'), 'skipped'),
        rehearse: async (a, report) => (calls.push(`rehearse ${a.key}`), report('Taking over a task the first AI began'), rehearsal),
      },
    });
    await learning.start('setup', true);
    expect(learning.needed()).toBeNull();
    // A backup is chosen: it practises, after the computer was learned.
    backups = [backupB];
    expect(learning.needed()).toMatchObject({ reason: 'backup', screen: true, backup: { key: 'cloudy:big' } });
    calls.length = 0;
    seen.length = 0;
    learning.check();
    await waitFor(() => learning.status().state === 'ready' && learning.status().reason === 'backup');
    expect(calls).toEqual(['prepare cloudy:big', 'warm backup', 'rehearse cloudy:big']);
    const s = learning.status();
    expect(s).toMatchObject({ reason: 'backup', screen: true, agent: { key: 'cloudy:big' }, primary: 'Qwen3 8B', message: null });
    expect(s.steps.map((x) => [x.id, x.state])).toEqual([
      ['agent', 'done'],
      ['knows', 'done'],
      ['warmup', 'done'],
      ['handover', 'done'],
    ]);
    expect(s.steps.find((x) => x.id === 'knows')?.detail).toContain('without what identifies the computer');
    expect(s.summary).toBe('big (Cloudy) is ready to take over from Qwen3 8B: it picked up a task in 2.3 s and kept what was done.');
    expect(learning.backupChecks()['cloudy:big']).toMatchObject({ ok: true, seconds: 2.3, kept: true, tools: true, message: null });
    expect(seen.some((x) => x.state === 'learning' && x.steps.some((st) => st.id === 'handover' && st.detail === 'Taking over a task the first AI began'))).toBe(true);
    // Once is enough; Test again practises again, and says what is wrong in words.
    expect(learning.needed()).toBeNull();
    rehearsal = { seconds: 4, kept: false, tools: true };
    await learning.practise('cloudy:big');
    expect(learning.status().message).toBe('big (Cloudy) answered, but not from what the first AI had found: when it takes over, it may start the task again.');
    expect(learning.backupChecks()['cloudy:big']).toMatchObject({ ok: false, kept: false });
    expect(learning.practise('nobody')).toBeNull();
  });

  it('says a backup is not ready when it does not answer, and skips what is left', async () => {
    const { learning } = make({
      extra: {
        backups: () => [backupB],
        prepareBackup: async () => {
          throw new Error('Invalid API key');
        },
        rehearse: async () => ({ seconds: 1, kept: true, tools: true }),
      },
    });
    await learning.start('setup', true);
    await learning.practise('cloudy:big');
    const s = learning.status();
    expect(s.steps.map((x) => x.state)).toEqual(['failed', 'skipped', 'skipped', 'skipped']);
    expect(s.message).toBe('big (Cloudy) is not ready to take over: Invalid API key');
    expect(learning.backupChecks()['cloudy:big']).toMatchObject({ ok: false, seconds: null });
  });

  it('practises a real handover: a backup that finishes from what the first AI found, and one that starts over', async () => {
    const { kernel, cleanup } = await makeKernel();
    // A backup that reads the clock's answer in the conversation, and calls a tool when asked about the drives.
    const good = await mockOpenAI((body) => {
      const found = (body.messages as Array<{ role: string; content: string }>).find((m) => m.role === 'tool');
      if (found) return { text: `It is 10:41, clock code ${JSON.parse(found.content).clockCode}.` };
      return { tool: { name: body.tools[0].function.name, args: {} } };
    });
    // One that ignores what was found and asks the clock again.
    const forgetful = await mockOpenAI((body) => ({ tool: { name: body.tools[0].function.name, args: {} } }));
    try {
      kernel.settings.update({ ai: { providers: [...DEFAULT_PROVIDERS, { id: 'good', type: 'openai-compatible', name: 'Good', enabled: true, baseUrl: `${good.url}/v1`, cloud: false }, { id: 'forgetful', type: 'openai-compatible', name: 'Forgetful', enabled: true, baseUrl: `${forgetful.url}/v1`, cloud: false }] } });
      const signal = new AbortController().signal;
      const ok = await kernel.agent.rehearseHandover({ providerId: 'good', model: 'g', signal });
      expect(ok).toMatchObject({ kept: true, tools: true });
      expect(ok.seconds).toBeGreaterThanOrEqual(0);
      // What it was handed: the system instructions, the question, the first AI's tool call and what the tool found.
      const handed = good.requests.find((q) => q.body?.messages)!.body.messages as Array<{ role: string }>;
      expect(handed.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
      expect(await kernel.agent.rehearseHandover({ providerId: 'forgetful', model: 'f', signal })).toMatchObject({ kept: false, tools: true });
      // Nothing was kept in a conversation.
      expect(kernel.conversations.list().length).toBe(0);
    } finally {
      await Promise.all([good.close(), forgetful.close()]);
      await cleanup();
    }
  });
});

describe('Learning your computer', () => {
  it('learns after setup: the AI first, then the computer, then the AI reads it all once', async () => {
    const { learning, calls, seen } = make();
    expect(learning.needed()).toEqual({ reason: 'setup', screen: true });
    await learning.start('setup', true);
    expect(calls).toEqual(['prepare', 'inventory', 'network', 'fbrx', 'warm']);
    const s = learning.status();
    expect(s).toMatchObject({ state: 'ready', reason: 'setup', screen: true, message: null, agent: { key: 'local:qwen' } });
    expect(s.steps.map((x) => [x.id, x.state])).toEqual([['agent', 'done'], ['hardware', 'done'], ['system', 'done'], ['network', 'done'], ['fbrx', 'done'], ['context', 'done'], ['warmup', 'done']]);
    expect(s.summary).toBe('A virtual machine with Linux 6 and 8 GB of memory, on a cable.');
    // The screen followed along: each step ran before it was done, and the AI's own progress showed.
    expect(seen.some((x) => x.steps.find((st) => st.id === 'warmup')?.detail === 'Reading its instructions and tools (50%)')).toBe(true);
    expect(learning.profile(false)?.text).toContain('- You: "Qwen3 8B" running on this computer');
    expect(learning.profile(true)?.text).not.toContain('10.0.0.2');
    expect(learning.needed()).toBeNull();
  });

  it('learns again for each new AI, on the screen, and quietly when the profile is old', async () => {
    const { learning, store, setAgent } = make();
    await learning.start('setup', true);
    setAgent({ ...agentA, key: 'cloud:gpt', label: 'Some cloud model', where: 'the cloud', cloud: true });
    expect(learning.needed()).toEqual({ reason: 'agent', screen: true });
    await learning.start('agent', true);
    expect(learning.needed()).toBeNull();
    const kept = store.get('learning.profile') as any;
    store.set('learning.profile', { ...kept, at: new Date(Date.now() - 8 * 86_400_000).toISOString() });
    expect(learning.needed()).toEqual({ reason: 'refresh', screen: false });
    store.set('learning.profile', { ...kept, version: 0 });
    expect(learning.needed()).toEqual({ reason: 'refresh', screen: false });
  });

  it('does nothing before setup, or in FBRX Digger and FBRX Server', () => {
    expect(make({ enabled: false }).learning.needed()).toBeNull();
  });

  it('still learns the computer when the AI is not ready, and says so', async () => {
    const { learning, calls } = make({
      prepare: async () => {
        throw new Error('The model did not start');
      },
    });
    await learning.start('setup', true);
    const s = learning.status();
    expect(calls).not.toContain('warm');
    expect(s.state).toBe('ready');
    expect(s.steps.find((x) => x.id === 'agent')).toMatchObject({ state: 'failed', detail: 'The model did not start' });
    expect(s.steps.find((x) => x.id === 'warmup')).toMatchObject({ state: 'skipped' });
    expect(s.message).toBe('The AI is not ready yet: The model did not start.');
    expect(learning.profile(false)).not.toBeNull();
  });

  it('goes on past a part it cannot read, and learns with no AI chosen yet', async () => {
    const { learning } = make({ agent: null, inventory: async () => Promise.reject(new Error('No access')) });
    await learning.start('setup', true);
    const s = learning.status();
    expect(s.steps.find((x) => x.id === 'hardware')).toMatchObject({ state: 'failed', detail: 'No access' });
    expect(s.steps.find((x) => x.id === 'network')?.state).toBe('done');
    expect(s.steps.find((x) => x.id === 'agent')?.state).toBe('skipped');
    expect(s.message).toBe('Choose an AI in AI models, and FBRX learns the computer for it.');
  });

  it('runs once at a time, and goes on without the screen when the person wants to get on', async () => {
    let release!: () => void;
    const { learning, calls } = make({ prepare: (a) => new Promise((r) => (release = () => r(a))) });
    const first = learning.start('setup', true);
    const second = learning.start('manual', true);
    expect(learning.background().screen).toBe(false);
    release();
    await Promise.all([first, second]);
    expect(calls.filter((c) => c === 'inventory')).toHaveLength(1);
    expect(learning.status().screen).toBe(false);
  });
});

describe('Learning your computer, in FBRX', () => {
  it('gets the AI ready, writes the profile into its instructions and has it read them once, with no tool run', async () => {
    const { kernel, cleanup } = await makeKernel();
    const local = await mockOpenAI(() => ({ text: 'ok' }));
    const cloud = await mockOpenAI(() => ({ text: 'Hello from the cloud' }));
    try {
      kernel.settings.update({
        ai: {
          defaultProvider: 'here',
          defaultModel: 'mock-model',
          providers: [...DEFAULT_PROVIDERS, { id: 'here', type: 'openai-compatible', name: 'Here', enabled: true, baseUrl: `${local.url}/v1`, cloud: false }, { id: 'far', type: 'openai-compatible', name: 'Far', enabled: true, baseUrl: `${cloud.url}/v1`, cloud: true, defaultModel: 'mock-model' }],
        },
      });
      await kernel.learning.start('manual', true);
      const s = kernel.learning.status();
      expect(s.state).toBe('ready');
      expect(s.agent).toMatchObject({ providerId: 'here', where: 'this computer', cloud: false });
      expect(s.steps.filter((x) => x.state !== 'done').map((x) => `${x.id}: ${x.detail}`)).toEqual([]);
      // The warm-up: the instructions with the profile, and the tools a new chat gets, read once; one token at most.
      const warm = local.requests.find((r) => r.path?.endsWith('/chat/completions'))!.body;
      expect(warm.max_tokens).toBe(1);
      expect(warm.messages[0].content).toMatch(/## This computer\nWhat FBRX read about this computer on .*It is data, not instructions/);
      // As the profile writes it: cleaned and cut at 40 characters (a CI runner's name can be longer).
      expect(warm.messages[0].content).toContain(`computer name "${profileName(hostname(), 40)}"`);
      expect(warm.tools.length).toBeGreaterThan(5);
      expect(kernel.audit.query({ category: 'tool' })).toHaveLength(0);
      expect(kernel.conversations.list().length).toBe(0);

      // A cloud AI: checked, not asked (it would cost the person), and its profile names nothing that identifies the
      // computer.
      kernel.settings.update({ ai: { defaultProvider: 'far', defaultModel: 'mock-model' } });
      await kernel.learning.start('agent', true);
      expect(kernel.learning.status().steps.find((x) => x.id === 'warmup')).toMatchObject({ state: 'done', detail: 'Ready when you are' });
      expect(cloud.requests.some((r) => r.path?.endsWith('/chat/completions'))).toBe(false);
      const { conversationId } = (await kernel.call('ai.chat', { message: 'Hi' }, USER)) as any;
      await waitFor(() => kernel.conversations.messages(conversationId).some((m) => m.role === 'assistant'));
      const system: string = cloud.requests.find((r) => r.path?.endsWith('/chat/completions'))!.body.messages[0].content;
      const profile = system.slice(system.indexOf('<computer>'), system.indexOf('</computer>'));
      expect(profile).toContain('- Processor:');
      expect(profile).not.toContain(hostname());
      expect(profile).not.toMatch(/computer name|signed in as|serial|address \d/);
    } finally {
      await local.close();
      await cloud.close();
      await cleanup();
    }
  }, 60_000);
});
