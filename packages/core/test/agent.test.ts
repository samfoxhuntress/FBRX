import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDERS, type AgentEvent } from '@fbrx/shared';
import { makeKernel, waitFor, USER } from './helpers';
import { mockAnthropic, mockOpenAI } from './mock-llm';

describe('agent (OpenAI-compatible / local runtime protocol)', () => {
  it('runs a governed tool loop and streams the final answer', async () => {
    const { kernel, sandbox, cleanup } = await makeKernel();
    writeFileSync(join(sandbox, 'a.txt'), 'one');
    writeFileSync(join(sandbox, 'b.txt'), 'two');
    const llm = await mockOpenAI((body, turn) => {
      if (turn === 0) {
        expect(body.tools.some((t: any) => t.function.name === 'fs__list_dir')).toBe(true);
        return { tool: { name: 'fs__list_dir', args: { path: sandbox } } };
      }
      const toolMsg = body.messages.find((m: any) => m.role === 'tool');
      expect(toolMsg.content).toContain('a.txt');
      return { text: 'There are two files: a.txt and b.txt.' };
    });
    try {
      kernel.settings.update({
        ai: {
          defaultProvider: 'mock',
          defaultModel: 'mock-model',
          providers: [...DEFAULT_PROVIDERS, { id: 'mock', type: 'openai-compatible', name: 'Mock', enabled: true, baseUrl: `${llm.url}/v1`, cloud: false }],
        },
      });
      const events: AgentEvent[] = [];
      kernel.events.on('agent', (e) => events.push(e));
      const { conversationId } = (await kernel.call('ai.chat', { message: 'What files are in my sandbox?' }, USER)) as any;
      await waitFor(() => events.find((e) => e.type === 'run.completed' || e.type === 'run.failed'));
      const done = events.find((e) => e.type === 'run.completed' || e.type === 'run.failed')!;
      expect(done.type).toBe('run.completed');
      expect(events.filter((e) => e.type === 'message.delta').map((e: any) => e.delta).join('')).toContain('two files');
      const tool = events.filter((e) => e.type === 'tool.updated').pop() as any;
      expect(tool.call.status).toBe('succeeded');

      const conv = kernel.conversations.get(conversationId);
      expect(conv.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
      expect(conv.messages[1].toolCalls?.[0]).toMatchObject({ name: 'fs.list_dir', status: 'succeeded' });
      expect(kernel.audit.query({ category: 'agent', limit: 1 })[0].action).toBe('run.completed');
      expect(kernel.audit.query({ category: 'tool', limit: 1 })[0].action).toBe('fs.list_dir');
    } finally {
      await llm.close();
      await cleanup();
    }
  });

  it('pauses for approval on risky tools and continues after the user approves', async () => {
    const { kernel, sandbox, cleanup } = await makeKernel();
    const target = join(sandbox, 'report.md');
    const llm = await mockOpenAI((_b, turn) => (turn === 0 ? { tool: { name: 'fs__write_file', args: { path: target, content: '# Report' } } } : { text: 'Saved the report.' }));
    try {
      kernel.settings.update({
        ai: { defaultProvider: 'mock', defaultModel: 'm', providers: [...DEFAULT_PROVIDERS, { id: 'mock', type: 'openai-compatible', name: 'Mock', enabled: true, baseUrl: `${llm.url}/v1`, cloud: false }] },
      });
      const r = kernel.agent.start({ message: 'Write a report', origin: 'user', actor: 'u' });
      const approval = await waitFor(() => kernel.approvals.list()[0]);
      expect(approval.runId).toBe(r.runId);
      await kernel.call('approvals.resolve', { id: approval.id, decision: 'approve' }, USER);
      const result = await r.done;
      expect(result.status).toBe('completed');
      expect(result.answer).toBe('Saved the report.');
    } finally {
      await llm.close();
      await cleanup();
    }
  });

  it('refuses cloud providers when policy forbids them', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      const p = structuredClone(kernel.policy.policy);
      p.ai.allowCloudProviders = false;
      kernel.policy.updateLocal(p);
      kernel.settings.update({ ai: { providers: DEFAULT_PROVIDERS.map((x) => (x.id === 'anthropic' ? { ...x, enabled: true } : x)) } });
      expect(() => kernel.agent.start({ message: 'hi', providerId: 'anthropic', origin: 'user', actor: 'u' })).toThrow(/disabled by policy/);
    } finally {
      await cleanup();
    }
  });
});

describe('agent (Claude via the Anthropic SDK)', () => {
  it('sends a well-formed Messages API request, replays thinking blocks and returns tool results in one user turn', async () => {
    const { kernel, cleanup } = await makeKernel();
    const llm = await mockAnthropic((_body, turn) => (turn === 0 ? { tool: { name: 'time__now', args: {} } } : { text: 'It is now.' }));
    try {
      kernel.vault.set({ name: 'ANTHROPIC_API_KEY', value: 'sk-ant-test-key-000000000000000000000' });
      kernel.settings.update({
        ai: {
          defaultProvider: 'anthropic',
          defaultModel: 'claude-opus-5-5',
          providers: DEFAULT_PROVIDERS.map((p) => (p.id === 'anthropic' ? { ...p, enabled: true, baseUrl: llm.url } : p)),
        },
      });
      const result = await kernel.agent.runToCompletion({ message: 'What time is it?', origin: 'user', actor: 'u' });
      expect(result.status).toBe('completed');
      expect(result.answer).toBe('It is now.');

      const [first, second] = llm.requests.filter((r) => r.path.startsWith('/v1/messages'));
      expect(first.headers['x-api-key']).toBe('sk-ant-test-key-000000000000000000000');
      expect(first.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
      expect(first.body).toMatchObject({ model: 'claude-opus-5-5', stream: true, fallbacks: 'default', cache_control: { type: 'ephemeral' }, output_config: { effort: 'high' } });
      expect(first.body.temperature).toBeUndefined();
      expect(first.body.tools.every((t: any) => t.eager_input_streaming === true && /^[a-zA-Z0-9_-]+$/.test(t.name))).toBe(true);
      expect(typeof first.body.system).toBe('string');

      const msgs = second.body.messages;
      const assistant = msgs[msgs.length - 2];
      expect(assistant.role).toBe('assistant');
      expect(assistant.content[0]).toMatchObject({ type: 'thinking', signature: 'sig-1' });
      expect(assistant.content[1]).toMatchObject({ type: 'tool_use', id: 'toolu_1', name: 'time__now' });
      const results = msgs[msgs.length - 1];
      expect(results.role).toBe('user');
      expect(results.content).toHaveLength(1);
      expect(results.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' });
    } finally {
      await llm.close();
      await cleanup();
    }
  });

  it('surfaces a refusal as a normal answer instead of running tools', async () => {
    const { kernel, cleanup } = await makeKernel();
    const llm = await mockAnthropic(() => ({ refusal: true }));
    try {
      kernel.vault.set({ name: 'ANTHROPIC_API_KEY', value: 'sk-ant-test-key-000000000000000000000' });
      kernel.settings.update({
        ai: { defaultProvider: 'anthropic', defaultModel: 'claude-opus-5-5', providers: DEFAULT_PROVIDERS.map((p) => (p.id === 'anthropic' ? { ...p, enabled: true, baseUrl: llm.url } : p)) },
      });
      const result = await kernel.agent.runToCompletion({ message: 'do something', origin: 'user', actor: 'u' });
      expect(result.status).toBe('completed');
      expect(result.answer).toMatch(/declined this request \(cyber\)/);
    } finally {
      await llm.close();
      await cleanup();
    }
  });
});
