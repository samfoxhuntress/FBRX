import { DIGGER_AI_PROVIDER, type CloudAiUsage, type LentModel, type ModelInfo, type ProviderConfig, type ProviderStatus } from '@fbrx/shared';
import type { ModelLine } from './model-line';
import { CoreError } from '../errors';
import type { SettingsService } from '../settings/settings-service';
import type { Vault } from '../vault/vault';
import type { PolicyEngine } from '../governance/policy-engine';
import type { LicenseService } from '../license/license-service';
import type { LocalRuntime } from './runtime/local-runtime';
import { AnthropicProvider } from './providers/anthropic';
import { OllamaProvider, ollamaModelsOnDisk } from './providers/ollama';
import { OpenAICompatibleProvider } from './providers/openai-compatible';
import { localFetch } from '../util/local-fetch';
import type { ChatProvider, ChatRequest, ProviderChunk } from './providers/types';
import { resourcePlan } from './resources';
import { MAX_LENT_HISTORY, MeshModelProvider } from '../mesh/model-lending';
import { FbrxCloudProvider, type CloudAiAccess } from './providers/fbrx-cloud';

/** Builds chat providers from settings, resolves API keys from the vault and enforces AI policy. */
export class ProviderManager {
  constructor(
    private readonly d: {
      settings: SettingsService;
      vault: Vault;
      policy: PolicyEngine;
      license: LicenseService;
      runtime: LocalRuntime;
      /** The line in front of the built-in model (this computer's own requests first). */
      line?: ModelLine;
      /** FBRX Mesh, for another computer's AI: a sealed request to it, and its name. */
      mesh?: { call: <T>(peerId: string, method: string, params: unknown, timeoutMs?: number) => Promise<T>; name: (peerId: string) => string | null };
      /** FBRX Cloud AI, through the signed-in FBRX account: where it is, and the account's month there. */
      cloud?: { access: () => CloudAiAccess | null; usage: (signal?: AbortSignal) => Promise<CloudAiUsage>; learner: () => boolean };
      /**
       * FBRX Digger: FBRX Endpoint on this computer, whose AI is Digger's only one (DIGGER_AI_PROVIDER): a request to
       * it, and whether its link is there (Endpoint running).
       */
      endpoint?: { call: <T>(method: string, params: unknown, timeoutMs?: number) => Promise<T>; present: () => boolean };
    },
  ) {}

  /** What each mesh provider's computer last offered (how much its AI holds). */
  private readonly lent = new Map<string, LentModel>();

  configs(): ProviderConfig[] {
    return this.d.endpoint ? [DIGGER_AI_PROVIDER] : this.d.settings.get().ai.providers;
  }

  config(id: string): ProviderConfig {
    const cfg = this.configs().find((p) => p.id === id);
    if (!cfg) throw new CoreError('NOT_FOUND', `Unknown AI provider "${id}"`);
    return cfg;
  }

  /** Why a provider may not be used right now, or null if it can. */
  blockReason(cfg: ProviderConfig): string | null {
    if (!cfg.enabled) return 'Provider is disabled';
    const ai = this.d.policy.policy.ai;
    if (cfg.cloud && !ai.allowCloudProviders) return 'Cloud AI providers are disabled by policy';
    if (ai.allowedProviders.length && !ai.allowedProviders.includes(cfg.id)) return 'Provider is not on the policy allow-list';
    if (cfg.cloud && !this.d.license.has('agent.cloud')) return 'Cloud AI requires a Pro or Enterprise license';
    if (!cfg.cloud && !this.d.license.has('agent.local')) return 'Local AI is not licensed';
    if (cfg.type === 'fbrx-cloud') {
      if (this.d.cloud?.learner()) return 'FBRX Cloud AI is off on this computer: it runs the learner edition your organization chose';
      if (!this.d.cloud?.access()) return 'Sign in to your FBRX account to use FBRX Cloud AI';
    }
    return null;
  }

  private apiKey(cfg: ProviderConfig): () => string | undefined {
    return () => {
      if (!cfg.apiKeySecret) return undefined;
      if (!this.d.vault.isUnlocked) throw new CoreError('LOCKED', 'Unlock the vault to use this provider');
      return this.d.vault.get(cfg.apiKeySecret);
    };
  }

