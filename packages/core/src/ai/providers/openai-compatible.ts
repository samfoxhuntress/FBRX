import type { ModelInfo, ProviderType } from '@fbrx/shared';
import { parseSse } from './sse';
import { ThinkSplitter } from './think';
import {
  ProviderHttpError,
  readErrorBody,
  type ChatProvider,
  type ChatRequest,
  type ProviderChunk,
  type ProviderMessage,
  type ProviderToolCall,
} from './types';

export interface OpenAICompatibleOptions {
  id: string;
  type: ProviderType;
  baseUrl: string;
  apiKey?: () => string | undefined;
  defaultModel?: string;
  historyBudgetChars?: number;
  /** Send `stream_options.include_usage` (supported by OpenAI and llama.cpp). */
  includeUsage?: boolean;
}

/**
 * OpenAI Chat Completions protocol. Powers the built-in local runtime (llama.cpp server), LM Studio, vLLM,
 * LocalAI and OpenAI itself.
 */
export class OpenAICompatibleProvider implements ChatProvider {
  readonly id: string;
  readonly type: ProviderType;
  readonly historyBudgetChars: number;

  constructor(private readonly o: OpenAICompatibleOptions) {
    this.id = o.id;
    this.type = o.type;
    this.historyBudgetChars = o.historyBudgetChars ?? 400_000;
  }

  private url(path: string) {
    return `${this.o.baseUrl.replace(/\/+$/, '')}${path}`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    const key = this.o.apiKey?.();
    if (key) h.authorization = `Bearer ${key}`;
    return h;
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await fetch(this.url('/models'), { headers: this.headers(), signal: signal ?? AbortSignal.timeout(8000) });
    if (!res.ok) throw new ProviderHttpError(res.status, await readErrorBody(res));
    const body = (await res.json()) as { data?: Array<{ id: string }> };
    return (body.data ?? []).map((m) => ({ id: m.id, name: m.id, providerId: this.id }));
  }

  async health(signal?: AbortSignal) {
    try {
      await this.listModels(signal);
      return { ok: true, message: null };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  private toWire(messages: ProviderMessage[]) {
    return messages.map((m) => {
      switch (m.role) {
        case 'assistant':
          return {
            role: 'assistant',
            content: m.content || null,
            ...(m.toolCalls?.length
              ? {
                  tool_calls: m.toolCalls.map((c) => ({
                    id: c.id,
                    type: 'function',
                    function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
                  })),
                }
              : {}),
          };
        case 'tool':
          return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
        default:
          return { role: m.role, content: m.content };
      }
    });
  }

  async *chat(req: ChatRequest): AsyncGenerator<ProviderChunk> {
    const body: Record<string, unknown> = {
      model: req.model || this.o.defaultModel || 'default',
      messages: this.toWire(req.messages),
      stream: true,
      ...(this.o.includeUsage !== false ? { stream_options: { include_usage: true } } : {}),
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.maxTokens) body.max_tokens = req.maxTokens;
    if (req.tools.length) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.tool_choice = 'auto';
    }
    const res = await fetch(this.url('/chat/completions'), {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: req.signal,
    });
    if (!res.ok || !res.body) throw new ProviderHttpError(res.status, await readErrorBody(res));

    const calls = new Map<number, { id: string; name: string; args: string }>();
    const think = new ThinkSplitter();
    let finish: string | null = null;
    for await (const ev of parseSse(res.body)) {
      if (ev.data === '[DONE]') break;
      let chunk: any;
      try {
        chunk = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (chunk.error) throw new Error(chunk.error.message ?? String(chunk.error));
      if (chunk.usage) {
        yield { type: 'usage', inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 };
      }
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};
      // llama.cpp, vLLM and DeepSeek send reasoning as reasoning_content; OpenRouter and others as reasoning.
      const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : typeof delta.reasoning === 'string' ? delta.reasoning : '';
      if (reasoning) yield { type: 'thinking', delta: reasoning };
      if (typeof delta.content === 'string' && delta.content) yield* think.push(delta.content);
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const cur = calls.get(idx) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(idx, cur);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    yield* think.flush();
    const toolCalls: ProviderToolCall[] = [];
    for (const [idx, c] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      let args: unknown = {};
      try {
        args = c.args.trim() ? JSON.parse(c.args) : {};
      } catch {
        args = { __invalid_json__: c.args };
      }
      const call = { id: c.id || `call_${idx}_${Date.now()}`, name: c.name, arguments: args };
      toolCalls.push(call);
      yield { type: 'tool_call', call };
    }
    yield {
      type: 'done',
      finishReason: toolCalls.length ? 'tool_calls' : finish === 'length' ? 'length' : 'stop',
    };
  }
}
