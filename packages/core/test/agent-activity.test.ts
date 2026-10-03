import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PROVIDERS, type AgentEvent } from '@fbrx/shared';
import { makeKernel, tempDir, USER } from './helpers';
import { mockOpenAI } from './mock-llm';
import { ThinkSplitter } from '../src/ai/providers/think';
import { describeCall } from '../src/ai/agent';
import { VOICE_FILES, VoiceModels } from '../src/ai/voice-models';
import { EventBus } from '../src/events';
import { LogSink, Logger } from '../src/logger';

const useMock = (kernel: any, url: string) =>
  kernel.settings.update({ ai: { defaultProvider: 'mock', defaultModel: 'm', providers: [...DEFAULT_PROVIDERS, { id: 'mock', type: 'openai-compatible', name: 'Mock', enabled: true, baseUrl: `${url}/v1`, cloud: false }] } });

async function runChat(kernel: any, message: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const off = kernel.events.on('agent', (e: AgentEvent) => events.push(e));
  const r = (await kernel.call('ai.chat', { message }, USER)) as any;
  void r;
  for (let i = 0; i < 200 && !events.some((e) => e.type === 'run.completed' || e.type === 'run.failed'); i++) await new Promise((res) => setTimeout(res, 25));
  off();
  return events;
}

describe('thinking inside the answer', () => {
  it('moves a leading <think> block out of the text, across chunk boundaries', () => {
    const t = new ThinkSplitter();
    const out = [...t.push('  <thi'), ...t.push('nk>Let me check the disk'), ...t.push(' first.</th'), ...t.push('ink>\n\nYou have 20 GB free.'), ...t.flush()];
    const thinking = out.filter((c) => c.type === 'thinking').map((c: any) => c.delta).join('');
    const text = out.filter((c) => c.type === 'text').map((c: any) => c.delta).join('');
    expect(thinking).toBe('Let me check the disk first.');
    expect(text).toBe('You have 20 GB free.');
  });

  it('leaves answers alone that merely mention the tag, or never close it', () => {
    const a = new ThinkSplitter();
    const out = [...a.push('Use the <think> tag like this.'), ...a.flush()];
    expect(out).toEqual([{ type: 'text', delta: 'Use the <think> tag like this.' }]);
    const b = new ThinkSplitter();
    const open = [...b.push('<think>still going'), ...b.flush()];
    expect(open.every((c) => c.type === 'thinking')).toBe(true);
  });

  it('describes tool calls for the activity panel', () => {
    expect(describeCall({ title: 'List a folder' }, { path: 'C:\\Users\\Sam\\Downloads' })).toBe('List a folder: C:\\Users\\Sam\\Downloads');
    expect(describeCall({ title: 'Current time' }, {})).toBe('Current time');
    expect(describeCall({ title: 'Read a web page' }, { url: `https://example.com/${'x'.repeat(120)}` })).toMatch(/…$/);
  });
});

describe('agent activity and work budget', () => {
  it('streams progress and thinking, stores the thinking, and passes the answer-length limit', async () => {
    const { kernel, cleanup } = await makeKernel();
    const llm = await mockOpenAI((_b, turn) => (turn === 0 ? { reasoning: 'The user wants the time. ', tool: { name: 'time__now', args: {} } } : { reasoning: 'Now I can answer. ', text: 'It is lunchtime.' }));
    try {
      useMock(kernel, llm.url);
      kernel.settings.update({ ai: { maxOutputTokens: 4096 } });
      const events = await runChat(kernel, 'What time is it?');
      const phases = events.filter((e) => e.type === 'run.progress').map((e: any) => e.phase);
      expect(phases).toEqual(expect.arrayContaining(['model', 'thinking', 'tool', 'reading', 'writing']));
      const tool = events.find((e: any) => e.type === 'run.progress' && e.phase === 'tool') as any;
      expect(tool.detail).toMatch(/time/i);
      expect(tool.maxSteps).toBe(30);
      const thinking = events.filter((e) => e.type === 'thinking.delta').map((e: any) => e.delta).join('');
      expect(thinking).toContain('The user wants the time.');
      expect(thinking).toContain('Now I can answer.');
      const last = events.filter((e) => e.type === 'message.completed').pop() as any;
      expect(last.message.content).toBe('It is lunchtime.');
      expect(last.message.thinking).toContain('Now I can answer.');
      // Thinking is shown, never sent back to the model as text.
      const second = llm.requests.filter((r) => r.path?.includes('/chat/completions'))[1].body;
      expect(JSON.stringify(second.messages)).not.toContain('The user wants the time');
      expect(second.max_tokens).toBe(4096);
      // And it survives reopening the conversation.
      const conv = (await kernel.call('ai.conversations.get', { id: last.conversationId }, USER)) as any;
      expect(conv.messages.find((m: any) => m.role === 'assistant' && m.content === 'It is lunchtime.').thinking).toContain('Now I can answer.');
    } finally {
      await llm.close();
      await cleanup();
    }
  });

  it('says so when a task runs out of steps instead of stopping silently', async () => {
    const { kernel, cleanup } = await makeKernel();
    const llm = await mockOpenAI(() => ({ tool: { name: 'time__now', args: {} } }));
    try {
      useMock(kernel, llm.url);
      const policy = structuredClone(kernel.policy.policy);
      policy.ai.maxStepsPerRun = 2;
      kernel.policy.updateLocal(policy);
      const events = await runChat(kernel, 'Keep checking the time forever');
      const last = events.filter((e) => e.type === 'message.completed').pop() as any;
      expect(last.message.content).toMatch(/used all 2 steps/);
      expect(last.message.content).toMatch(/continue/);
      expect(events.some((e) => e.type === 'run.completed')).toBe(true);
    } finally {
      await llm.close();
      await cleanup();
    }
  });
});

