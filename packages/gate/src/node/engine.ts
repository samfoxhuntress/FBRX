import { diffConfig } from '../diff';
import { GateConfigSchema, type GateConfig } from '../model';
import { render, type GateRendered } from '../render/index';
import type { GatePaths } from '../render/paths';
import type { GateCommit, GateLive, GateState } from '../types';
import { checkConfig, type GateCheck } from '../validate';
import type { GateApplier } from './applier';
import { GateError } from './errors';
import type { GateStore } from './store';

export interface GateEngineOptions {
  store: GateStore;
  applier: GateApplier;
  paths: GatePaths;
  /** The configuration to start editing from on a gate that has none yet. */
  initial: () => GateConfig;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

interface PendingConfirm {
  commitId: number;
  deadline: string;
}

/**
 * The gate's configuration life cycle, like a router's: people edit a candidate; a commit checks it, applies it
 * and records it; a failed apply puts the previous configuration back at once; "commit confirmed" rolls itself back
 * unless someone confirms within the time given (so a change that cuts you off undoes itself); any earlier commit
 * can be rolled back to.
 */
export class GateEngine {
  private timer: NodeJS.Timeout | null = null;
  private busy: Promise<unknown> = Promise.resolve();
  private notes: string[] = [];

  constructor(private readonly o: GateEngineOptions) {
    if (!o.store.candidate()) o.store.setCandidate(GateConfigSchema.parse(o.initial()), 'system');
  }

  private log(level: 'info' | 'warn' | 'error', msg: string) {
    this.o.log?.(level, msg);
  }

  /** One change at a time. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.busy.then(fn, fn);
    this.busy = next.catch(() => undefined);
    return next;
  }

  private runningId(): number | null {
    return this.o.store.meta<number>('running_id');
  }

  running(): GateConfig | null {
    const id = this.runningId();
    return id ? (this.o.store.commit(id)?.config ?? null) : null;
  }

  candidate(): GateConfig {
    return this.o.store.candidate()!;
  }

  private pending(): PendingConfirm | null {
    return this.o.store.meta<PendingConfirm>('confirm');
  }

  state(): GateState {
    const cand = this.candidate();
    const run = this.running();
    const check = checkConfig(cand);
    const last = this.o.store.commits(1)[0] ?? null;
    return { running: run, candidate: cand, changes: diffConfig(run ?? {}, cand), errors: check.errors, warnings: check.warnings, confirm: this.pending(), lastCommit: last, vpnPublicKey: this.o.store.meta<string>('vpn_public_key') };
  }

  /** Notes from the last apply (fallbacks taken). */
  lastNotes(): string[] {
    return [...this.notes];
  }

  /** Replaces the candidate. A configuration with the wrong shape is refused; one with other problems is kept (to fix). */
  setCandidate(input: unknown, by: string): GateCheck {
    const check = checkConfig(input);
    if (!check.config) throw new GateError('The configuration has the wrong shape', 'INVALID', check.errors);
    this.o.store.setCandidate(check.config, by);
    return check;
  }

  /** Throws the edits away: the candidate is what runs again. */
  reset(by: string): GateState {
    const run = this.running();
    if (run) this.o.store.setCandidate(run, by);
    return this.state();
  }

  private paths() {
    return this.o.paths;
  }

  private rendered(c: GateConfig | null): GateRendered | null {
    return c ? render(c, this.paths()) : null;
  }

  commit(o: { by: string; comment?: string; confirmMinutes?: number }): Promise<GateCommit> {
    return this.serial(async () => {
      if (this.pending()) throw new GateError('The last commit is waiting to be confirmed: confirm it or roll it back first', 'CONFLICT');
      const cand = this.candidate();
      const check = checkConfig(cand);
      if (!check.ok || !check.config) throw new GateError(`The configuration has ${check.errors.length} problem${check.errors.length === 1 ? '' : 's'} to fix first`, 'INVALID', check.errors);
      const config = check.config;
      const prevId = this.runningId();
      const prev = this.running();
      const changes = diffConfig(prev ?? {}, config).length;
      if (prev && changes === 0) throw new GateError('Nothing to commit: the candidate is what runs', 'CONFLICT');
      const next = render(config, this.paths());
      const before = this.rendered(prev);
      await this.o.applier.check(next).catch((e) => {
        throw new GateError((e as Error).message, 'INVALID');
      });
      if (config.vpn.enabled) this.o.store.setMeta('vpn_public_key', (await this.o.applier.vpnKey()).publicKey);
      const minutes = o.confirmMinutes && o.confirmMinutes > 0 ? Math.min(o.confirmMinutes, 60) : 0;
      const deadline = minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null;
      try {
        this.notes = await this.o.applier.apply(next, before, config);
      } catch (e) {
        const message = (e as Error).message;
        this.log('error', `Gate commit failed, putting the previous configuration back: ${message}`);
        if (prev) await this.o.applier.apply(before!, next, prev).catch((err) => this.log('error', `Putting it back failed too: ${(err as Error).message}`));
        else await this.o.applier.clear(next).catch(() => undefined);
        this.o.store.addCommit({ by: o.by, comment: o.comment ?? '', status: 'failed', confirmBy: null, error: message, changes, config, previousId: prevId });
        throw new GateError(`It could not be applied, so nothing changed: ${message}`, 'APPLY');
      }
      const id = this.o.store.addCommit({ by: o.by, comment: o.comment ?? '', status: deadline ? 'applied' : 'confirmed', confirmBy: deadline, error: null, changes, config, previousId: prevId });
      this.o.store.setMeta('running_id', id);
      if (deadline) {
        this.o.store.setMeta('confirm', { commitId: id, deadline } satisfies PendingConfirm);
        this.arm();
      }
      this.log('info', `Gate commit ${id} by ${o.by}: ${changes} change${changes === 1 ? '' : 's'}${deadline ? `, rolls back at ${deadline} unless confirmed` : ''}`);
      return this.o.store.commits(1)[0];
    });
  }

