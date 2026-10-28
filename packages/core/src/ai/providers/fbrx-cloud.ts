import type { CloudAiUsage, ModelInfo } from '@fbrx/shared';
import { CoreError } from '../../errors';
import { OpenAICompatibleProvider } from './openai-compatible';
import type { ChatProvider, ChatRequest, ProviderChunk } from './types';

/** Where FBRX Cloud AI is for the signed-in FBRX account, and the account's sign-in to use as the key. */
export interface CloudAiAccess {
  baseUrl: string;
  token: string;
}

export interface FbrxCloudOptions {
  id: string;
  /** Null when no FBRX account is signed in on this computer. */
  access: () => CloudAiAccess | null;
  /** The account's month: whether FBRX Cloud AI takes its chats now, and why not. */
  usage: (signal?: AbortSignal) => Promise<CloudAiUsage>;
  defaultModel?: string;
}

/**
 * FBRX Cloud AI: FBRX's models, through the FBRX Command the account lives on, with the account's sign-in as the key
 * (FBRX Command holds the model provider's). FBRX Command counts the tokens and passes the chat on; nothing else sees
 * it. Being ready means the account may chat now, so the AI models page says why not (the month's tokens used, say)
 * before a chat fails on it.
 */
export class FbrxCloudProvider implements ChatProvider {
  readonly id: string;
  readonly type = 'fbrx-cloud' as const;
  /** About 25,000 tokens of conversation: within what FBRX's cloud models hold, and enough for every tool. */
  readonly historyBudgetChars = 100_000;

  constructor(private readonly o: FbrxCloudOptions) {
    this.id = o.id;
  }

  private inner(): OpenAICompatibleProvider {
    const a = this.o.access();
    if (!a) throw new CoreError('UNAUTHENTICATED', 'Sign in to your FBRX account to use FBRX Cloud AI');
    return new OpenAICompatibleProvider({ id: this.id, type: this.type, baseUrl: a.baseUrl, apiKey: () => a.token, defaultModel: this.o.defaultModel, historyBudgetChars: this.historyBudgetChars });
  }

  listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    return this.inner().listModels(signal);
  }

  async health(signal?: AbortSignal): Promise<{ ok: boolean; message: string | null }> {
    try {
      const u = await this.o.usage(signal);
      return { ok: !u.message, message: u.message };
    } catch (err) {
      return { ok: false, message: (err as Error).message };
    }
  }

  chat(req: ChatRequest): AsyncIterable<ProviderChunk> {
    return this.inner().chat(req);
  }
}
