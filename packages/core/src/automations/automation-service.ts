import {
  AUTOMATION_NO_CHANGE,
  newId,
  nextAutomationRun,
  type Automation,
  type AutomationInput,
  type AutomationRun,
  type AutomationSchedule,
  type NotificationEvent,
} from '@fbrx/shared';
import { CoreError, errorMessage } from '../errors';
import type { Db } from '../storage/db';
import type { EventBus } from '../events';
import type { Logger } from '../logger';
import type { AuditLog } from '../audit/audit-log';
import type { AgentRuntime } from '../ai/agent';

interface AutomationRow {
  id: string;
  name: string;
  prompt: string;
  schedule: string;
  notify: Automation['notify'];
  online: number;
  hotkey: string;
  enabled: number;
  conversation_id: string | null;
  next_run_at: string | null;
  created_at: string;
}

interface RunRow {
  id: string;
  automation_id: string;
  trigger: AutomationRun['trigger'];
  started_at: string;
  finished_at: string | null;
  status: AutomationRun['status'];
  changed: number;
  summary: string;
}

const runView = (r: RunRow): AutomationRun => ({ id: r.id, automationId: r.automation_id, trigger: r.trigger, startedAt: r.started_at, finishedAt: r.finished_at, status: r.status, changed: !!r.changed, summary: r.summary });

/** How often due automations are looked for. */
const TICK_MS = 30_000;
/** Automations that run at start wait this long, so FBRX is ready (and the AI model loaded) first. */
const START_DELAY_MS = 60_000;
/** Runs kept for each automation. */
const KEEP_RUNS = 50;

/** What every run adds to the agent's instructions: nobody is watching, and how to say "nothing new". */
function instructions(a: Automation): string {
  return [
    '## Automation',
    `- This request is the automation "${a.name}": it runs by itself and nobody is watching, so do not ask questions. Do the job with the tools you have and report what you found, briefly.`,
    ...(a.notify === 'changes' ? [`- If nothing is new or different since your last report in this chat, answer with exactly ${AUTOMATION_NO_CHANGE} and nothing else.`] : []),
  ].join('\n');
}

