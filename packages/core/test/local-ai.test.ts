import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDERS, THINKING_BUDGETS } from '@fbrx/shared';
import { briefDescription, shortlistTools } from '../src/ai/tool-shortlist';
import { agentFit } from '../src/ai/agent-fit';
import { OpenAICompatibleProvider } from '../src/ai/providers/openai-compatible';
import type { ToolSpec } from '../src/tools/types';
import { makeKernel, waitFor, USER } from './helpers';
import { mockOpenAI } from './mock-llm';

const tool = (name: string, title = name): ToolSpec => ({ name, title, description: `${title} does a thing. More words about it.`, risk: 'read', source: 'builtin', sourceId: null, inputSchema: { type: 'object' }, run: async () => ({ output: '' }) });
const TOOLS = ['time.now', 'memory.remember', 'memory.recall', 'fbrx.help', 'fs.read_file', 'fs.list_dir', 'docs.create', 'web.search', 'shield.scan', 'pc.live_status', 'weather.forecast'].map((n) => tool(n, n === 'weather.forecast' ? 'Weather forecast' : n));
const names = (t: ToolSpec[]) => t.map((x) => x.name);

describe('a local model reads less, so it answers sooner', () => {
  it('gets the tools the conversation is about, in the order subjects came up', () => {
    expect(names(shortlistTools(TOOLS, ['hi there']))).toEqual(['time.now', 'memory.remember', 'memory.recall', 'fbrx.help']);
    expect(names(shortlistTools(TOOLS, ['search the web for the news']))).toEqual(['time.now', 'memory.remember', 'memory.recall', 'fbrx.help', 'web.search']);
    // A later subject adds its tools at the end, so the start of the request stays the same.
    const first = names(shortlistTools(TOOLS, ['open the file on my desktop']));
    const later = names(shortlistTools(TOOLS, ['open the file on my desktop', 'is it a virus?']));
    expect(later.slice(0, first.length)).toEqual(first);
    expect(later.slice(first.length)).toEqual(['shield.scan']);
    // A plugin's tool comes in when its name or title comes up.
    expect(names(shortlistTools(TOOLS, ["what's the weather tomorrow?"]))).toContain('weather.forecast');
    expect(briefDescription('Reads a file. Only text files; binary files are refused.')).toBe('Reads a file.');
    expect(briefDescription('x'.repeat(400), 50)).toHaveLength(50);
  });

  it('asks a model on this computer to answer without thinking first, unless told it may', async () => {
    const llm = await mockOpenAI(() => ({ text: 'ok' }));
    try {
      const local = new OpenAICompatibleProvider({ id: 'rt', type: 'local-runtime', baseUrl: `${llm.url}/v1`, apiKey: () => undefined });
      for await (const _ of local.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [], reasoning: false, signal: AbortSignal.timeout(5000) }));
      for await (const _ of local.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [], reasoning: true, signal: AbortSignal.timeout(5000) }));
      const lan = new OpenAICompatibleProvider({ id: 'lan', type: 'openai-compatible', baseUrl: `${llm.url}/v1`, apiKey: () => undefined });
      for await (const _ of lan.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [], reasoning: false, signal: AbortSignal.timeout(5000) }));
      const bodies = llm.requests.filter((r) => r.path.endsWith('/chat/completions')).map((r) => r.body);
      expect(bodies[0].chat_template_kwargs).toEqual({ enable_thinking: false });
      expect(bodies[1].chat_template_kwargs).toEqual({ enable_thinking: true });
      // Only the built-in runtime is told (another server may not know the setting).
      expect(bodies[2].chat_template_kwargs).toBeUndefined();
    } finally {
      await llm.close();
    }
    expect([THINKING_BUDGETS.quick.localThinking, THINKING_BUDGETS.everyday.localThinking, THINKING_BUDGETS.thorough.localThinking]).toEqual([false, false, true]);
  });

  it('fits what it shows to how much the agent holds, or to what the person chose', () => {
    expect(agentFit({}, { historyBudgetChars: 20_480 })).toEqual({ tools: 'focused' }); // 8K tokens on this computer
    expect(agentFit({}, { historyBudgetChars: 81_920 })).toEqual({ tools: 'all' }); // 32K tokens
    expect(agentFit({}, { historyBudgetChars: 2_500_000 })).toEqual({ tools: 'all' }); // a cloud AI
    expect(agentFit({ tools: 'all' }, { historyBudgetChars: 20_480 })).toEqual({ tools: 'all' });
    expect(agentFit({ tools: 'focused' }, { historyBudgetChars: 2_500_000 })).toEqual({ tools: 'focused' });
  });

  it('sends a small model a short list of tools and a roomy one them all; what it remembers rides with the message for both', async () => {
    const llm = await mockOpenAI(() => ({ text: 'Done.' }));
    const { kernel, cleanup } = await makeKernel();
    try {
      const provider = (id: string, cloud: boolean) => ({ id, type: 'openai-compatible' as const, name: id, enabled: true, baseUrl: `${llm.url}/v1`, cloud });
      kernel.settings.update({ ai: { defaultProvider: 'lan', defaultModel: 'mock-model', providers: [...DEFAULT_PROVIDERS, provider('lan', false), provider('far', true)] }, memory: { enabled: true, longTerm: true } } as never);
      await kernel.call('memory.add', { content: 'Prefers short answers' }, USER);
      const ask = async (message: string, providerId: string) => {
        const before = llm.requests.length;
        const { runId } = (await kernel.call('ai.chat', { message, providerId, model: 'mock-model' }, USER)) as { runId: string };
        await waitFor(() => llm.requests.length > before && !kernel.agent.activities().some((a) => a.runId === runId));
        return llm.requests.at(-1)!.body;
      };
      const local = await ask('why is my computer so slow?', 'lan');
      const toolNames = local.tools.map((t: { function: { name: string } }) => t.function.name);
      expect(toolNames).toContain('system__processes');
      expect(toolNames).not.toContain('web__search');
      expect(toolNames.length).toBeLessThan(20);
      // What it remembers rides with the person's message; the instructions stay the same from one request to the next.
      expect(local.messages[0].content).not.toContain('Prefers short answers');
      expect(local.messages.at(-1).content).toMatch(/^<memory>[\s\S]*Prefers short answers[\s\S]*<\/memory>\n\nwhy is my computer so slow\?$/);
      const cloud = await ask('why is my computer so slow?', 'far');
      expect(cloud.tools.length).toBeGreaterThan(40);
      // The same instructions for both, so a cloud AI's prompt cache holds across the conversation too.
      expect(cloud.messages[0].content).toBe(local.messages[0].content);
      expect(cloud.messages.at(-1).content).toContain('Prefers short answers');
    } finally {
      await cleanup();
      await llm.close();
    }
  });
});
