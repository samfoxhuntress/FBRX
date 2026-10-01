import type { ModelInfo } from '@fbrx/shared';
import { parseNdjson } from './sse';
import { ProviderHttpError, readErrorBody, type ChatProvider, type ChatRequest, type ProviderChunk, type ProviderMessage } from './types';

/** Ollama native API (`/api/chat`), including tool calling. */
export class OllamaProvider implements ChatProvider {
  readonly type = 'ollama' as const;
  readonly historyBudgetChars: number;

  constructor(
    readonly id: string,
    private readonly baseUrl: string,
    private readonly defaultModel?: string,
    historyBudgetChars = 60_000,
  ) {
    this.historyBudgetChars = historyBudgetChars;
  }

  private url(p: string) {
    return `${this.baseUrl.replace(/\/+$/, '')}${p}`;
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await fetch(this.url('/api/tags'), { signal: signal ?? AbortSignal.timeout(5000) });
    if (!res.ok) throw new ProviderHttpError(res.status, await readErrorBody(res));
    const body = (await res.json()) as { models?: Array<{ name: string; size?: number }> };
    return (body.models ?? []).map((m) => ({ id: m.name, name: m.name, providerId: this.id, sizeBytes: m.size }));
  }

  async health(signal?: AbortSignal) {
    try {
      const models = await this.listModels(signal);
      return { ok: true, message: models.length ? null : 'Ollama is running but has no models (ollama pull <model>)' };
    } catch (err) {
      return { ok: false, message: `Ollama not reachable at ${this.baseUrl}: ${(err as Error).message}` };
    }
  }

  private toWire(messages: ProviderMessage[]) {
    return messages.map((m) => {
      if (m.role === 'assistant') {
        return {
          role: 'assistant',
          content: m.content,
          ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.arguments ?? {} } })) } : {}),
        };
      }
      if (m.role === 'tool') return { role: 'tool', content: m.content, tool_name: m.name };
      return { role: m.role, content: m.content };
    });
  }

  async *chat(req: ChatRequest): AsyncGenerator<ProviderChunk> {
    const model = req.model || this.defaultModel;
    if (!model) throw new Error('No Ollama model selected');
    const res = await fetch(this.url('/api/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: this.toWire(req.messages),
        stream: true,
        ...(req.tools.length
          ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } })) }
          : {}),
        options: { ...(req.temperature !== undefined ? { temperature: req.temperature } : {}), ...(req.maxTokens ? { num_predict: req.maxTokens } : {}) },
      }),
      signal: req.signal,
    });
    if (!res.ok || !res.body) throw new ProviderHttpError(res.status, await readErrorBody(res));
    let n = 0;
    let sawTools = false;
    let reason: string | undefined;
    for await (const raw of parseNdjson(res.body)) {
      const chunk = raw as any;
      if (chunk.error) throw new Error(chunk.error);
      const msg = chunk.message;
      if (msg?.content) yield { type: 'text', delta: msg.content };
      for (const tc of msg?.tool_calls ?? []) {
        sawTools = true;
        yield { type: 'tool_call', call: { id: `call_${Date.now()}_${n++}`, name: tc.function?.name, arguments: tc.function?.arguments ?? {} } };
      }
      if (chunk.done) {
        reason = chunk.done_reason;
        yield { type: 'usage', inputTokens: chunk.prompt_eval_count ?? 0, outputTokens: chunk.eval_count ?? 0 };
      }
    }
    yield { type: 'done', finishReason: sawTools ? 'tool_calls' : reason === 'length' ? 'length' : 'stop' };
  }
}
