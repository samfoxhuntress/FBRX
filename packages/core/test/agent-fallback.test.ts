import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDERS, type ProviderConfig } from '@fbrx/shared';
import { makeKernel } from './helpers';
import { mockOpenAI } from './mock-llm';

const mock = (id: string, url: string, cloud = false): ProviderConfig => ({ id, type: 'openai-compatible', name: id, enabled: true, baseUrl: `${url}/v1`, cloud });

describe('when the model fails, the next one carries on with the same conversation', () => {
  it('takes the run over mid-task, with the request and the tool results so far', async () => {
    const { kernel, cleanup } = await makeKernel();
    // The first model calls a tool, then fails; the second gets the conversation as it stands and finishes.
    const first = await mockOpenAI((_b, turn) => (turn === 0 ? { tool: { name: 'time__now', args: {} } } : { fail: 503 }));
    const second = await mockOpenAI(() => ({ fail: 401 }));
    const third = await mockOpenAI(() => ({ text: 'It is about noon, by the clock I read.' }));
    try {
      kernel.settings.update({
        ai: {
          defaultProvider: 'first',
          defaultModel: 'm1',
          providers: [...DEFAULT_PROVIDERS, mock('first', first.url), mock('second', second.url), mock('third', third.url)],
          fallbacks: [
            { providerId: 'second', model: 'm2' },
            { providerId: 'third', model: 'm3' },
          ],
        },
      });
      const r = kernel.agent.start({ message: 'What time is it?', origin: 'user', actor: 'u' });
      const result = await r.done;
      expect(result.status).toBe('completed');
      expect(result.answer).toBe('It is about noon, by the clock I read.');
      // The third model read the whole conversation: the request, the first model's tool call and its result.
      const chat = third.requests.find((q) => q.body?.messages)?.body;
      const seen = chat.messages as Array<{ role: string; content: unknown; tool_calls?: unknown[] }>;
      expect(seen.some((m) => m.role === 'user' && JSON.stringify(m.content).includes('What time is it?'))).toBe(true);
      expect(seen.some((m) => m.role === 'assistant' && m.tool_calls?.length)).toBe(true);
      expect(seen.some((m) => m.role === 'tool')).toBe(true);
      expect(chat.model).toBe('m3');
      // The answer says which model wrote it; the audit log keeps each handover.
      const answer = kernel.conversations.get(result.conversationId).messages.at(-1);
      expect(answer).toMatchObject({ role: 'assistant', providerId: 'third', model: 'm3' });
      const handovers = kernel.audit.query({ category: 'agent' }).filter((e) => e.action === 'run.fallback') as unknown as Array<{ details: { from: string; to: string } }>;
      expect(handovers.map((h) => [h.details.from, h.details.to])).toEqual(
        expect.arrayContaining([
          ['first/m1', 'second/m2'],
          ['second/m2', 'third/m3'],
        ]),
      );
    } finally {
      await Promise.all([first.close(), second.close(), third.close()]);
      await cleanup();
    }
  });

  it('keeps an offline chat off cloud models, and fails as before when no fallback can take over', async () => {
    const { kernel, cleanup } = await makeKernel();
    const first = await mockOpenAI(() => ({ fail: 500 }));
    const cloud = await mockOpenAI(() => ({ text: 'from the cloud' }));
    try {
      kernel.settings.update({
        ai: { defaultProvider: 'first', defaultModel: 'm1', newChatsOffline: true, providers: [...DEFAULT_PROVIDERS, mock('first', first.url), mock('cloudy', cloud.url, true)], fallbacks: [{ providerId: 'cloudy', model: 'c1' }] },
      });
      const r = kernel.agent.start({ message: 'Hello', origin: 'user', actor: 'u' });
      const result = await r.done;
      expect(result.status).toBe('failed');
      expect(cloud.requests.filter((q) => q.body?.messages)).toHaveLength(0);
      // Without fallbacks, nothing changes.
      kernel.settings.update({ ai: { fallbacks: [] } });
      expect((await kernel.agent.start({ message: 'Hello again', origin: 'user', actor: 'u' }).done).status).toBe('failed');
    } finally {
      await Promise.all([first.close(), cloud.close()]);
      await cleanup();
    }
  });
});
