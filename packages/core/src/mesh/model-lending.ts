import { z } from 'zod';
import { newId, type AssistMode, type LentModel, type MeshDevice, type ModelInfo, type ProviderConfig } from '@fbrx/shared';
import { CoreError, errorMessage } from '../errors';
import type { ChatProvider, ChatRequest, ProviderChunk } from '../ai/providers/types';

/**
 * Thinking with another computer's AI over FBRX Mesh. The agent stays where the person is (its tools, memory,
 * approvals and audit on their computer); only the model's work moves, to a paired computer with a bigger AI (an FBRX
 * Server, at home or through FBRX VPN). That computer lends the AI it runs itself, never a cloud provider, so the
 * conversation stays on the person's own computers, sealed end to end.
 *
 * The answer streams back by long polling: the asker reads what the model has written since last time, and each read
 * waits until there is something new.
 */

/** A conversation as big as this fits through FBRX Mesh with room to spare (requests are limited to 1 MiB). */
export const MAX_LENT_HISTORY = 160_000;
/** How long one read waits for something new. */
const READ_WAIT_MS = 1500;
/** A model nobody reads from any more (the asker went away) is stopped after this long. */
const ABANDONED_MS = 60_000;
/** A finished answer is kept this long for its last read. */
const KEEP_DONE_MS = 30_000;
/** A "no" from the person here holds this long before they are asked again. */
const DENIED_MS = 10 * 60_000;
/** Answers one computer may have running here at once. */
const PER_PEER = 2;

const Message = z.discriminatedUnion('role', [
  z.object({ role: z.literal('system'), content: z.string() }),
  z.object({ role: z.literal('user'), content: z.string() }),
  z.object({
    role: z.literal('assistant'),
    content: z.string(),
    toolCalls: z.array(z.object({ id: z.string().max(200), name: z.string().max(64), arguments: z.unknown() })).optional(),
    providerData: z.object({ providerType: z.string(), model: z.string(), raw: z.unknown() }).nullable().optional(),
  }),
  z.object({ role: z.literal('tool'), toolCallId: z.string().max(200), name: z.string().max(64), content: z.string(), isError: z.boolean().optional() }),
]);

const StartParams = z.object({
  model: z.string().max(200).default(''),
  messages: z.array(Message).min(1).max(2000),
  tools: z.array(z.object({ name: z.string().max(64), description: z.string().max(1024), parameters: z.record(z.string(), z.unknown()) })).max(500),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().min(1).max(128_000).optional(),
});

interface Job {
  id: string;
  peerId: string;
  chunks: ProviderChunk[];
  done: boolean;
  error: string | null;
  controller: AbortController;
  readAt: number;
  doneAt: number;
  wake: (() => void) | null;
}

export interface LenderDeps {
  /** How this computer treats AI requests from the peer (its Mesh Assist "Help others" setting and permissions). */
  accepts: (peer: MeshDevice) => { mode: AssistMode; reason: string | null };
  /** This computer's own AI: the provider and model a chat here would use. */
  resolve: (model?: string) => { provider: ChatProvider; config: ProviderConfig; model: string };
  models: (providerId: string) => Promise<ModelInfo[]>;
  /** Whether a model here that can think first should (this computer's Thinking setting decides, not the asker's). */
  reasoning: () => boolean;
  approve: (p: { title: string; reason: string; input: unknown }) => Promise<boolean>;
  agentName: () => string;
  audit: (action: string, actor: string, outcome: 'success' | 'failure' | 'denied' | 'info', details?: Record<string, unknown>) => void;
}