  build(cfg: ProviderConfig): ChatProvider {
    switch (cfg.type) {
      case 'local-runtime': {
        const rt = this.d.runtime;
        const line = this.d.line;
        const ctx = rt.contextTokens();
        const inner = new OpenAICompatibleProvider({
          id: cfg.id,
          type: 'local-runtime',
          baseUrl: rt.endpoint,
          apiKey: () => rt.apiKey,
          historyBudgetChars: Math.max(4000, Math.floor(ctx * 2.5)),
          // A long request on a processor may take longer than fetch's five minutes to read; the chat shows how far.
          fetch: localFetch,
          readingProgress: true,
        });
        // The runtime loads the model on the first question (and again after it was unloaded for being idle).
        return {
          id: inner.id,
          type: inner.type,
          historyBudgetChars: inner.historyBudgetChars,
          listModels: (signal) => inner.listModels(signal),
          health: (signal) => inner.health(signal),
          async *chat(req: ChatRequest): AsyncIterable<ProviderChunk> {
            // One request at a time on this computer: the others wait their turn, this computer's own first.
            const st = line?.status();
            const kind = req.priority ?? 'host';
            const ahead = st ? st.host.waiting + (kind === 'mesh' || !st.hostFirst ? st.mesh.waiting : 0) : 0;
            if (st ? st.host.running + st.mesh.running >= st.capacity || ahead > 0 : rt.busy) {
              yield { type: 'waiting', for: st && st.mesh.running > 0 && st.host.running === 0 ? 'mesh' : 'chat' };
            }
            const done = line ? await line.acquire(kind, req.signal) : () => undefined;
            try {
              await rt.acquire();
              try {
                yield* inner.chat(req);
              } finally {
                rt.release();
              }
            } finally {
              done();
            }
          },
        };
      }
      case 'ollama': {
        const ai = this.d.settings.get().ai;
        const plan = resourcePlan(ai.resources);
        // With a chosen context window, keep the history that is sent within it (about 2.5 characters per token).
        const budget = ai.ollamaContext ? Math.max(4000, Math.floor(ai.ollamaContext * 2.5)) : undefined;
        return new OllamaProvider(cfg.id, cfg.baseUrl ?? 'http://127.0.0.1:11434', cfg.defaultModel, budget, { numThread: plan.threads, keepAlive: plan.keepAlive, numCtx: ai.ollamaContext || undefined });
      }
      case 'anthropic':
        return new AnthropicProvider({ id: cfg.id, baseUrl: cfg.baseUrl, apiKey: this.apiKey(cfg), defaultModel: cfg.defaultModel });
      case 'openai':
      case 'openai-compatible':
        if (!cfg.baseUrl) throw new CoreError('INVALID_ARGUMENT', `Provider ${cfg.id} needs a base URL`);
        return new OpenAICompatibleProvider({
          id: cfg.id,
          type: cfg.type,
          baseUrl: cfg.baseUrl,
          apiKey: this.apiKey(cfg),
          defaultModel: cfg.defaultModel,
          historyBudgetChars: cfg.cloud ? 400_000 : 60_000,
        });
      case 'mesh': {
        const mesh = this.d.mesh;
        const peer = cfg.peer;
        if (!mesh || !peer) throw new CoreError('INVALID_ARGUMENT', `${cfg.name} needs a paired computer`);
        return new MeshModelProvider({
          id: cfg.id,
          peerName: mesh.name(peer) ?? cfg.name,
          call: (method, params, timeoutMs) => mesh.call(peer, method, params, timeoutMs),
          historyChars: Math.min(MAX_LENT_HISTORY, this.lent.get(cfg.id)?.historyChars || 60_000),
          remember: (offer) => this.lent.set(cfg.id, offer),
        });
      }
      case 'fbrx-cloud': {
        const cloud = this.d.cloud;
        if (!cloud) throw new CoreError('UNAVAILABLE', 'FBRX Cloud AI is not available here');
        return new FbrxCloudProvider({ id: cfg.id, access: cloud.access, usage: cloud.usage, defaultModel: cfg.defaultModel });
      }
      case 'fbrx-endpoint': {
        // The model lender's protocol, as with another computer's AI, over the link to FBRX Endpoint on this computer.
        const endpoint = this.d.endpoint;
        if (!endpoint) throw new CoreError('UNAVAILABLE', 'FBRX Endpoint’s AI is for FBRX Digger');
        return new MeshModelProvider({
          id: cfg.id,
          peerName: cfg.name,
          call: endpoint.call,
          historyChars: Math.min(MAX_LENT_HISTORY, this.lent.get(cfg.id)?.historyChars || 60_000),
          remember: (offer) => this.lent.set(cfg.id, offer),
        });
      }
    }
  }

  /**
   * An OpenAI-compatible provider's address and key, for its endpoints besides chat (making pictures). The same
   * governance applies as for chatting with it.
   */
  endpoint(id: string): { baseUrl: string; apiKey: string | undefined } {
    const cfg = this.config(id);
    const blocked = this.blockReason(cfg);
    if (blocked) throw new CoreError('POLICY_DENIED', `${cfg.name}: ${blocked}`);
    if ((cfg.type !== 'openai' && cfg.type !== 'openai-compatible') || !cfg.baseUrl) throw new CoreError('INVALID_ARGUMENT', `${cfg.name} has no images endpoint: pick an OpenAI-compatible provider`);
    return { baseUrl: cfg.baseUrl, apiKey: this.apiKey(cfg)() };
  }