describe('voice models', () => {
  it('downloads a model from a mirror with progress, serves its files safely and removes it', async () => {
    const files = new Map(VOICE_FILES.map((f) => [f, Buffer.alloc(f.endsWith('.onnx') ? 300_000 : 200, f.length)]));
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.url ?? '');
      const m = /^\/Xenova\/whisper-tiny\.en\/resolve\/main\/(.+)$/.exec(req.url ?? '');
      const body = m ? files.get(m[1] as never) : undefined;
      if (!body) return res.writeHead(404).end();
      res.writeHead(200, { 'content-length': String(body.length) }).end(body);
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const prev = process.env.FBRX_VOICE_MODEL_BASE;
    process.env.FBRX_VOICE_MODEL_BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const dir = join(tempDir('fbrx-voice-'), 'voice');
    const events = new EventBus();
    const seen: any[] = [];
    events.on('voice.download', (e) => seen.push(e));
    try {
      let online = false;
      const vm = new VoiceModels({ dir, events, log: new Logger(new LogSink(), 'voice'), internet: () => online });
      expect(() => vm.install('whisper-tiny.en')).toThrow(/blocks internet/);
      online = true;
      expect(vm.list().find((m) => m.id === 'whisper-tiny.en')!.installed).toBe(false);
      vm.install('whisper-tiny.en');
      expect(() => vm.install('whisper-base.en')).toThrow(/Another voice model/);
      for (let i = 0; i < 200 && !seen.some((e) => e.done); i++) await new Promise((r) => setTimeout(r, 25));
      const done = seen.find((e) => e.done);
      expect(done).toMatchObject({ model: 'whisper-tiny.en', error: null });
      expect(vm.installed('whisper-tiny.en')).toBe(true);
      expect(hits).toHaveLength(VOICE_FILES.length);
      expect(vm.resolveFile('Xenova/whisper-tiny.en/onnx/encoder_model_quantized.onnx')).toMatch(/encoder_model_quantized\.onnx$/);
      expect(vm.resolveFile('../../../../etc/passwd')).toBeNull();
      expect(vm.resolveFile('Xenova/whisper-tiny.en/%2e%2e/%2e%2e/%2e%2e/secret')).toBeNull();
      vm.remove('whisper-tiny.en');
      expect(vm.installed('whisper-tiny.en')).toBe(false);
      expect(existsSync(join(dir, 'Xenova', 'whisper-tiny.en'))).toBe(false);
      // A failed download is reported, and a later attempt starts cleanly.
      mkdirSync(join(dir, 'Xenova', 'whisper-base.en'), { recursive: true });
      writeFileSync(join(dir, 'Xenova', 'whisper-base.en', 'config.json'), '{}');
      seen.length = 0;
      vm.install('whisper-base.en');
      for (let i = 0; i < 200 && !seen.some((e) => e.done); i++) await new Promise((r) => setTimeout(r, 25));
      expect(seen.find((e) => e.done).error).toMatch(/HTTP 404/);
      expect(vm.installed('whisper-base.en')).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.FBRX_VOICE_MODEL_BASE;
      else process.env.FBRX_VOICE_MODEL_BASE = prev;
      server.close();
    }
  });

  it('is managed only by the person at the computer', async () => {
    const { kernel, cleanup } = await makeKernel();
    try {
      expect(((await kernel.call('voice.models', undefined, USER)) as any[]).map((m) => m.id)).toContain('whisper-base.en');
      await expect(kernel.call('voice.install', { model: 'whisper-base.en' }, { origin: 'api', actor: 'localapi:agent' })).rejects.toThrow(/person at this workstation/);
      await expect(kernel.call('voice.install', { model: 'nope' }, USER)).rejects.toThrow();
    } finally {
      await cleanup();
    }
  });
});