/** This computer's side: lends its own AI model to the paired computers allowed to ask it for help. */
export class ModelLender {
  private readonly jobs = new Map<string, Job>();
  /** Peers the person here said yes to (until FBRX restarts), and when a "no" stops holding. */
  private readonly allowed = new Set<string>();
  private readonly denied = new Map<string, number>();
  /** Peers whose first use since FBRX started is in the audit log (one entry, not one per step). */
  private readonly audited = new Set<string>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly d: LenderDeps) {}

  async handle(peer: MeshDevice, method: string, p: any): Promise<unknown> {
    if (peer.kind !== 'desktop') throw new CoreError('FORBIDDEN', 'Only computers may think with this computer’s AI');
    switch (method) {
      case 'assist.model.offer':
        return this.offer(peer);
      case 'assist.model.start':
        return { id: this.start(peer, StartParams.parse(p ?? {})).id };
      case 'assist.model.read':
        return this.read(this.mine(peer, p?.id), Number(p?.from ?? 0));
      case 'assist.model.cancel': {
        const job = this.jobs.get(String(p?.id ?? ''));
        if (job && job.peerId === peer.id) this.stop(job, 'Stopped by the asker');
        return { ok: true };
      }
      default:
        throw new CoreError('NOT_FOUND', `Unknown method ${method}`);
    }
  }

  /** What the peer would get: whether this computer lends its AI to it, and which. */
  async offer(peer: MeshDevice): Promise<LentModel> {
    const no = (reason: string): LentModel => ({ accepts: 'off', reason, model: null, models: [], historyChars: 0 });
    const a = this.d.accepts(peer);
    if (a.mode === 'off') return no(a.reason ?? 'This computer does not lend its AI');
    let own: ReturnType<LenderDeps['resolve']>;
    try {
      own = this.own();
    } catch (err) {
      return no(errorMessage(err));
    }
    const models = await this.d.models(own.config.id).catch(() => []);
    return {
      accepts: a.mode,
      reason: null,
      model: own.model || null,
      models: models.filter((m) => !m.unavailable).map((m) => ({ id: m.id, name: m.name })),
      historyChars: Math.min(MAX_LENT_HISTORY, own.provider.historyBudgetChars),
    };
  }

  /** The AI this computer runs itself (a cloud provider is not lent: the conversation stays on your computers). */
  private own(model?: string) {
    const r = this.d.resolve(model || undefined);
    if (r.config.cloud) throw new CoreError('FORBIDDEN', 'This computer’s AI is a cloud provider; it lends only an AI it runs itself');
    return r;
  }

  private start(peer: MeshDevice, p: z.infer<typeof StartParams>): Job {
    const a = this.d.accepts(peer);
    if (a.mode === 'off') throw new CoreError('FORBIDDEN', a.reason ?? 'This computer does not lend its AI');
    if ((this.denied.get(peer.id) ?? 0) > Date.now()) throw new CoreError('FORBIDDEN', 'The person at this computer said no for now');
    if ([...this.jobs.values()].filter((j) => j.peerId === peer.id && !j.done).length >= PER_PEER) throw new CoreError('CONFLICT', 'This computer is already answering two requests from you');
    const own = this.own(p.model);
    const job: Job = { id: newId('lend'), peerId: peer.id, chunks: [], done: false, error: null, controller: new AbortController(), readAt: Date.now(), doneAt: 0, wake: null };
    this.jobs.set(job.id, job);
    this.sweep();
    void this.run(job, peer, a.mode, own, p);
    return job;
  }

  private async run(job: Job, peer: MeshDevice, mode: AssistMode, own: ReturnType<LenderDeps['resolve']>, p: z.infer<typeof StartParams>) {
    try {
      if (mode === 'ask' && !this.allowed.has(peer.id)) {
        const yes = await this.d.approve({
          title: `Let ${peer.name} think with this computer’s AI`,
          reason: `${peer.name}'s ${this.d.agentName()} wants to use this computer's AI model (${own.model || own.config.name}) for its chats. Its tools and files stay on ${peer.name}; only the model's work happens here. Yes holds until FBRX restarts.`,
          input: { deviceId: peer.id, model: own.model },
        });
        if (!yes) {
          this.denied.set(peer.id, Date.now() + DENIED_MS);
          throw new CoreError('FORBIDDEN', 'The person at this computer said no');
        }
        this.allowed.add(peer.id);
      }
      if (!this.audited.has(peer.id)) {
        this.audited.add(peer.id);
        this.d.audit('assist.model.lent', `mesh:${peer.name}`, 'info', { model: own.model, provider: own.config.id });
      }
      const req: ChatRequest = {
        model: own.model,
        messages: p.messages as ChatRequest['messages'],
        tools: p.tools,
        temperature: p.temperature,
        maxTokens: p.maxTokens,
        reasoning: this.d.reasoning(),
        signal: job.controller.signal,
      };
      for await (const chunk of own.provider.chat(req)) {
        if (job.done) return;
        job.chunks.push(chunk.type === 'done' ? { ...chunk, servedModel: chunk.servedModel ?? own.model } : chunk);
        job.wake?.();
      }
      this.finish(job, null);
    } catch (err) {
      this.finish(job, job.controller.signal.aborted ? 'Stopped' : errorMessage(err));
    }
  }

  private mine(peer: MeshDevice, id: unknown): Job {
    const job = this.jobs.get(String(id ?? ''));
    if (!job || job.peerId !== peer.id) throw new CoreError('NOT_FOUND', 'That answer is no longer here');
    return job;
  }

  /** What the model wrote from `from` on, waiting a moment for something new; text pieces are joined up. */
  private async read(job: Job, from: number) {
    job.readAt = Date.now();
    if (job.chunks.length <= from && !job.done) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, READ_WAIT_MS);
        job.wake = () => (clearTimeout(t), resolve());
      });
      job.wake = null;
      // Let a few more pieces arrive, so one read carries more than one word.
      if (!job.done) await new Promise((r) => setTimeout(r, 40));
    }
    const next = job.chunks.length;
    const chunks: ProviderChunk[] = [];
    for (const c of job.chunks.slice(from, next)) {
      const last = chunks.at(-1);
      if (last && (c.type === 'text' || c.type === 'thinking') && last.type === c.type) last.delta += c.delta;
      else chunks.push(c.type === 'text' || c.type === 'thinking' ? { ...c } : c);
    }
    return { chunks, next, done: job.done, error: job.error };
  }

  private finish(job: Job, error: string | null) {
    if (job.done) return;
    job.done = true;
    job.error = error;
    job.doneAt = Date.now();
    job.wake?.();
  }

  private stop(job: Job, why: string) {
    this.finish(job, why);
    job.controller.abort(new CoreError('CANCELLED', why));
  }

  /** Answers nobody reads any more are stopped, and finished ones let go of, while there are any. */
  private sweep() {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      const now = Date.now();
      for (const job of this.jobs.values()) {
        if (!job.done && now - job.readAt > ABANDONED_MS) this.stop(job, 'Nobody was reading the answer');
        if (job.done && now - Math.max(job.doneAt, job.readAt) > KEEP_DONE_MS) this.jobs.delete(job.id);
      }
      if (!this.jobs.size) {
        clearInterval(this.sweeper!);
        this.sweeper = null;
      }
    }, 5000);
    this.sweeper.unref?.();
  }

  /** Stops every answer (FBRX is closing). */
  close() {
    for (const job of this.jobs.values()) this.stop(job, 'FBRX is closing');
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }
}

