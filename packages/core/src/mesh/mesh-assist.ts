import { execFile } from 'node:child_process';
import { z } from 'zod';
import {
  ASSIST_PRIORITIES,
  ASSIST_TERMINAL,
  ASSIST_TOOLS,
  assistRank,
  newId,
  type AssistKind,
  type AssistMode,
  type AssistOffer,
  type AssistPriority,
  type AssistSession,
  type AssistTools,
  type AssistTrigger,
  type MeshDevice,
  type Settings,
} from '@fbrx/shared';
import { CoreError, errorMessage } from '../errors';
import type { Logger } from '../logger';

/**
 * Mesh Assist: paired computers lending each other their AI. The asking side picks the best helper (who would say
 * yes, has an AI ready and room for the work) and hands it a question or a whole task; the helper runs it with its own
 * agent, under its own policy, and sends the answer back. When an agent runs out of steps or its AI provider stops
 * answering, the task is handed over the same way.
 *
 * Who decides: each computer's Mesh Assist settings (off / ask the person / automatic, both for asking and for
 * helping), each paired device's permissions on the helper ("Help with AI", "Controller"), and priorities. A
 * controller running as administrator skips the helper's "may I?" question, may send urgent work and may stop
 * lower-priority help to make room. Help is never passed along a second time, so requests cannot loop.
 */

type AssistSettings = Settings['mesh']['assist'];

export interface RunHandle {
  runId: string;
  conversationId: string;
  done: Promise<{ answer: string; steps: number; status: 'completed' | 'failed' | 'cancelled'; error?: string }>;
}

export interface AssistDeps {
  settings: () => AssistSettings;
  meshRunning: () => boolean;
  agentName: () => string;
  devices: () => MeshDevice[];
  call: <T>(peerId: string, method: string, params: unknown, timeoutMs?: number) => Promise<T>;
  agentReady: () => AssistOffer['ai'];
  load: () => AssistOffer['load'];
  /** Runs help for a peer with this computer's agent (limited steps and tools, never asking further). */
  runHelp: (p: { message: string; conversationId: string | null; title: string; peerName: string; maxSteps: number; tools: AssistTools }) => RunHandle;
  onTool: (runId: string, cb: (tool: string) => void) => () => void;
  cancelRun: (runId: string) => void;
  /** Asks the person at this computer; false when they decline (or nobody answers in time). */
  approve: (p: { title: string; reason: string; input: unknown; signal?: AbortSignal }) => Promise<boolean>;
  audit: (action: string, actor: string, outcome: 'success' | 'failure' | 'denied' | 'info', details?: Record<string, unknown>) => void;
  emit: (s: AssistSession) => void;
  log: Logger;
  /** Polling interval while waiting for a helper (tests use a short one). */
  pollMs?: number;
}

interface Session extends AssistSession {
  runId: string | null;
  context: string;
  tools: string[];
  limitTools: AssistTools;
  maxSteps: number;
  queuedAt: number;
}

const StartParams = z.object({
  kind: z.enum(['consult', 'continue', 'task']),
  goal: z.string().trim().min(1).max(16_000),
  context: z.string().max(24_000).default(''),
  priority: z.enum(ASSIST_PRIORITIES).default('normal'),
  tools: z.enum(ASSIST_TOOLS).default('read'),
  maxSteps: z.number().int().min(1).max(100).default(12),
  trigger: z.enum(['agent', 'steps', 'provider', 'person', 'controller']).default('agent'),
  admin: z.boolean().default(false),
  hops: z.number().int().min(0).max(10).default(0),
  /** A follow-up to an earlier session with this helper (its id on the helper). */
  followUp: z.string().max(64).optional(),
});

const TOOL_ORDER: AssistTools[] = ['none', 'read', 'all'];
const fewerTools = (a: AssistTools, b: AssistTools): AssistTools => (TOOL_ORDER.indexOf(a) <= TOOL_ORDER.indexOf(b) ? a : b);
const lowerPriority = (a: AssistPriority, b: AssistPriority): AssistPriority => (assistRank(a) <= assistRank(b) ? a : b);