  /** Keeps a commit made with "commit confirmed". */
  confirm(by: string): GateCommit {
    const p = this.pending();
    if (!p) throw new GateError('No commit is waiting to be confirmed', 'CONFLICT');
    this.disarm();
    this.o.store.setMeta('confirm', null);
    this.o.store.setStatus(p.commitId, 'confirmed');
    this.log('info', `Gate commit ${p.commitId} confirmed by ${by}`);
    return this.o.store.commits(50).find((c) => c.id === p.commitId)!;
  }

  private arm() {
    this.disarm();
    const p = this.pending();
    if (!p) return;
    const ms = Math.max(0, Date.parse(p.deadline) - Date.now());
    this.timer = setTimeout(() => void this.rollbackPending('It was not confirmed in time').catch((e) => this.log('error', `Gate rollback failed: ${(e as Error).message}`)), ms);
  }

  private disarm() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Undoes the commit waiting for confirmation. The candidate keeps it, to fix and commit again. */
  rollbackPending(reason: string): Promise<GateCommit | null> {
    return this.serial(async () => {
      const p = this.pending();
      if (!p) return null;
      this.disarm();
      const c = this.o.store.commit(p.commitId);
      const prev = c?.previousId ? this.o.store.commit(c.previousId)?.config ?? null : null;
      const now = this.rendered(c?.config ?? null);
      if (prev) this.notes = await this.o.applier.apply(render(prev, this.paths()), now, prev);
      else await this.o.applier.clear(now);
      this.o.store.setStatus(p.commitId, 'rolled-back', reason);
      this.o.store.setMeta('running_id', c?.previousId ?? null);
      this.o.store.setMeta('confirm', null);
      this.log('warn', `Gate commit ${p.commitId} rolled back: ${reason}`);
      return this.o.store.commits(50).find((x) => x.id === p.commitId) ?? null;
    });
  }

  /** Makes an earlier commit's configuration the candidate and commits it. */
  async rollback(o: { to: number; by: string; confirmMinutes?: number }): Promise<GateCommit> {
    const c = this.o.store.commit(o.to);
    if (!c) throw new GateError(`There is no commit ${o.to}`, 'NOT_FOUND');
    this.o.store.setCandidate(c.config, o.by);
    return this.commit({ by: o.by, comment: `Back to commit ${o.to}`, confirmMinutes: o.confirmMinutes });
  }

  history(limit = 50): GateCommit[] {
    return this.o.store.commits(limit);
  }

  commitConfig(id: number): GateConfig {
    const c = this.o.store.commit(id);
    if (!c) throw new GateError(`There is no commit ${id}`, 'NOT_FOUND');
    return c.config;
  }

  live(): Promise<GateLive> {
    return this.o.applier.live(this.running());
  }

  /**
   * At service start: a commit still waiting to be confirmed is rolled back (the gate restarted before anyone said it
   * was fine), otherwise what runs is applied again (traffic shaping and anything else the kernel forgot).
   */
  async start(): Promise<void> {
    if (this.pending()) {
      await this.rollbackPending('The gate restarted before it was confirmed');
      return;
    }
    const run = this.running();
    if (run) {
      await this.serial(async () => {
        this.notes = await this.o.applier.apply(render(run, this.paths()), null, run);
      }).catch((e) => this.log('error', `Gate configuration not applied at start: ${(e as Error).message}`));
    }
  }

  stop() {
    this.disarm();
  }
}
