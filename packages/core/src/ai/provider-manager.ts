import type { ModelInfo, ProviderConfig, ProviderStatus } from '@fbrx/shared';
import { CoreError } from '../errors';
import type { SettingsService } from '../settings/settings-service';
import type { Vault } from '../vault/vault';
import type { PolicyEngine } from '../governance/policy-engine';
import type { LicenseService } from '../license/license-service';
import type { LocalRuntime } from './runtime/local-runtime';
import { AnthropicProvider } from './providers/anthropic';
import { OllamaProvider, ollamaModelsOnDisk } from './providers/ollama';
import { OpenAICompatibleProvider } from './providers/openai-compatible';
import type { ChatProvider } from './providers/types';

/** Builds chat providers from settings, resolves API keys from the vault and enforces AI policy. */
export class ProviderManager {
  constructor(
    private readonly d: {
      settings: SettingsService;
      vault: Vault;
      policy: PolicyEngine;
      license: LicenseService;
      runtime: LocalRuntime;
    },
  ) {}

  configs(): ProviderConfig[] {
    return this.d.settings.get().ai.providers;
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
        const ctx = this.d.settings.get().runtime.contextSize;
        const rt = this.d.runtime;
        return new OpenAICompatibleProvider({
          id: cfg.id,
          type: 'local-runtime',
          baseUrl: rt.endpoint,
          apiKey: () => rt.apiKey,
          historyBudgetChars: Math.max(4000, Math.floor(ctx * 2.5)),
        });
      }
      case 'ollama':
        return new OllamaProvider(cfg.id, cfg.baseUrl ?? 'http://127.0.0.1:11434', cfg.defaultModel);
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
    }
  }

  /** Picks the provider + model for a run, applying defaults and governance. */
  resolve(providerId?: string, model?: string): { provider: ChatProvider; config: ProviderConfig; model: string } {
    const ai = this.d.settings.get().ai;
    const id = providerId || ai.defaultProvider;
    const cfg = this.config(id);
    const blocked = this.blockReason(cfg);
    if (blocked) throw new CoreError('POLICY_DENIED', `${cfg.name}: ${blocked}`);
    if (cfg.type === 'local-runtime' && !this.d.runtime.isRunning) {
      throw new CoreError('UNAVAILABLE', 'The local AI runtime is not running. Start it from the AI Runtime page or pick another provider.');
    }
    // Ollama picks its best installed model when none is chosen (see OllamaProvider.pickModel).
    const chosen =
      model ||
      (id === ai.defaultProvider ? ai.defaultModel : '') ||
      cfg.defaultModel ||
      (cfg.type === 'local-runtime' ? (this.d.runtime.status().modelId ?? 'local') : cfg.type === 'ollama' ? (this.known.get(cfg.id)?.[0] ?? '') : '');
    if (!chosen && cfg.type !== 'local-runtime' && cfg.type !== 'ollama') throw new CoreError('INVALID_ARGUMENT', `Choose a model for ${cfg.name}`);
    return { provider: this.build(cfg), config: cfg, model: chosen };
  }

  async status(): Promise<ProviderStatus[]> {
    return Promise.all(
      this.configs().map(async (cfg) => {
        const blocked = this.blockReason(cfg);
        let available = false;
        let message: string | null = blocked;
        if (!blocked) {
          if (cfg.type === 'local-runtime') {
            const rt = this.d.runtime.status();
            available = rt.state === 'running';
            message = available ? null : rt.message ?? `Runtime ${rt.state}`;
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
          defaultModel: cfg.defaultModel ?? (cfg.type === 'ollama' ? (this.known.get(cfg.id)?.[0] ?? null) : null),
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
