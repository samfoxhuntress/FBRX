import Anthropic from '@anthropic-ai/sdk';
import type { ModelInfo } from '@fbrx/shared';
import type { ChatProvider, ChatRequest, ProviderChunk, ProviderMessage, ProviderToolCall } from './types';

type ContentBlock = Anthropic.Beta.BetaContentBlock;
type MessageParam = Anthropic.Beta.BetaMessageParam;

/** Models that accept the server-side `fallbacks: "default"` refusal fallback on the Claude API. */
const FALLBACK_DEFAULT = /^claude-(opus-5(-5)?|fable-5-1|sonnet-5-5)$/;
/** Models where sampling parameters (temperature) were removed and return a 400. */
const NO_SAMPLING = /^claude-(opus-(4-[78]|5)|sonnet-5|fable|mythos)/;
/** Models that accept `output_config.effort`. */
/** Models with adaptive thinking (older ones would need a fixed thinking budget, so they are left as they are). */
const ADAPTIVE = /^claude-(opus-(4-[6-9]|5)|sonnet-(4-6|5)|fable|mythos)/;
const SUPPORTS_EFFORT = /^claude-(opus-(4-[5-9]|5)|sonnet-(4-6|5)|fable|mythos)/;

export interface AnthropicProviderOptions {
  id: string;
  baseUrl?: string;
  apiKey: () => string | undefined;
  defaultModel?: string;
}

/**
 * Claude via the official Anthropic SDK (streaming Messages API + client tools).
 *
 * - Adaptive thinking with a summarized display on models that support it (shown live in the app); thinking blocks are replayed
 *   unchanged on later turns, and history is append-only, so preserved-thinking checks pass.
 * - `fallbacks: "default"` is enabled for models that support it, so a policy decline is retried server-side
 *   on Anthropic's recommended fallback model instead of failing the agent run.
 * - Tools stream eagerly; inputs are schema-validated by the FBRX tool gate before anything runs.
 */
export class AnthropicProvider implements ChatProvider {
  readonly type = 'anthropic' as const;
  readonly id: string;
  /** 1M-token context: never trim history (trimming would also edit replayed thinking context). */
  readonly historyBudgetChars = 2_500_000;

  constructor(private readonly o: AnthropicProviderOptions) {
    this.id = o.id;
  }

  private client(): Anthropic {
    const apiKey = this.o.apiKey();
    if (!apiKey) throw new Error('No Anthropic API key. Add it to the vault as ANTHROPIC_API_KEY (or the secret named in provider settings).');
    return new Anthropic({ apiKey, baseURL: this.o.baseUrl || undefined, maxRetries: 2 });
  }

  async listModels(): Promise<ModelInfo[]> {
    const out: ModelInfo[] = [];
    for await (const m of this.client().models.list()) {
      out.push({ id: m.id, name: m.display_name, providerId: this.id, contextLength: (m as { max_input_tokens?: number }).max_input_tokens });
    }
    return out;
  }