  /** Picks the provider + model for a run, applying defaults and governance. */
  resolve(providerId?: string, model?: string): { provider: ChatProvider; config: ProviderConfig; model: string } {
    const ai = this.d.settings.get().ai;
    // FBRX Digger has one AI, FBRX Endpoint's, with a model of Endpoint's (or the one Endpoint uses).
    if (this.d.endpoint) {
      const offered = this.lent.get(DIGGER_AI_PROVIDER.id)?.models ?? [];
      return { provider: this.build(DIGGER_AI_PROVIDER), config: DIGGER_AI_PROVIDER, model: model && offered.some((m) => m.id === model) ? model : '' };
    }
    const id = providerId || ai.defaultProvider;
    const cfg = this.config(id);
    const blocked = this.blockReason(cfg);
    if (blocked) throw new CoreError('POLICY_DENIED', `${cfg.name}: ${blocked}`);
    if (cfg.type === 'mesh' && !cfg.peer) throw new CoreError('INVALID_ARGUMENT', `${cfg.name} needs a paired computer`);
    if (cfg.type === 'local-runtime' && !this.d.runtime.isRunning && !this.d.runtime.canStart) {
      throw new CoreError('UNAVAILABLE', 'The local AI runtime has no model to run. Download one in AI models, or pick another provider.');
    }
    // Ollama picks its best installed model when none is chosen (see OllamaProvider.pickModel), another computer's AI
    // (and FBRX Endpoint's, for FBRX Digger) the one it runs, and FBRX Cloud AI its first.
    const chosen =
      model ||
      (id === ai.defaultProvider ? ai.defaultModel : '') ||
      cfg.defaultModel ||
      (cfg.type === 'local-runtime' ? (this.d.runtime.status().modelId ?? 'local') : cfg.type === 'ollama' ? (this.known.get(cfg.id)?.[0] ?? '') : '');
    if (!chosen && cfg.type !== 'local-runtime' && cfg.type !== 'ollama' && cfg.type !== 'mesh' && cfg.type !== 'fbrx-endpoint' && cfg.type !== 'fbrx-cloud') throw new CoreError('INVALID_ARGUMENT', `Choose a model for ${cfg.name}`);
    return { provider: this.build(cfg), config: cfg, model: chosen };
  }

  private statusCache: { key: string; at: number; value: Promise<ProviderStatus[]> } | null = null;

  /**
   * Whether each provider can be used. Several windows ask at once and on every settings change, and each check
   * may be a network call (cloud APIs, Ollama), so answers are shared for 15 seconds unless the setup changed.
   */
  status(): Promise<ProviderStatus[]> {
    // FBRX Endpoint starting or closing (for FBRX Digger) is seen at once, not after the cache runs out.
    const key = JSON.stringify([this.configs(), this.d.runtime.status().state, this.d.policy.policy.ai, this.d.settings.get().ai.defaultProvider, this.d.endpoint?.present()]);
    const c = this.statusCache;
    if (c && c.key === key && Date.now() - c.at < 15_000) return c.value;
    const value = this.checkAll();
    this.statusCache = { key, at: Date.now(), value };
    value.catch(() => (this.statusCache = null));
    return value;
  }

  private async checkAll(): Promise<ProviderStatus[]> {
    return Promise.all(
      this.configs().map(async (cfg) => {
        const blocked = this.blockReason(cfg);
        let available = false;
        let message: string | null = blocked;
        if (!blocked) {
          if (cfg.type === 'local-runtime') {
            const rt = this.d.runtime.status();
            // Ready also when stopped with a model set up: it loads on the first question.
            available = rt.state === 'running' || rt.state === 'starting' || (rt.state === 'stopped' && this.d.runtime.canStart);
            message = rt.state === 'running' ? null : rt.message ?? (available ? 'Loads the model on the first question' : `Runtime ${rt.state}`);
          } else {
            try {
              const h = await this.build(cfg).health(AbortSignal.timeout(4000));
              available = h.ok;
              message = h.message;
              if (h.ok && cfg.type === 'ollama') await this.models(cfg.id).catch(() => undefined);
            } catch (err) {
              message = (err as Error).message;
            }
          }
        }
        return {
          id: cfg.id,
          type: cfg.type,
          name: cfg.name,
          enabled: cfg.enabled,
          cloud: cfg.cloud,
          available,
          blockedByPolicy: !!blocked && cfg.enabled,
          message,
          defaultModel: cfg.defaultModel ?? (cfg.type === 'ollama' ? (this.known.get(cfg.id)?.[0] ?? null) : cfg.type === 'mesh' ? (this.lent.get(cfg.id)?.model ?? null) : null),
        };
      }),
    );
  }

  /** Models last listed per provider, best first; lets a chat start without choosing one. */
  private readonly known = new Map<string, string[]>();

  async models(providerId: string): Promise<ModelInfo[]> {
    const cfg = this.config(providerId);
    if (cfg.type === 'local-runtime') {
      const id = this.d.runtime.status().modelId;
      return id ? [{ id, name: id, providerId }] : [];
    }
    try {
      const list = await this.build(cfg).listModels(AbortSignal.timeout(10_000));
      this.known.set(providerId, list.map((m) => m.id));
      return list;
    } catch (err) {
      // Ollama not running: still show what it has downloaded, so the user can pick one and start Ollama.
      if (cfg.type === 'ollama') {
        const onDisk = ollamaModelsOnDisk();
        if (onDisk.length) return onDisk.map((id) => ({ id, name: id, providerId, unavailable: 'Ollama is not running' }));
      }
      throw err;
    }
  }
}