/** A short, plain-text version of an answer for a notification or the run list. */
function plain(text: string, max: number): string {
  const t = text
    .replace(/```[\s\S]*?```/g, ' ')
    // List items one after another: "Found two: Trek, $420 · Giant, $380".
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '· ')
    .replace(/(^|:)\s*· /g, '$1 ')
    .replace(/\n· /g, ' · ')
    .replace(/[*_`#>|]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export interface AutomationDeps {
  db: Db;
  agent: AgentRuntime;
  events: EventBus;
  log: Logger;
  audit: AuditLog;
  notify: (n: NotificationEvent) => void;
  /** Why automations cannot run on this computer (its edition), or null. */
  blocked: () => string | null;
  /** Shortcuts already taken elsewhere in FBRX (its own and the person's macros). */
  takenHotkeys: () => string[];
}

/** Automations: stored, scheduled, run by the agent with nobody there to approve, and reported. */
export class AutomationService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly running = new Set<string>();
  /** One automation at a time: a local AI model answers one question at a time anyway. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly d: AutomationDeps) {}

  private row(id: string): AutomationRow {
    const r = this.d.db.get<AutomationRow>('SELECT * FROM automations WHERE id = ?', id);
    if (!r) throw new CoreError('NOT_FOUND', 'That automation is gone');
    return r;
  }

  private view(r: AutomationRow): Automation {
    const last = this.d.db.get<RunRow>('SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT 1', r.id);
    return {
      id: r.id,
      name: r.name,
      prompt: r.prompt,
      schedule: JSON.parse(r.schedule) as AutomationSchedule,
      notify: r.notify,
      online: !!r.online,
      hotkey: r.hotkey,
      enabled: !!r.enabled,
      conversationId: r.conversation_id,
      createdAt: r.created_at,
      nextRunAt: r.next_run_at,
      running: this.running.has(r.id),
      lastRun: last ? runView(last) : null,
    };
  }

  list(): Automation[] {
    return this.d.db.all<AutomationRow>('SELECT * FROM automations ORDER BY created_at').map((r) => this.view(r));
  }

  get(id: string): Automation {
    return this.view(this.row(id));
  }

  /** The shortcuts the app binds: those of automations that are on, while automations may run on this computer. */
  hotkeys(): Array<{ id: string; hotkey: string }> {
    if (this.d.blocked()) return [];
    return this.d.db.all<{ id: string; hotkey: string }>("SELECT id, hotkey FROM automations WHERE enabled = 1 AND hotkey != '' ORDER BY created_at");
  }

  runs(id: string, limit = 20): AutomationRun[] {
    return this.d.db.all<RunRow>('SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT ?', id, limit).map(runView);
  }

  private check(input: AutomationInput, id: string | null) {
    const blocked = this.d.blocked();
    if (blocked) throw new CoreError('FEATURE_UNAVAILABLE', blocked);
    if (input.hotkey) {
      const others = this.d.db.all<{ hotkey: string }>("SELECT hotkey FROM automations WHERE hotkey != '' AND id != ?", id ?? '').map((r) => r.hotkey);
      if ([...this.d.takenHotkeys(), ...others].includes(input.hotkey)) throw new CoreError('CONFLICT', `${input.hotkey} is already used by another shortcut in FBRX`);
    }
  }

  /** When an automation that runs on a schedule is next due (null for one that runs at start or by hand). */
  private nextRun(input: AutomationInput, lastRun: Date | null): string | null {
    return input.enabled ? (nextAutomationRun(input.schedule, new Date(), lastRun)?.toISOString() ?? null) : null;
  }

  create(input: AutomationInput, actor: string): Automation {
    this.check(input, null);
    const id = newId('auto');
    const now = new Date().toISOString();
    this.d.db.run(
      'INSERT INTO automations (id, name, prompt, schedule, notify, online, hotkey, enabled, next_run_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      id,
      input.name,
      input.prompt,
      JSON.stringify(input.schedule),
      input.notify,
      input.online ? 1 : 0,
      input.hotkey,
      input.enabled ? 1 : 0,
      this.nextRun(input, null),
      now,
      now,
    );
    this.d.audit.append({ category: 'agent', action: 'automation.created', actor, target: input.name, outcome: 'success', details: { schedule: input.schedule, notify: input.notify, online: input.online } });
    this.changed();
    return this.get(id);
  }

  update(id: string, patch: Partial<AutomationInput>, actor: string): Automation {
    const before = this.get(id);
    const next: AutomationInput = { name: before.name, prompt: before.prompt, schedule: before.schedule, notify: before.notify, online: before.online, hotkey: before.hotkey, enabled: before.enabled, ...patch };
    this.check(next, id);
    const last = before.lastRun ? new Date(before.lastRun.startedAt) : null;
    this.d.db.run(
      'UPDATE automations SET name = ?, prompt = ?, schedule = ?, notify = ?, online = ?, hotkey = ?, enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?',
      next.name,
      next.prompt,
      JSON.stringify(next.schedule),
      next.notify,
      next.online ? 1 : 0,
      next.hotkey,
      next.enabled ? 1 : 0,
      this.nextRun(next, last),
      new Date().toISOString(),
      id,
    );
    this.d.audit.append({ category: 'agent', action: 'automation.updated', actor, target: next.name, outcome: 'success', details: { fields: Object.keys(patch) } });
    this.changed();
    return this.get(id);
  }

  /** Deletes an automation and its runs; its chat stays (the person deletes chats in Conversations). */
  remove(id: string, actor: string): { removed: boolean } {
    const r = this.d.db.get<AutomationRow>('SELECT * FROM automations WHERE id = ?', id);
    if (!r) return { removed: false };
    this.d.db.run('DELETE FROM automations WHERE id = ?', id);
    this.d.audit.append({ category: 'agent', action: 'automation.removed', actor, target: r.name, outcome: 'success' });
    this.changed();
    return { removed: true };
  }

  /** Runs an automation now (its button, its shortcut); it waits its turn behind one already running. */
  runNow(id: string, trigger: 'manual' | 'hotkey' = 'manual'): Automation {
    const blocked = this.d.blocked();
    if (blocked) throw new CoreError('FEATURE_UNAVAILABLE', blocked);
    const a = this.get(id);
    if (a.running) throw new CoreError('CONFLICT', `${a.name} is running already`);
    void this.enqueue(a.id, trigger);
    return this.get(id);
  }

  private enqueue(id: string, trigger: AutomationRun['trigger']): Promise<void> {
    this.running.add(id);
    this.changed();
    const job = this.queue.then(() => this.run(id, trigger));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async run(id: string, trigger: AutomationRun['trigger']): Promise<void> {
    const runId = newId('arun');
    const started = new Date();
    let a: Automation;
    try {
      a = this.get(id);
    } catch {
      this.running.delete(id);
      return;
    }
    this.d.db.run("INSERT INTO automation_runs (id, automation_id, trigger, started_at, status) VALUES (?,?,?,?,'running')", runId, id, trigger, started.toISOString());
    this.changed();
    let status: AutomationRun['status'] = 'failed';
    let summary = '';
    let changed = true;
    let conversationId = a.conversationId;
    try {
      const ask = (conv: string | null) =>
        this.d.agent.runToCompletion({
          conversationId: conv ?? undefined,
          message: a.prompt,
          instructions: instructions(a),
          title: a.name,
          offline: !a.online,
          origin: 'scheduler',
          actor: `automation:${a.name}`,
          limits: { unattended: true, assist: false },
        });
      // The person may have deleted the automation's chat: start a new one.
      const r = await ask(conversationId).catch((err) => (err instanceof CoreError && err.code === 'NOT_FOUND' && conversationId ? ask((conversationId = null)) : Promise.reject(err)));
      conversationId = r.conversationId;
      const answer = r.answer.trim();
      status = r.status === 'completed' ? 'done' : 'failed';
      changed = !(a.lastRun && new RegExp(`^\\W*${AUTOMATION_NO_CHANGE}\\W*$`).test(answer));
      summary = status === 'failed' ? (r.error ?? 'The run did not finish') : changed ? plain(answer, 600) : 'Nothing new.';
    } catch (err) {
      summary = errorMessage(err);
    }
    const now = new Date();
    this.d.db.tx(() => {
      this.d.db.run('UPDATE automation_runs SET finished_at = ?, status = ?, changed = ?, summary = ? WHERE id = ?', now.toISOString(), status, changed ? 1 : 0, summary, runId);
      this.d.db.run('DELETE FROM automation_runs WHERE automation_id = ? AND id NOT IN (SELECT id FROM automation_runs WHERE automation_id = ? ORDER BY started_at DESC LIMIT ?)', id, id, KEEP_RUNS);
      // The next run counts from when this one started, so a slow run does not push the schedule along.
      const current = this.d.db.get<AutomationRow>('SELECT * FROM automations WHERE id = ?', id);
      if (current) this.d.db.run('UPDATE automations SET conversation_id = ?, next_run_at = ? WHERE id = ?', conversationId, this.nextRun({ ...this.view(current), enabled: !!current.enabled }, started), id);
    });
    this.running.delete(id);
    this.d.log.info('Automation ran', { automation: a.name, trigger, status, changed });
    if (status === 'failed' || a.notify === 'always' || (a.notify === 'changes' && changed)) {
      this.d.notify({
        title: status === 'failed' ? `${a.name} did not finish` : a.name,
        body: status === 'failed' ? summary : plain(summary, 220),
        level: status === 'failed' ? 'warning' : 'info',
        source: 'automation',
        ...(conversationId ? { open: `agent/chat/${conversationId}` } : {}),
      });
    }
    this.changed();
  }

  /** Runs what is due: scheduled automations whose time has come (a computer that slept runs each once, not over and over). */
  tick(): void {
    if (this.d.blocked()) return;
    const due = this.d.db.all<{ id: string }>('SELECT id FROM automations WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?', new Date().toISOString());
    for (const { id } of due) if (!this.running.has(id)) void this.enqueue(id, 'schedule');
  }

  start(): void {
    this.stop();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.timer.unref?.();
    this.startTimer = setTimeout(() => {
      if (this.d.blocked()) return;
      for (const a of this.list()) if (a.enabled && a.schedule.kind === 'start' && !a.running) void this.enqueue(a.id, 'start');
      this.tick();
    }, START_DELAY_MS);
    this.startTimer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.startTimer) clearTimeout(this.startTimer);
    this.timer = null;
    this.startTimer = null;
  }

  private changed() {
    this.d.events.emit('automations.changed', this.list());
  }
}
