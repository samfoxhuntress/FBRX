import type { ModelInfo, ProviderType } from '@fbrx/shared';

export interface ProviderToolCall {
  id: string;
  /** Provider-safe tool name (dots mapped to `__`). */
  name: string;
  arguments: unknown;
}

/** Opaque, provider-native representation of an assistant turn, replayed verbatim (append-only history). */
export interface ProviderData {
  providerType: ProviderType;
  model: string;
  raw: unknown;
}

export type ProviderMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ProviderToolCall[]; providerData?: ProviderData | null }
  | { role: 'tool'; toolCallId: string; name: string; content: string; isError?: boolean };

export interface ProviderTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: ProviderMessage[];
  tools: ProviderTool[];
  temperature?: number;
  maxTokens?: number;
  signal: AbortSignal;
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'refusal' | 'error';

export type ProviderChunk =
  | { type: 'text'; delta: string }
  /** What the model is thinking (a summary on some providers); shown to the user, never sent back as text. */
  | { type: 'thinking'; delta: string }
  | { type: 'tool_call'; call: ProviderToolCall }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'done'; finishReason: FinishReason; providerData?: ProviderData; servedModel?: string; message?: string };

export interface ChatProvider {
  readonly id: string;
  readonly type: ProviderType;
  /** Approximate characters of history the model can take (used to trim old turns for small local models). */
  readonly historyBudgetChars: number;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  health(signal?: AbortSignal): Promise<{ ok: boolean; message: string | null }>;
  chat(req: ChatRequest): AsyncIterable<ProviderChunk>;
}

export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function readErrorBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      return j?.error?.message ?? j?.error ?? j?.message ?? text.slice(0, 500);
    } catch {
      return text.slice(0, 500);
    }
  } catch {
    return res.statusText;
  }
}