/** Errors that mean "this AI cannot answer right now": out of credits, over quota, rate limited, down, unreachable. */
export function isCapacityError(message: string): boolean {
  return /credit|quota|billing|payment|insufficient|rate.?limit|too many requests|\b(402|429|503|529)\b|overloaded|exceeded|capacity|unavailable|not reachable|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed|timed? ?out|api key|unauthori[sz]ed|\b401\b/i.test(message);
}

let elevated: boolean | null = null;
/** Whether FBRX runs as administrator (root, or an elevated Windows process). Checked once. */
export async function runsElevated(): Promise<boolean> {
  if (elevated !== null) return elevated;
  if (process.platform !== 'win32') elevated = process.getuid?.() === 0;
  else elevated = await new Promise<boolean>((resolve) => execFile('net', ['session'], { windowsHide: true, timeout: 5000 }, (err) => resolve(!err)));
  return elevated;
}

export class MeshAssist {
  private readonly sessions = new Map<string, Session>();
  private admin = false;
  private adminFixed = false;
  private pollMs: number;

  constructor(private readonly d: AssistDeps) {
    this.pollMs = d.pollMs ?? 1500;
    void runsElevated().then((v) => {
      if (!this.adminFixed) this.admin = v;
    });
  }

  /** How often to check on a helper (tests use a short interval). */
  setPollInterval(ms: number) {
    this.pollMs = ms;
  }

  /** For tests and for FBRX Server, where its console's administrators decide (setting mesh.assist.controller). */
  setAdmin(v: boolean) {
    this.admin = v;
    this.adminFixed = true;
  }

  /** Whether this computer's requests count as an administrator's. */
  isAdmin(): boolean {
    return this.admin;
  }

