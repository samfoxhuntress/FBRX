import { LEARNING_STEPS, PROFILE_MAX_AGE_DAYS, PROFILE_VERSION, computerProfile, computerSummary, type ComputerFacts, type LearningAgent, type LearningReason, type LearningStatus, type LearningStep, type LearningStepId, type SystemInventory } from '@fbrx/shared';
import type { EventBus } from '../events';
import type { Logger } from '../logger';
import type { MetaStore } from '../storage/meta';

/**
 * Learning your computer. After setup, and each time someone picks a new AI, FBRX reads what the AI needs to know
 * about this computer, on the computer itself:
 *
 * 1. The hardware, the system, the network and FBRX's own setup.
 * 2. A short profile of it, which goes into the AI's instructions (ai/agent.ts, "This computer").
 * 3. The model reads its instructions and tools once, so the first answer starts at once.
 *
 * Nothing is sent anywhere while it learns, no tool runs and no approval is asked. A cloud AI reads the profile without
 * what identifies the computer or the person (computerProfile). The profile is learned again, quietly, when it is a week
 * old or reads differently in a newer FBRX.
 */

const KEY = 'learning.profile';

/** What is kept between starts: the facts (the profile is written from them for each AI) and whom they were for. */
interface Stored {
  version: number;
  at: string;
  agentKey: string;
  facts: ComputerFacts;
  summary: string;
}

export interface LearningDeps {
  events: EventBus;
  log: Logger;
  meta: MetaStore;
  /** The AI the agent uses now, or null when there is none to learn for (no model chosen yet, say). */
  agent: () => LearningAgent | null;
  /** Whether learning applies here: set up, and not FBRX Digger or FBRX Server. */
  enabled: () => boolean;
  read: {
    inventory: () => Promise<SystemInventory>;
    network: () => Promise<ComputerFacts['network']>;
    fbrx: () => ComputerFacts['fbrx'];
    user: () => string | null;
  };
  /**
   * Gets the AI ready to answer: waits for the starter model when it is still downloading and starts the model on this
   * computer, or checks that the one elsewhere answers. Says what it is doing through `report`.
   */
  prepare: (agent: LearningAgent, report: (detail: string) => void, signal: AbortSignal) => Promise<LearningAgent | null>;
  /** Has the model read its instructions and tools once (a model elsewhere is not asked: it would cost the person). */
  warm: (report: (detail: string) => void, signal: AbortSignal) => Promise<'warmed' | 'skipped'>;
}

const fresh = (): LearningStep[] => LEARNING_STEPS.map((s) => ({ ...s, state: 'waiting', detail: null }));

export class ComputerLearning {
  private status_: LearningStatus;
  private run_: { controller: AbortController; done: Promise<void> } | null = null;

  constructor(private readonly d: LearningDeps) {
    const s = this.stored();
    this.status_ = { state: s ? 'ready' : 'idle', reason: null, screen: false, agent: null, steps: fresh(), startedAt: null, finishedAt: null, learnedAt: s?.at ?? null, summary: s?.summary ?? null, message: null };
  }

  private stored(): Stored | null {
    const s = this.d.meta.get<Stored>(KEY);
    return s && s.facts && typeof s.agentKey === 'string' ? s : null;
  }

  status(): LearningStatus {
    return structuredClone(this.status_);
  }

  private set(patch: Partial<LearningStatus>) {
    this.status_ = { ...this.status_, ...patch };
    this.d.events.emit('learning.changed', this.status());
  }

  private step(id: LearningStepId, state: LearningStep['state'], detail: string | null = null) {
    this.set({ steps: this.status_.steps.map((s) => (s.id === id ? { ...s, state, detail } : s)) });
  }

  /** The profile the AI reads, written for a model here or for a cloud AI; null before anything was learned. */
  profile(cloud: boolean): { text: string; at: string } | null {
    const s = this.stored();
    return s ? { text: computerProfile(s.facts, { cloud }), at: s.at } : null;
  }

  /**
   * What needs learning now, if anything: nothing learned yet (setup, or the first start of an FBRX that learns), a
   * different AI than the one it learned for, or a profile that is old or reads differently now.
   */
  needed(): { reason: LearningReason; screen: boolean } | null {
    if (!this.d.enabled()) return null;
    const agent = this.d.agent();
    const s = this.stored();
    if (!s) return { reason: 'setup', screen: true };
    if (agent && agent.key !== s.agentKey) return { reason: 'agent', screen: true };
    const days = (Date.now() - Date.parse(s.at)) / 86_400_000;
    if (s.version !== PROFILE_VERSION || !(days < PROFILE_MAX_AGE_DAYS)) return { reason: 'refresh', screen: false };
    return null;
  }

  /** Learns when something calls for it (a start, a settings change); does nothing while it already learns. */
  check(): void {
    if (this.run_) return;
    const need = this.needed();
    if (need) void this.start(need.reason, need.screen);
  }

