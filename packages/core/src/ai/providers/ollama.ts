import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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
    const body = (await res.json()) as { models?: Array<{ name: string; size?: number; details?: { parameter_size?: string; quantization_level?: string; family?: string } }> };
    return sortModels(
      (body.models ?? []).map((m) => ({
        id: m.name,
        name: m.name,
        providerId: this.id,
        sizeBytes: m.size,
        details: [m.details?.parameter_size, m.details?.quantization_level, m.details?.family].filter(Boolean).join(' · ') || undefined,
      })),
    );
  }

  /** The model to use when none was chosen: the installed model best suited to tool calling. */
  async pickModel(signal?: AbortSignal): Promise<string> {
    const models = await this.listModels(signal);
    if (!models.length) throw new Error('Ollama has no models yet. Download one, for example: ollama pull qwen2.5:7b');
    return models[0].id;
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
    const model = req.model || this.defaultModel || (await this.pickModel(req.signal));
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
    if (res.status === 404) {
      const detail = await readErrorBody(res);
      const installed = await this.listModels().catch(() => []);
      throw new Error(
        `Ollama does not have the model "${model}". ${installed.length ? `Installed: ${installed.map((m) => m.id).join(', ')} — pick one in the model list` : 'No models are installed'}, or download it with: ollama pull ${model}${detail ? ` (${detail})` : ''}`,
      );
    }
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

/** Families known to handle tool calling well come first; embedding-only models last; then by name. */
const TOOL_FAMILIES = [/^qwen3/, /^qwen2\.5/, /^llama3\.[1-9]|^llama4/, /^gemma4|^gemma3/, /^mistral/, /^granite/, /^phi4/, /^deepseek/, /^command-r/];
export function sortModels(models: ModelInfo[]): ModelInfo[] {
  const rank = (id: string) => {
    if (/embed/i.test(id)) return 99;
    const i = TOOL_FAMILIES.findIndex((re) => re.test(id));
    return i < 0 ? TOOL_FAMILIES.length : i;
  };
  return [...models].sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
}

/**
 * Models Ollama has downloaded, read from its model folder (`OLLAMA_MODELS`, or `.ollama/models` in the user's
 * home): manifests/<registry>/<namespace>/<model>/<tag>. Used to show them while the Ollama server is not running.
 */
export function ollamaModelsOnDisk(root = process.env.OLLAMA_MODELS || join(homedir(), '.ollama', 'models')): string[] {
  const manifests = join(root, 'manifests');
  if (!existsSync(manifests)) return [];
  const out: string[] = [];
  const dirs = (p: string) => {
    try {
      return readdirSync(p).filter((n) => statSync(join(p, n)).isDirectory());
    } catch {
      return [];
    }
  };
  for (const registry of dirs(manifests)) {
    for (const ns of dirs(join(manifests, registry))) {
      for (const model of dirs(join(manifests, registry, ns))) {
        let tags: string[] = [];
        try {
          tags = readdirSync(join(manifests, registry, ns, model)).filter((t) => statSync(join(manifests, registry, ns, model, t)).isFile());
        } catch {
          /* unreadable */
        }
        const prefix = registry === 'registry.ollama.ai' ? (ns === 'library' ? '' : `${ns}/`) : `${registry}/${ns}/`;
        for (const tag of tags) out.push(`${prefix}${model}:${tag}`);
      }
    }
  }
  return out.sort();
}
