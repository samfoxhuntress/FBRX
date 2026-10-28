import type { CatalogModel, DownloadProgress, RuntimeStatus, Settings, StarterAiStatus } from '@fbrx/shared';
import { STARTER_MODEL_ID, bestModelFor } from '@fbrx/shared';
import type { EventBus } from '../../events';
import type { Logger } from '../../logger';
import type { MetaStore } from '../../storage/meta';
import type { ModelManager } from './model-manager';
import type { LocalRuntime } from './local-runtime';

/**
 * The AI ready before the first question: a new computer gets the built-in runtime (llama.cpp's llama-server) and a
 * small, quick model (the starter, about 1 GB) without anyone choosing anything.
 *
 * "Install FBRX OS" downloads the model into the models folder while it builds the app, so the first start only picks
 * it up (adopt). A computer installed another way (the ready-made installers) downloads it on its first start. Either
 * way it becomes the model the agent uses, and the runtime starts so the first answer comes quickly.
 *
 * Only once, automatically, on a new computer (first-run setup not finished) where nobody chose an AI yet (the
 * built-in runtime is the default and no model is set): someone who removes the model, or picks another AI, is not
 * overruled, and a computer that was already set up before this existed is not sent a gigabyte unasked. "Get it ready"
 * on the chat starts it by hand.
 *
 * FBRX Server gets the best model its hardware runs well instead (bestModelFor), once, on the first start of its AI
 * role where nobody chose one yet (a server has no first-run setup to wait for).
 */

const AUTO_DONE = 'ai.starter.auto';

export interface StarterAiDeps {
  models: ModelManager;
  runtime: LocalRuntime;
  settings: () => Settings;
  meta: MetaStore;
  events: EventBus;
  log: Logger;
  /** Makes an installed model the one the agent uses (built-in runtime as the default provider) and starts it. */
  use: (modelId: string) => Promise<RuntimeStatus>;
  /** FBRX Server's own core: the best model it runs well, not the starter. */
  server: boolean;
  /** Free space where models are kept (a server's pick leaves room to spare). */
  diskFree: () => Promise<number>;
}

export class StarterAi {
  private state: StarterAiStatus;
  private busy: Promise<StarterAiStatus> | null = null;
  /** The model being got ready. */
  private target: CatalogModel;

  constructor(private readonly d: StarterAiDeps) {
    this.target = d.models.catalog().find((x) => x.id === STARTER_MODEL_ID)!;
    this.state = { state: 'idle', step: null, receivedBytes: 0, totalBytes: this.target.sizeBytes, message: null, modelId: this.target.id, modelName: this.target.name };
    d.events.on('runtime.download', (p) => this.onProgress(p));
  }

  /** The model to get ready: the starter, or on a server the best one its hardware runs well. */
  private async choose(): Promise<CatalogModel> {
    const starter = this.d.models.catalog().find((x) => x.id === STARTER_MODEL_ID)!;
    if (!this.d.server) return starter;
    return bestModelFor(this.d.models.catalog(), await this.d.runtime.hardware(), await this.d.diskFree()) ?? starter;
  }

  /** Nobody chose an AI on this computer yet: the built-in runtime with no model. */
  private unchosen(): boolean {
    const s = this.d.settings();
    const local = s.ai.providers.find((p) => p.type === 'local-runtime');
    return !!local && s.ai.defaultProvider === local.id && !s.runtime.modelId;
  }

  status(): StarterAiStatus {
    if (this.state.state === 'idle' || this.state.state === 'ready') {
      const id = this.d.settings().runtime.modelId;
      if (id && this.d.models.get(id)) return { ...this.state, state: 'ready', step: null };
      if (!this.unchosen()) return { ...this.state, state: 'not-needed', step: null };
    }
    return { ...this.state };
  }

  private set(patch: Partial<StarterAiStatus>) {
    this.state = { ...this.state, ...patch };
    this.d.events.emit('ai.starter', this.status());
  }

