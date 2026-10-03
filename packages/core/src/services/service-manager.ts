import type { ServiceState, ServiceStatus } from '@fbrx/shared';
import { errorMessage } from '../errors';
import type { AuditLog } from '../audit/audit-log';
import type { EventBus } from '../events';
import type { Logger } from '../logger';

export interface ServiceDef {
  name: string;
  title: string;
  description: string;
  dependsOn?: string[];
  /** Critical services must start or the kernel refuses to boot. */
  critical?: boolean;
  enabled?: () => boolean;
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
  health?(): Promise<{ state: 'running' | 'degraded' | 'failed'; message?: string | null }>;
}

interface Entry {
  def: ServiceDef;
  state: ServiceState;
  message: string | null;
  startedAt: string | null;
  restarts: number;
  restartTimes: number[];
}

/**
 * Starts services in dependency order, stops them in reverse, and runs a watchdog that health-checks each
 * service and restarts failed ones with exponential backoff (circuit-breaking after repeated failures).
 */
export class ServiceManager {
  private readonly entries = new Map<string, Entry>();
  private watchdog: NodeJS.Timeout | null = null;
  private checking = false;

  constructor(
    private readonly log: Logger,
    private readonly events: EventBus,
    private readonly audit: () => AuditLog | null,
  ) {}

  register(def: ServiceDef): void {
    this.entries.set(def.name, { def, state: 'stopped', message: null, startedAt: null, restarts: 0, restartTimes: [] });
  }

  private order(): Entry[] {
    const out: Entry[] = [];
    const seen = new Set<string>();
    const visit = (name: string, stack: string[]) => {
      if (seen.has(name)) return;
      if (stack.includes(name)) throw new Error(`Service dependency cycle: ${[...stack, name].join(' → ')}`);
      const e = this.entries.get(name);
      if (!e) throw new Error(`Unknown service dependency ${name}`);
      for (const dep of e.def.dependsOn ?? []) visit(dep, [...stack, name]);
      seen.add(name);
      out.push(e);
    };
    for (const name of this.entries.keys()) visit(name, []);
    return out;
  }

  private set(e: Entry, state: ServiceState, message: string | null = null) {
    const changed = e.state !== state || e.message !== message;
    e.state = state;
    e.message = message;
    if (changed) this.events.emit('service.changed', this.toStatus(e));
  }

  private async startEntry(e: Entry): Promise<void> {
    if (e.def.enabled && !e.def.enabled()) {
      this.set(e, 'disabled');
      return;
    }
    const blocked = (e.def.dependsOn ?? []).find((d) => {
      const s = this.entries.get(d)?.state;
      return s !== 'running' && s !== 'degraded';
    });
    if (blocked) {
      this.set(e, 'failed', `Dependency "${blocked}" is not running`);
      return;
    }
    this.set(e, 'starting');
    try {
      await e.def.start();
      e.startedAt = new Date().toISOString();
      this.set(e, 'running');
    } catch (err) {
      // Services that need saved credentials wait for the vault (it may be locked on purpose until its password is
      // entered); they start when it is unlocked.
      if ((err as { code?: string }).code === 'LOCKED') {
        this.set(e, 'stopped', 'Waiting for the vault to be unlocked');
        this.log.info(`Service ${e.def.name} waits for the vault to be unlocked`);
        return;
      }
      this.set(e, 'failed', errorMessage(err));
      this.log.error(`Service ${e.def.name} failed to start`, { error: errorMessage(err) });
      if (e.def.critical) throw err;
    }
  }

  async startAll(): Promise<void> {
    for (const e of this.order()) await this.startEntry(e);
  }

  async stopAll(): Promise<void> {
    this.stopWatchdog();
    for (const e of this.order().reverse()) {
      if (e.state === 'stopped' || e.state === 'disabled') continue;
      try {
        await e.def.stop();
      } catch (err) {
        this.log.warn(`Service ${e.def.name} did not stop cleanly`, { error: errorMessage(err) });
      }
      this.set(e, 'stopped');
    }
  }

  async restart(name: string): Promise<ServiceStatus> {
    const e = this.entries.get(name);
    if (!e) throw new Error(`Unknown service ${name}`);
    try {
      await e.def.stop();
    } catch {
      /* ignore */
    }
    this.set(e, 'stopped');
    e.restarts++;
    await this.startEntry(e);
    return this.toStatus(e);
  }

  /**
   * Re-evaluates `enabled()` for every service (e.g. after a license change): starts services that just became
   * available and stops ones that are no longer allowed.
   */
  async reconcile(): Promise<void> {
    for (const e of this.order()) {
      if (!e.def.enabled) continue;
      const allowed = e.def.enabled();
      if (allowed && e.state === 'disabled') {
        await this.startEntry(e);
      } else if (!allowed && e.state !== 'disabled' && e.state !== 'stopped') {
        try {
          await e.def.stop();
        } catch (err) {
          this.log.warn(`Service ${e.def.name} did not stop cleanly`, { error: errorMessage(err) });
        }
        this.set(e, 'disabled');
      }
    }
  }

  startWatchdog(intervalMs = 15_000): void {
    this.stopWatchdog();
    this.watchdog = setInterval(() => void this.check(), intervalMs);
    this.watchdog.unref();
  }

  stopWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }

  /** One watchdog pass (exposed for tests). */
  async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      for (const e of this.order()) {
        if (e.state === 'disabled' || e.state === 'stopped' || e.state === 'starting') continue;
        if (e.def.health && (e.state === 'running' || e.state === 'degraded')) {
          try {
            const h = await e.def.health();
            this.set(e, h.state, h.message ?? null);
          } catch (err) {
            this.set(e, 'failed', errorMessage(err));
          }
        }
        if (e.state === 'failed') await this.recover(e);
      }
    } finally {
      this.checking = false;
    }
  }

  private async recover(e: Entry) {
    const now = Date.now();
    e.restartTimes = e.restartTimes.filter((t) => now - t < 10 * 60_000);
    if (e.restartTimes.length >= 5) {
      if (!e.message?.includes('circuit open')) {
        this.set(e, 'failed', `${e.message ?? 'Failed'} (circuit open: too many restarts)`);
        this.audit()?.append({ category: 'service', action: 'circuit-open', actor: 'watchdog', target: e.def.name, outcome: 'failure' });
        this.events.emit('notification', { title: `${e.def.title} keeps failing`, body: e.message ?? '', level: 'error', source: 'watchdog' });
      }
      return;
    }
    const last = e.restartTimes[e.restartTimes.length - 1] ?? 0;
    const backoff = 5000 * 2 ** e.restartTimes.length;
    if (now - last < backoff) return;
    e.restartTimes.push(now);
    this.log.warn(`Watchdog restarting ${e.def.name}`, { reason: e.message });
    this.audit()?.append({ category: 'service', action: 'restarted', actor: 'watchdog', target: e.def.name, outcome: 'info', details: { reason: e.message } });
    await this.restart(e.def.name).catch(() => undefined);
  }

  list(): ServiceStatus[] {
    return this.order().map((e) => this.toStatus(e));
  }

  get(name: string): ServiceStatus | undefined {
    const e = this.entries.get(name);
    return e ? this.toStatus(e) : undefined;
  }

  private toStatus(e: Entry): ServiceStatus {
    return {
      name: e.def.name,
      title: e.def.title,
      description: e.def.description,
      state: e.state,
      message: e.message,
      startedAt: e.startedAt,
      restarts: e.restarts,
      dependsOn: e.def.dependsOn ?? [],
      critical: !!e.def.critical,
    };
  }
}