/** The asker's side: another computer's AI, used by this computer's agent like any other provider. */
export class MeshModelProvider implements ChatProvider {
  readonly type = 'mesh' as const;

  constructor(
    private readonly o: {
      id: string;
      peerName: string;
      /** A sealed request to the computer lending its AI. */
      call: <T>(method: string, params: unknown, timeoutMs?: number) => Promise<T>;
      /** What its last offer said it holds (until known, a middling amount). */
      historyChars: number;
      /** Keeps what the computer offered, for the next request. */
      remember: (offer: LentModel) => void;
    },
  ) {}

  get id() {
    return this.o.id;
  }

  get historyBudgetChars() {
    return this.o.historyChars;
  }

  private async offer(signal?: AbortSignal): Promise<LentModel> {
    signal?.throwIfAborted();
    const offer = await this.o.call<LentModel>('assist.model.offer', {}, 8000);
    this.o.remember(offer);
    return offer;
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const offer = await this.offer(signal);
    return offer.models.map((m) => ({ id: m.id, name: m.name, providerId: this.o.id, details: `on ${this.o.peerName}` }));
  }

  async health(signal?: AbortSignal): Promise<{ ok: boolean; message: string | null }> {
    const offer = await this.offer(signal);
    if (offer.accepts === 'off') return { ok: false, message: `${this.o.peerName}: ${offer.reason ?? 'does not lend its AI'}` };
    return { ok: true, message: offer.accepts === 'ask' ? `${this.o.peerName} asks its person the first time` : null };
  }

  async *chat(req: ChatRequest): AsyncIterable<ProviderChunk> {
    const messages = req.messages.map((m) => (m.role === 'user' && m.images ? { role: m.role, content: m.content } : m));
    const { id } = await this.o.call<{ id: string }>('assist.model.start', { model: req.model, messages, tools: req.tools, temperature: req.temperature, maxTokens: req.maxTokens }, 30_000);
    const cancel = () => void this.o.call('assist.model.cancel', { id }, 5000).catch(() => undefined);
    req.signal.addEventListener('abort', cancel, { once: true });
    try {
      let from = 0;
      for (;;) {
        if (req.signal.aborted) throw req.signal.reason ?? new CoreError('CANCELLED', 'Canceled');
        const r = await this.o.call<{ chunks: ProviderChunk[]; next: number; done: boolean; error: string | null }>('assist.model.read', { id, from }, 20_000);
        for (const c of r.chunks) yield c.type === 'done' ? { ...c, servedModel: `${c.servedModel || req.model || 'AI'} · ${this.o.peerName}` } : c;
        from = r.next;
        if (r.error) throw new CoreError('UNAVAILABLE', `${this.o.peerName}: ${r.error}`);
        if (r.done) return;
      }
    } finally {
      req.signal.removeEventListener('abort', cancel);
    }
  }
}