  /** Goes on without the full screen. */
  background(): LearningStatus {
    if (this.status_.screen) this.set({ screen: false });
    return this.status();
  }

  /** Stops (FBRX closing). */
  stop(): void {
    this.run_?.controller.abort();
  }

  /** Learns now; a run already going goes on (the person sees it), unless it is for another AI. */
  start(reason: LearningReason, screen: boolean): Promise<void> {
    if (this.run_) {
      if (screen && !this.status_.screen) this.set({ screen: true });
      return this.run_.done;
    }
    const controller = new AbortController();
    const done = this.learn(reason, screen, controller.signal).finally(() => {
      this.run_ = null;
      // What changed while it learned (another AI picked) is learned next.
      if (!controller.signal.aborted) this.check();
    });
    this.run_ = { controller, done };
    return done;
  }

  private async learn(reason: LearningReason, screen: boolean, signal: AbortSignal): Promise<void> {
    let agent = this.d.agent();
    this.set({ state: 'learning', reason, screen, agent, steps: fresh(), startedAt: new Date().toISOString(), finishedAt: null, message: null });
    this.d.log.info('Learning the computer', { reason, agent: agent?.key ?? null });
    const problems: string[] = [];
    const attempt = async <T>(id: LearningStepId, fn: () => Promise<T>, done?: (v: T) => string | null): Promise<T | null> => {
      if (signal.aborted) return null;
      this.step(id, 'running');
      try {
        const v = await fn();
        this.step(id, 'done', done?.(v) ?? null);
        return v;
      } catch (err) {
        const message = (err as Error).message;
        this.d.log.warn('A learning step did not work', { step: id, error: message });
        this.step(id, 'failed', message);
        problems.push(message);
        return null;
      }
    };

    // 1. The AI first: on a new computer it may still be downloading, and everything after is quick.
    let aiReady = false;
    if (agent) {
      const ready = await attempt('agent', () => this.d.prepare(agent!, (detail) => this.step('agent', 'running', detail), signal), (a) => (a ? `${a.label}, on ${a.where}` : null));
      if (ready) {
        agent = ready;
        aiReady = true;
        this.set({ agent });
      }
    } else {
      this.step('agent', 'skipped', 'No AI chosen yet: AI models has one for this computer');
    }

    // 2. The computer, on the computer: each part on its own, so one that cannot be read leaves the rest.
    const inventory = await attempt('hardware', () => this.d.read.inventory(), (i) => [i.cpu.name, `${Math.round(i.memory.totalBytes / 1024 ** 3)} GB`].filter(Boolean).join(', '));
    await attempt('system', async () => inventory?.os ?? null, (os) => (os ? `${os.name} ${os.version ?? ''}`.trim() : null));
    const network = await attempt('network', () => this.d.read.network(), (n) => (n ? (n.connected ? (n.kind === 'wifi' ? 'On Wi-Fi' : n.kind === 'ethernet' ? 'On a cable' : 'Connected') : 'Not connected') : null));
    const fbrx = await attempt('fbrx', async () => this.d.read.fbrx(), (x) => (x ? `${x.edition}, ${x.tools} tools` : null));
    if (signal.aborted) return this.aborted();

    // 3. What it learned, kept for the AI's instructions.
    const facts: ComputerFacts = {
      at: new Date().toISOString(),
      inventory,
      user: this.safe(() => this.d.read.user()),
      network,
      fbrx,
      agent: agent ? { label: agent.label, where: agent.where } : null,
    };
    const summary = computerSummary(facts);
    await attempt('context', async () => {
      const stored: Stored = { version: PROFILE_VERSION, at: facts.at, agentKey: agent?.key ?? '', facts, summary };
      this.d.meta.set(KEY, stored);
      return computerProfile(facts, { cloud: !!agent?.cloud });
    }, (text) => `${text.split('\n').length} things it knows now`);

    // 4. The model reads it all once (a model on this computer or the network keeps what it read).
    if (aiReady) await attempt('warmup', () => this.d.warm((detail) => this.step('warmup', 'running', detail), signal), (r) => (r === 'skipped' ? 'Ready when you are' : 'Read, and ready'));
    else if (!signal.aborted) this.step('warmup', 'skipped', agent ? 'Once the AI is ready' : null);
    if (signal.aborted) return this.aborted();

    const learnedAt = facts.at;
    const message = !agent ? 'Choose an AI in AI models, and FBRX learns the computer for it.' : !aiReady ? `The AI is not ready yet: ${problems[0] ?? 'it did not answer'}.` : null;
    this.set({ state: 'ready', finishedAt: new Date().toISOString(), learnedAt, summary, message });
    this.d.log.info('Learned the computer', { reason, agent: agent?.key ?? null, problems: problems.length });
  }

  private aborted() {
    this.set({ state: this.stored() ? 'ready' : 'idle', screen: false, finishedAt: new Date().toISOString(), message: 'Stopped' });
  }

  private safe<T>(fn: () => T): T | null {
    try {
      return fn();
    } catch {
      return null;
    }
  }
}
