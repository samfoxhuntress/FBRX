import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDERS, type AgentEvent } from '@fbrx/shared';
import { digestTurns } from '../src/ai/context-budget';
import type { StoredMessage } from '../src/ai/conversations';
import { makeKernel, waitFor, USER } from './helpers';
import { mockOpenAI } from './mock-llm';

const mock = (url: string, cloud = false) => ({
  ai: { defaultProvider: 'mock', defaultModel: 'mock-model', providers: [...DEFAULT_PROVIDERS, { id: 'mock', type: 'openai-compatible' as const, name: 'Mock', enabled: true, baseUrl: `${url}/v1`, cloud }] },
});

const msg = (role: StoredMessage['role'], content: string, extra: Partial<StoredMessage> = {}): StoredMessage => ({ id: 'm', role, content, createdAt: '', providerData: null, ...extra }) as StoredMessage;

describe('the agent knows its room: context window, folded history and the monthly budget', () => {
  it('folds older requests into a digest that keeps what was asked, what came of it and the ids', () => {
    const turns = [
      [msg('user', 'Create a project called Garden'), msg('assistant', '', { toolCalls: [{ id: 'c1', name: 'projects.create', input: {}, status: 'succeeded' }] }), msg('tool', '{"id":"prj_abcdefgh12"}'), msg('assistant', 'Made the Garden project.')],
      [msg('user', 'Add a note about tomatoes'), msg('assistant', 'Added note_tomato0001 to Garden.')],
    ];
    const d = digestTurns(turns, 2000);
    expect(d).toContain('Asked: "Create a project called Garden" → Made the Garden project. [tools: projects.create] [ids: prj_abcdefgh12]');
    expect(d).toContain('[ids: note_tomato0001]');
    // Too long for its room: the newest requests stay.
    const short = digestTurns(turns, 120);
    expect(short).toContain('(1 older request left out; their ids: prj_abcdefgh12)');
    expect(short).toContain('tomatoes');
  });

  it('tells the agent how it works and where it stands, and the gauge reads what the provider counted', async () => {
    const { kernel, cleanup } = await makeKernel();
    let seen: any = null;
    const llm = await mockOpenAI((body) => ((seen = body), { text: 'Done.' }));
    try {
      kernel.settings.update(mock(llm.url));
      const events: AgentEvent[] = [];
      kernel.events.on('agent', (e) => events.push(e));
      await kernel.call('ai.chat', { message: 'Hello' }, USER);
      const done = (await waitFor(() => events.find((e) => e.type === 'run.completed'))) as Extract<AgentEvent, { type: 'run.completed' }>;
      expect(seen.messages[0].content).toContain('## How you work');
      expect(seen.messages[0].content).toContain('Also noticed');
      const last = seen.messages.filter((m: any) => m.role === 'user').pop().content;
      expect(last).toMatch(/^<budget>\nContext window: about [\d,]+ tokens; this conversation fills about [\d,]+/);
      expect(last).toContain('Hello');
      expect(done.context).toMatchObject({ usedTokens: 120, estimated: false });
      expect(kernel.usage.month().models['mock/mock-model']).toMatchObject({ inputTokens: 100, outputTokens: 20, runs: 1, cloud: false });
      const report = (await kernel.call('ai.usage', {}, USER)) as any;
      expect(report).toMatchObject({ inputTokens: 100, outputTokens: 20, cloudTokens: 0, budget: 0, agent: { providerName: 'Mock', model: 'mock-model' } });
    } finally {
      await llm.close();
      await cleanup();
    }
  });

  it('folds older turns that no longer fit, keeping their ids, and says how many', async () => {
    const { kernel, cleanup } = await makeKernel();
    let seen: any = null;
    const llm = await mockOpenAI((body) => ((seen = body), { text: 'Here it is.' }));
    try {
      kernel.settings.update(mock(llm.url));
      // A provider that holds little: the history gets its least, 4,000 characters.
      const resolve = kernel.providers.resolve.bind(kernel.providers);
      kernel.providers.resolve = (...a) => {
        const r = resolve(...a);
        Object.defineProperty(r.provider, 'historyBudgetChars', { value: 10_000 });
        return r;
      };
      const conv = kernel.conversations.create('Garden', 'user');
      kernel.conversations.append(conv.id, { role: 'user', content: 'Create a project called Garden' });
      kernel.conversations.append(conv.id, { role: 'assistant', content: `Made it: prj_garden0001. ${'x'.repeat(3000)}` });
      for (let i = 0; i < 4; i++) {
        kernel.conversations.append(conv.id, { role: 'user', content: `Question ${i} ${'y'.repeat(1500)}` });
        kernel.conversations.append(conv.id, { role: 'assistant', content: `Answer ${i}` });
      }
      const before = (await kernel.call('ai.context', { conversationId: conv.id }, USER)) as any;
      expect(before.folded).toBeGreaterThan(0);
      await kernel.agent.start({ conversationId: conv.id, message: 'Add a note to that project', origin: 'user', actor: 'u' }).done;
      const first = seen.messages.find((m: any) => m.role === 'user').content;
      expect(first).toContain('<earlier>');
      expect(first).toContain('prj_garden0001');
      expect(seen.messages.at(-1).content).toContain('older request');
    } finally {
      await llm.close();
      await cleanup();
    }
  });

  it("keeps cloud AI within the month's budget: new chats wait, and a task stops cleanly between steps", async () => {
    const { kernel, cleanup } = await makeKernel();
    const llm = await mockOpenAI((_b, turn) => (turn === 0 ? { tool: { name: 'time__now', args: {} } } : { text: 'All done.' }));
    try {
      kernel.settings.update({ ...mock(llm.url, true) });
      kernel.settings.update({ ai: { monthlyBudgetTokens: 100 } });
      const r = await kernel.agent.start({ message: 'What time is it?', origin: 'user', actor: 'u' }).done;
      expect(r.status).toBe('completed');
      expect(r.steps).toBe(1);
      expect(r.answer).toContain("this month's cloud AI budget");
      expect(kernel.usage.cloudUsed()).toBe(120);
      expect(() => kernel.agent.start({ message: 'Again', origin: 'user', actor: 'u' })).toThrow(/cloud AI budget on this computer \(100 tokens\) is used/);
    } finally {
      await llm.close();
      await cleanup();
    }
  });
});