  private onProgress(p: DownloadProgress) {
    if (this.state.state !== 'preparing') return;
    if ((p.modelId === 'llama-runtime' && this.state.step === 'runtime') || (p.modelId === this.target.id && this.state.step === 'model')) {
      this.set({ receivedBytes: p.receivedBytes, totalBytes: p.totalBytes || this.state.totalBytes });
    }
  }

  /**
   * At start-up: picks up a model the installer left, and on a computer where nobody chose an AI yet gets the starter
   * ready (once; `force` again, from the chat or the AI models page).
   */
  prepare(o: { auto: boolean }): Promise<StarterAiStatus> {
    this.busy ??= this.run(o.auto).finally(() => (this.busy = null));
    return this.busy;
  }

  private async run(auto: boolean): Promise<StarterAiStatus> {
    try {
      // A model "Install FBRX OS" downloaded into the models folder.
      for (const m of await this.d.models.adopt()) this.d.log.info('Model from the installer picked up', { model: m.id });
      if (!this.unchosen()) return this.status();
      const installed = this.d.models.installed();
      const pick = installed.find((m) => m.id === STARTER_MODEL_ID) ?? installed[0];
      if (pick) {
        await this.useIt(pick.id);
        return this.status();
      }
      if (auto && (this.d.meta.get<boolean>(AUTO_DONE) || (!this.d.server && this.d.settings().general.onboardingComplete))) return this.status();
      this.d.meta.set(AUTO_DONE, true);
      this.target = await this.choose();
      this.set({ modelId: this.target.id, modelName: this.target.name, totalBytes: this.target.sizeBytes });
      this.d.log.info('Getting the AI ready', { model: this.target.id });

      if (this.d.runtime.status().state === 'not-installed') {
        this.set({ state: 'preparing', step: 'runtime', receivedBytes: 0, totalBytes: 0, message: null });
        await this.installRuntime();
      }
      this.set({ state: 'preparing', step: 'model', receivedBytes: 0, totalBytes: this.target.sizeBytes, message: null });
      await this.downloadModel();
      await this.useIt(this.target.id);
    } catch (err) {
      const message = (err as Error).message;
      this.d.log.warn('The starter AI could not be got ready', { error: message });
      this.set({ state: 'failed', step: null, message });
    }
    return this.status();
  }

  private async useIt(modelId: string) {
    this.set({ state: 'preparing', step: 'starting', message: null });
    await this.d.use(modelId);
    this.set({ state: 'ready', step: null, message: null });
    this.d.log.info('The AI is ready', { model: modelId });
  }

  private installRuntime(): Promise<void> {
    return new Promise((resolve, reject) => {
      const off = this.d.events.on('runtime.download', (p) => {
        if (p.modelId !== 'llama-runtime') return;
        if (p.state === 'completed') done(null);
        else if (p.state === 'failed' || p.state === 'cancelled') done(new Error(p.error ?? 'The AI runtime could not be downloaded'));
      });
      const done = (err: Error | null) => {
        off();
        if (err) reject(err);
        else resolve();
      };
      try {
        this.d.runtime.install();
      } catch (err) {
        done(err as Error);
      }
    });
  }

  private downloadModel(): Promise<void> {
    const id = this.target.id;
    return new Promise((resolve, reject) => {
      const off = this.d.events.on('runtime.download', (p) => {
        if (p.modelId !== id) return;
        if (p.state === 'completed') done(null);
        else if (p.state === 'failed' || p.state === 'cancelled') done(new Error(p.error ?? 'The model could not be downloaded'));
      });
      const done = (err: Error | null) => {
        off();
        if (err) reject(err);
        else resolve();
      };
      try {
        // Already on its way (someone started it on the AI models page): wait for that one.
        if (!this.d.models.activeDownloads().some((x) => x.modelId === id)) this.d.models.download(id);
      } catch (err) {
        done(err as Error);
      }
    });
  }
}