  list(): AssistSession[] {
    return [...this.sessions.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((s) => this.view(s));
  }

  private view(s: Session): AssistSession {
    const { runId: _r, context: _c, limitTools: _l, maxSteps: _m, queuedAt: _q, ...pub } = s;
    return { ...pub, tools: [...s.tools] };
  }

  private changed(s: Session) {
    this.d.emit(this.view(s));
  }

  private keep(s: Session) {
    this.sessions.set(s.id, s);
    // Keep the last 200 (finished ones go first).
    if (this.sessions.size > 200) {
      for (const [id, old] of this.sessions) {
        if (this.sessions.size <= 200) break;
        if (ASSIST_TERMINAL.includes(old.status)) this.sessions.delete(id);
      }
    }
  }

  // ======================================================================================== helping (in)

  private acceptance(peer: MeshDevice, admin: boolean): { mode: AssistMode; reason: string | null; maxPriority: AssistPriority } {
    const s = this.d.settings();
    const controller = peer.permissions.command && admin;
    const maxPriority: AssistPriority = controller ? 'urgent' : 'high';
    if (s.offer === 'off') return { mode: 'off', reason: 'This computer does not lend its AI', maxPriority };
    if (!peer.permissions.assist && !peer.permissions.command) return { mode: 'off', reason: `${peer.name} may not ask this computer for help`, maxPriority };
    if (!this.d.agentReady().ready) return { mode: 'off', reason: 'This computer has no AI ready', maxPriority };
    if (controller) return { mode: 'auto', reason: null, maxPriority };
    return { mode: s.offer, reason: null, maxPriority };
  }

  private counts() {
    let busy = 0;
    let queued = 0;
    for (const s of this.sessions.values()) {
      if (s.direction !== 'in') continue;
      if (s.status === 'running') busy++;
      else if (s.status === 'queued' || s.status === 'waiting-approval') queued++;
    }
    return { busy, queued };
  }

  /** A mesh request from a paired computer (assist.offer / start / status / cancel). */
  async handle(peer: MeshDevice, method: string, p: any): Promise<unknown> {
    switch (method) {
      case 'assist.offer': {
        const a = this.acceptance(peer, !!p?.admin);
        const s = this.d.settings();
        return {
          deviceId: '',
          name: '',
          accepts: a.mode,
          reason: a.reason,
          ai: this.d.agentReady(),
          ...this.counts(),
          capacity: s.maxConcurrent,
          load: this.d.load(),
          roles: s.roles,
          maxPriority: a.maxPriority,
        } satisfies AssistOffer;
      }
      case 'assist.start':
        return this.view(await this.start(peer, StartParams.parse(p ?? {})));
      case 'assist.status':
        return this.view(this.mine(peer, p?.id));
      case 'assist.cancel': {
        const s = this.mine(peer, p?.id);
        this.stop(s, `${peer.name} cancelled it`);
        return this.view(s);
      }
      default:
        throw new CoreError('NOT_FOUND', `Unknown method ${method}`);
    }
  }

  private mine(peer: MeshDevice, id: unknown): Session {
    const s = this.sessions.get(String(id ?? ''));
    if (!s || s.direction !== 'in' || s.peerId !== peer.id) throw new CoreError('NOT_FOUND', 'No such help session');
    return s;
  }

  private async start(peer: MeshDevice, p: z.infer<typeof StartParams>): Promise<Session> {
    if (p.hops > 0) throw new CoreError('FORBIDDEN', 'Help is not passed along a second time');
    const a = this.acceptance(peer, p.admin);
    if (a.mode === 'off') throw new CoreError('FORBIDDEN', a.reason ?? 'This computer does not help right now');
    const s = this.d.settings();
    const priority = lowerPriority(p.priority, a.maxPriority);
    const controller = peer.permissions.command && p.admin;

    if (p.followUp) {
      const prev = this.mine(peer, p.followUp);
      if (!ASSIST_TERMINAL.includes(prev.status)) throw new CoreError('CONFLICT', 'That help session is still working');
      Object.assign(prev, { goal: p.goal, answer: '', error: null, status: 'queued', priority, finishedAt: null, queuedAt: Date.now(), context: '' });
      this.d.audit('assist.followup', `mesh:${peer.name}`, 'info', { session: prev.id });
      this.changed(prev);
      this.enqueue(prev, controller);
      return prev;
    }

    const session: Session = {
      id: newId('assist'),
      direction: 'in',
      peerId: peer.id,
      peerName: peer.name,
      kind: p.kind,
      trigger: p.trigger,
      priority,
      admin: controller,
      status: a.mode === 'ask' ? 'waiting-approval' : 'queued',
      goal: p.goal,
      answer: '',
      error: null,
      steps: 0,
      tools: [],
      createdAt: new Date().toISOString(),
      finishedAt: null,
      conversationId: null,
      remoteId: null,
      runId: null,
      context: p.context,
      limitTools: fewerTools(p.tools, s.tools),
      maxSteps: Math.min(p.maxSteps, s.maxSteps),
      queuedAt: Date.now(),
    };
    this.keep(session);
    this.d.audit('assist.requested', `mesh:${peer.name}`, 'info', { session: session.id, kind: p.kind, priority, trigger: p.trigger, controller, goal: p.goal.slice(0, 200) });
    this.changed(session);

    if (session.status === 'waiting-approval') {
      void this.d
        .approve({
          title: `Help ${peer.name}`,
          reason: `${peer.name} asks ${this.d.agentName()} on this computer for help (${priority} priority): ${p.goal.slice(0, 300)}`,
          input: { deviceId: peer.id, goal: p.goal.slice(0, 2000), priority },
        })
        .then(
          (ok) => {
            if (session.status !== 'waiting-approval') return;
            if (!ok) {
              this.finish(session, 'denied', 'The person at this computer declined');
              return;
            }
            session.status = 'queued';
            session.queuedAt = Date.now();
            this.changed(session);
            this.enqueue(session, controller);
          },
          (err) => this.finish(session, 'error', errorMessage(err)),
        );
    } else this.enqueue(session, controller);
    return session;
  }

  private enqueue(session: Session, controller: boolean) {
    const s = this.d.settings();
    const running = [...this.sessions.values()].filter((x) => x.direction === 'in' && x.status === 'running');
    if (controller && session.priority === 'urgent' && s.allowPreempt && running.length >= s.maxConcurrent) {
      // An urgent controller request makes room by stopping the least important help (never another controller's).
      const victim = running.filter((x) => !x.admin && assistRank(x.priority) < assistRank('urgent')).sort((a, b) => assistRank(a.priority) - assistRank(b.priority) || b.queuedAt - a.queuedAt)[0];
      if (victim) this.stop(victim, `Stopped to make way for an urgent request from ${session.peerName}`);
    }
    this.pump();
  }

  private pump() {
    const s = this.d.settings();
    const inbound = [...this.sessions.values()].filter((x) => x.direction === 'in');
    let running = inbound.filter((x) => x.status === 'running').length;
    const queue = inbound.filter((x) => x.status === 'queued').sort((a, b) => assistRank(b.priority) - assistRank(a.priority) || a.queuedAt - b.queuedAt);
    for (const next of queue) {
      if (running >= s.maxConcurrent) break;
      running++;
      void this.run(next);
    }
  }

  private prompt(s: Session): string {
    const name = this.d.agentName();
    const opening =
      s.kind === 'continue'
        ? `${s.peerName}'s agent could not finish a task and handed it to you. Finish it and reply with the final answer for the person on ${s.peerName}.`
        : s.kind === 'consult'
          ? `${s.peerName}'s agent is consulting you in the middle of its own work. Answer what it asks; be specific and brief, it will use your answer.`
          : `${s.peerName} hands you this piece of work. Do it and reply with the result.`;
    return [
      `[FBRX Mesh Assist · ${s.priority} priority] ${opening}`,
      `You are ${name} on this computer. You work with this computer's own tools and knowledge${s.limitTools === 'none' ? ' (no tools for this request: think and answer)' : s.limitTools === 'read' ? ' (looking things up only: nothing is changed for this request)' : ''}; you cannot reach ${s.peerName}'s files or programs.`,
      '',
      '--- Request ---',
      s.goal,
      ...(s.context.trim() ? ['', `--- What ${s.peerName} has so far ---`, s.context] : []),
    ].join('\n');
  }

  private async run(s: Session) {
    s.status = 'running';
    this.changed(s);
    try {
      const first = !s.conversationId;
      const handle = this.d.runHelp({
        message: first ? this.prompt(s) : `[FBRX Mesh Assist · follow-up from ${s.peerName}]\n${s.goal}`,
        conversationId: s.conversationId,
        title: `Helping ${s.peerName}: ${s.goal.replace(/\s+/g, ' ').slice(0, 60)}`,
        peerName: s.peerName,
        maxSteps: s.maxSteps,
        tools: s.limitTools,
      });
      s.runId = handle.runId;
      s.conversationId = handle.conversationId;
      this.changed(s);
      const off = this.d.onTool(handle.runId, (tool) => {
        s.tools.push(tool);
        this.changed(s);
      });
      const r = await handle.done.finally(off);
      s.steps += r.steps;
      if (s.status !== 'running') return; // stopped meanwhile
      s.answer = r.answer;
      this.finish(s, r.status === 'completed' ? 'done' : r.status === 'cancelled' ? 'cancelled' : 'error', r.error ?? null);
    } catch (err) {
      this.finish(s, 'error', errorMessage(err));
    }
  }

  private stop(s: Session, why: string) {
    if (ASSIST_TERMINAL.includes(s.status)) return;
    const runId = s.runId;
    this.finish(s, 'cancelled', why);
    if (runId) this.d.cancelRun(runId);
  }

  private finish(s: Session, status: Session['status'], error: string | null) {
    s.status = status;
    s.error = error;
    s.finishedAt = new Date().toISOString();
    s.runId = null;
    this.d.audit(`assist.${status}`, s.direction === 'in' ? `mesh:${s.peerName}` : 'agent', status === 'done' ? 'success' : status === 'denied' ? 'denied' : status === 'cancelled' ? 'info' : 'failure', {
      session: s.id,
      direction: s.direction,
      peer: s.peerName,
      steps: s.steps,
      error,
    });
    this.changed(s);
    if (s.direction === 'in') this.pump();
  }

  // ========================================================================================= asking (out)

  /** Paired computers that could help, best first (those that would say yes, with an AI ready and room). */
  async helpers(): Promise<AssistOffer[]> {
    if (!this.d.meshRunning()) return [];
    const peers = this.d.devices().filter((d) => d.kind === 'desktop');
    const offers = await Promise.all(
      peers.map((p) =>
        this.d
          .call<AssistOffer>(p.id, 'assist.offer', { admin: this.admin }, 5000)
          .then((o) => ({ ...o, deviceId: p.id, name: p.name }))
          .catch(() => null),
      ),
    );
    const score = (o: AssistOffer) => {
      if (o.accepts === 'off' || !o.ai.ready) return -1;
      const free = o.capacity - o.busy - o.queued;
      return (o.accepts === 'auto' ? 1000 : 500) + (free > 0 ? 200 : -50 * (1 - free)) + (o.roles.includes('ai') ? 50 : 0) - (o.load.cpu ?? 50) / 5;
    };
    return offers.filter((o): o is AssistOffer => !!o).sort((a, b) => score(b) - score(a));
  }

  private async pick(peerId?: string): Promise<AssistOffer> {
    const offers = await this.helpers();
    const usable = offers.filter((o) => o.accepts !== 'off' && o.ai.ready);
    if (peerId) {
      const want = offers.find((o) => o.deviceId === peerId || o.name.toLowerCase() === peerId.toLowerCase());
      if (!want) throw new CoreError('UNAVAILABLE', `${peerId} is not reachable on the mesh`);
      if (want.accepts === 'off' || !want.ai.ready) throw new CoreError('FORBIDDEN', `${want.name} cannot help right now${want.reason ? `: ${want.reason}` : ''}`);
      return want;
    }
    if (!usable.length) {
      const why = offers.map((o) => `${o.name}: ${o.reason ?? 'no AI ready'}`).join('; ');
      throw new CoreError('UNAVAILABLE', `No computer on the mesh can help right now${why ? ` (${why})` : ''}`);
    }
    return usable[0];
  }

  /**
   * Asks another computer's AI and waits for its answer. The person here is asked first when Mesh Assist's request
   * setting says so (help a person sends by hand is theirs already).
   */
  async request(p: {
    peerId?: string;
    kind: AssistKind;
    goal: string;
    context?: string;
    priority?: AssistPriority;
    tools?: AssistTools;
    trigger: AssistTrigger;
    signal?: AbortSignal;
    onUpdate?: (s: AssistSession) => void;
  }): Promise<AssistSession> {
    const s = await this.begin(p);
    return this.follow(s, p.signal, p.onUpdate);
  }

  /** Starts a request on the best (or chosen) helper and returns once the helper has it. */
  async begin(p: { peerId?: string; kind: AssistKind; goal: string; context?: string; priority?: AssistPriority; tools?: AssistTools; trigger: AssistTrigger; signal?: AbortSignal }): Promise<AssistSession> {
    if (!this.d.meshRunning()) throw new CoreError('UNAVAILABLE', 'Turn the mesh on first (Mesh & phone)');
    const settings = this.d.settings();
    const byPerson = p.trigger === 'person' || p.trigger === 'controller';
    if (!byPerson && settings.request === 'off') throw new CoreError('FORBIDDEN', 'Mesh Assist is off on this computer (Mesh & phone → Mesh Assist)');
    const offer = await this.pick(p.peerId);
    const session: Session = {
      id: newId('assist'),
      direction: 'out',
      peerId: offer.deviceId,
      peerName: offer.name,
      kind: p.kind,
      trigger: p.trigger,
      priority: lowerPriority(p.priority ?? settings.priority, offer.maxPriority),
      admin: this.admin,
      status: 'waiting-approval',
      goal: p.goal.slice(0, 16_000),
      answer: '',
      error: null,
      steps: 0,
      tools: [],
      createdAt: new Date().toISOString(),
      finishedAt: null,
      conversationId: null,
      remoteId: null,
      runId: null,
      context: (p.context ?? '').slice(-24_000),
      limitTools: p.tools ?? 'read',
      maxSteps: settings.maxSteps,
      queuedAt: Date.now(),
    };
    this.keep(session);
    this.changed(session);
    if (!byPerson && settings.request === 'ask') {
      const ok = await this.d.approve({
        title: `Bring in ${offer.name}`,
        reason:
          p.kind === 'continue'
            ? `${this.d.agentName()} could not finish (${p.trigger === 'steps' ? 'it ran out of steps' : 'the AI provider stopped answering'}) and wants ${offer.name} to take the task over.`
            : `${this.d.agentName()} wants to consult ${offer.name}'s AI: ${p.goal.slice(0, 300)}`,
        input: { deviceId: offer.deviceId, goal: p.goal.slice(0, 2000) },
        signal: p.signal,
      });
      if (!ok) {
        this.finish(session, 'denied', 'You chose not to bring another computer in');
        return this.view(session);
      }
    }
    try {
      const remote = await this.d.call<AssistSession>(offer.deviceId, 'assist.start', {
        kind: session.kind,
        goal: session.goal,
        context: session.context,
        priority: session.priority,
        tools: session.limitTools,
        maxSteps: session.maxSteps,
        trigger: session.trigger,
        admin: this.admin,
        hops: 0,
      });
      this.absorb(session, remote);
      this.d.audit('assist.sent', 'agent', 'info', { session: session.id, peer: offer.name, kind: session.kind, trigger: session.trigger, priority: session.priority });
    } catch (err) {
      this.finish(session, 'error', errorMessage(err));
    }
    return this.view(session);
  }

  private absorb(s: Session, remote: AssistSession) {
    s.remoteId = remote.id;
    s.status = remote.status;
    s.answer = remote.answer;
    s.error = remote.error;
    s.steps = remote.steps;
    s.tools = [...remote.tools];
    s.priority = remote.priority;
    if (ASSIST_TERMINAL.includes(remote.status)) s.finishedAt = remote.finishedAt ?? new Date().toISOString();
    this.changed(s);
  }

  /** Waits for a request's answer (cancelling it on the helper if this side gives up). */
  async follow(view: AssistSession, signal?: AbortSignal, onUpdate?: (s: AssistSession) => void, timeoutMs = 30 * 60_000): Promise<AssistSession> {
    const s = this.sessions.get(view.id);
    if (!s) throw new CoreError('NOT_FOUND', 'No such help session');
    const until = Date.now() + timeoutMs;
    let last = '';
    let misses = 0;
    while (!ASSIST_TERMINAL.includes(s.status) && s.remoteId) {
      if (signal?.aborted || Date.now() > until) {
        await this.d.call(s.peerId, 'assist.cancel', { id: s.remoteId }, 5000).catch(() => undefined);
        this.finish(s, 'cancelled', signal?.aborted ? 'Stopped here' : 'The helper took too long');
        break;
      }
      await new Promise((r) => setTimeout(r, this.pollMs));
      try {
        this.absorb(s, await this.d.call<AssistSession>(s.peerId, 'assist.status', { id: s.remoteId }, 10_000));
        misses = 0;
      } catch (err) {
        if (++misses >= 10) this.finish(s, 'error', `Lost touch with ${s.peerName}: ${errorMessage(err)}`);
      }
      const key = `${s.status}|${s.tools.length}`;
      if (key !== last) {
        last = key;
        onUpdate?.(this.view(s));
      }
    }
    if (ASSIST_TERMINAL.includes(s.status) && !s.finishedAt) s.finishedAt = new Date().toISOString();
    this.d.audit(`assist.${s.status}`, 'agent', s.status === 'done' ? 'success' : 'info', { session: s.id, peer: s.peerName, steps: s.steps, error: s.error });
    return this.view(s);
  }

  /** Asks the same helper a follow-up in the same conversation. */
  async followUp(id: string, text: string, signal?: AbortSignal): Promise<AssistSession> {
    const s = this.sessions.get(id);
    if (!s || s.direction !== 'out' || !s.remoteId) throw new CoreError('NOT_FOUND', 'No such help session');
    if (!ASSIST_TERMINAL.includes(s.status)) throw new CoreError('CONFLICT', `${s.peerName} is still working on it`);
    const remote = await this.d.call<AssistSession>(s.peerId, 'assist.start', {
      kind: s.kind,
      goal: text.slice(0, 16_000),
      priority: s.priority,
      tools: s.limitTools,
      maxSteps: s.maxSteps,
      trigger: s.trigger,
      admin: this.admin,
      hops: 0,
      followUp: s.remoteId,
    });
    s.goal = text.slice(0, 16_000);
    s.finishedAt = null;
    this.absorb(s, remote);
    return this.follow(this.view(s), signal);
  }

  /** Stops help: asked from here (cancelled on the helper too) or given here. */
  async cancel(id: string): Promise<AssistSession> {
    const s = this.sessions.get(id);
    if (!s) throw new CoreError('NOT_FOUND', 'No such help session');
    if (s.direction === 'out' && s.remoteId && !ASSIST_TERMINAL.includes(s.status)) await this.d.call(s.peerId, 'assist.cancel', { id: s.remoteId }, 5000).catch(() => undefined);
    this.stop(s, 'Stopped here');
    return this.view(s);
  }

  /** Hands work to one or more computers (or the best one) without waiting; answers arrive as mesh.assist events. */
  async send(p: { peerIds: string[] | 'any'; goal: string; priority?: AssistPriority; tools?: AssistTools }): Promise<AssistSession[]> {
    const trigger: AssistTrigger = this.admin ? 'controller' : 'person';
    const targets = p.peerIds === 'any' ? [undefined] : p.peerIds;
    if (!targets.length) throw new CoreError('INVALID_ARGUMENT', 'Choose at least one computer');
    const started = await Promise.all(
      targets.map((peerId) =>
        this.begin({ peerId, kind: 'task', goal: p.goal, priority: p.priority, tools: p.tools ?? 'read', trigger }).catch((err) => {
          // One computer that cannot take it does not stop the others.
          if (targets.length === 1) throw err;
          const name = this.d.devices().find((d) => d.id === peerId)?.name ?? peerId ?? 'a helper';
          const failed: Session = {
            id: newId('assist'), direction: 'out', peerId: peerId ?? '', peerName: name, kind: 'task', trigger, priority: p.priority ?? this.d.settings().priority, admin: this.admin,
            status: 'error', goal: p.goal.slice(0, 16_000), answer: '', error: errorMessage(err), steps: 0, tools: [], createdAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
            conversationId: null, remoteId: null, runId: null, context: '', limitTools: p.tools ?? 'read', maxSteps: 0, queuedAt: Date.now(),
          };
          this.keep(failed);
          this.changed(failed);
          return this.view(failed);
        }),
      ),
    );
    for (const s of started) if (!ASSIST_TERMINAL.includes(s.status)) void this.follow(s).catch(() => undefined);
    return started;
  }

  // ===================================================================================== agent handoffs

  canHandoff(trigger: 'steps' | 'provider'): boolean {
    const s = this.d.settings();
    if (!this.d.meshRunning() || s.request === 'off') return false;
    if (trigger === 'steps' ? !s.onStepLimit : !s.onProviderError) return false;
    return this.d.devices().some((d) => d.kind === 'desktop');
  }

  /** The agent stopped (out of steps, or its AI failed): another computer finishes the task. */
  async handoff(h: { trigger: 'steps' | 'provider'; task: string; digest: string; error?: string; signal?: AbortSignal; onStatus: (text: string) => void }): Promise<{ ok: true; peerName: string; answer: string } | { ok: false; reason: string }> {
    try {
      h.onStatus('Looking for another computer on the mesh to take over');
      const why = h.trigger === 'steps' ? 'It used every step it may take for one task.' : `Its AI provider stopped answering: ${h.error ?? 'unknown error'}.`;
      const s = await this.request({
        kind: 'continue',
        goal: h.task,
        context: `${why}\n\n${h.digest}`,
        trigger: h.trigger,
        tools: 'all',
        signal: h.signal,
        onUpdate: (u) => h.onStatus(u.status === 'running' ? `${u.peerName} is working on it${u.tools.length ? ` (${u.tools[u.tools.length - 1]})` : ''}` : u.status === 'waiting-approval' ? `Waiting for ${u.peerName} to accept` : `${u.peerName}: ${u.status}`),
      });
      if (s.status === 'done' && s.answer.trim()) return { ok: true, peerName: s.peerName, answer: s.answer };
      return { ok: false, reason: s.error ?? `${s.peerName} could not finish it (${s.status})` };
    } catch (err) {
      return { ok: false, reason: errorMessage(err) };
    }
  }
}