  async health() {
    try {
      await this.client().models.list({ limit: 1 });
      return { ok: true, message: null };
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) return { ok: false, message: 'Anthropic rejected the API key' };
      if (err instanceof Anthropic.APIConnectionError) return { ok: false, message: 'Cannot reach the Anthropic API' };
      return { ok: false, message: (err as Error).message };
    }
  }

  private toWire(messages: ProviderMessage[]): { system: string; messages: MessageParam[] } {
    const system: string[] = [];
    const out: MessageParam[] = [];
    let pendingResults: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    const flushResults = () => {
      if (pendingResults.length) {
        // All results for one assistant turn go back in a single user message.
        out.push({ role: 'user', content: pendingResults });
        pendingResults = [];
      }
    };
    for (const m of messages) {
      if (m.role === 'system') {
        system.push(m.content);
        continue;
      }
      if (m.role === 'tool') {
        pendingResults.push({ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content, ...(m.isError ? { is_error: true } : {}) });
        continue;
      }
      flushResults();
      if (m.role === 'user') {
        out.push({ role: 'user', content: m.content });
      } else if (m.providerData?.providerType === 'anthropic' && Array.isArray(m.providerData.raw)) {
        out.push({ role: 'assistant', content: m.providerData.raw as Anthropic.Beta.BetaContentBlockParam[] });
      } else {
        const blocks: Anthropic.Beta.BetaContentBlockParam[] = [];
        if (m.content.trim()) blocks.push({ type: 'text', text: m.content });
        for (const c of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: sanitizeId(c.id), name: c.name, input: (c.arguments ?? {}) as Record<string, unknown> });
        if (blocks.length) out.push({ role: 'assistant', content: blocks });
      }
    }
    flushResults();
    return { system: system.join('\n\n'), messages: out };
  }

  async *chat(req: ChatRequest): AsyncGenerator<ProviderChunk> {
    const model = req.model || this.o.defaultModel || 'claude-opus-5-5';
    const client = this.client();
    const { system, messages } = this.toWire(req.messages);
    const tools: Anthropic.Beta.BetaToolUnion[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema,
      eager_input_streaming: true,
    }));
    const params: Anthropic.Beta.MessageCreateParamsStreaming = {
      model,
      max_tokens: req.maxTokens ?? 64000,
      messages,
      stream: true,
      // Caches the stable prefix (tools → system → history) across turns of the agent loop.
      cache_control: { type: 'ephemeral' },
      ...(system ? { system } : {}),
      ...(tools.length ? { tools } : {}),
      // Summarized thinking is shown live while the agent works (the default display is "omitted": empty text).
      ...(ADAPTIVE.test(model) ? { thinking: { type: 'adaptive' as const, display: 'summarized' as const } } : {}),
      ...(SUPPORTS_EFFORT.test(model) ? { output_config: { effort: 'high' as const } } : {}),
      ...(req.temperature !== undefined && !NO_SAMPLING.test(model) ? { temperature: req.temperature } : {}),
      ...(FALLBACK_DEFAULT.test(model) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    };

    let message: Anthropic.Beta.BetaMessage | null = null;
    for (let attempt = 0; attempt < 3 && !message; attempt++) {
      const stream = client.beta.messages.stream(params, { signal: req.signal });
      let emittedText = false;
      try {
        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            emittedText = true;
            yield { type: 'text', delta: event.delta.text };
          } else if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta' && event.delta.thinking) {
            yield { type: 'thinking', delta: event.delta.thinking };
          }
        }
        message = await stream.finalMessage();
      } catch (err) {
        // With eager input streaming the SDK rejects when a tool input is not parseable JSON. Re-issue the
        // turn when nothing has been shown yet; API errors are never retried here (the SDK already retried).
        if (err instanceof Anthropic.APIError || emittedText || attempt === 2 || req.signal.aborted) throw err;
      }
    }
    if (!message) throw new Error('Anthropic stream ended without a message');

    const u = message.usage;
    yield {
      type: 'usage',
      inputTokens: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      outputTokens: u.output_tokens ?? 0,
    };

    const content = echoableContent(message.content);
    const providerData = { providerType: 'anthropic' as const, model: message.model, raw: content };

    if (message.stop_reason === 'refusal') {
      const details = (message as { stop_details?: { category?: string | null; explanation?: string | null } | null }).stop_details;
      yield {
        type: 'done',
        finishReason: 'refusal',
        servedModel: message.model,
        providerData,
        message: `The model declined this request${details?.category ? ` (${details.category})` : ''}${details?.explanation ? `: ${details.explanation}` : '.'}`,
      };
      return;
    }

    const toolUses = content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (toolUses.length && (message.stop_reason === 'max_tokens' || message.stop_reason === 'model_context_window_exceeded')) {
      // A tool input cut off at the token limit can still parse as a valid partial object: never run it.
      yield { type: 'done', finishReason: 'length', servedModel: message.model, providerData, message: 'Tool input was truncated at the output limit' };
      return;
    }
    const calls: ProviderToolCall[] = toolUses.map((b) => ({ id: b.id, name: b.name, arguments: b.input }));
    for (const call of calls) yield { type: 'tool_call', call };
    yield {
      type: 'done',
      finishReason: calls.length ? 'tool_calls' : message.stop_reason === 'max_tokens' ? 'length' : 'stop',
      servedModel: message.model,
      providerData,
    };
  }
}

/**
 * Content to replay on the next request. After a mid-output fallback, thinking/tool_use blocks from the
 * declined attempt (everything before the last `fallback` block, except text) are dropped; the `fallback`
 * audit markers themselves are not echoed.
 */
function echoableContent(content: ContentBlock[]): ContentBlock[] {
  const lastFallback = content.map((b) => b.type).lastIndexOf('fallback');
  return content.filter((b, i) => {
    if (b.type === 'fallback') return false;
    if (i < lastFallback) return b.type === 'text';
    return b.type === 'text' || b.type === 'thinking' || b.type === 'redacted_thinking' || b.type === 'tool_use';
  });
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || `toolu_${Date.now()}`;
}
