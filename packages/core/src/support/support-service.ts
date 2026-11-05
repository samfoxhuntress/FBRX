import { SUPPORT_EXIT_PHRASE, type SupportStatus, type Tier } from '@fbrx/shared';
import { verifySupportPass } from '@fbrx/shared/node';
import { CoreError } from '../errors';
import type { MetaStore } from '../storage/meta';
import type { LicenseService } from '../license/license-service';
import type { AuditLog } from '../audit/audit-log';
import type { EventBus } from '../events';
import type { Logger } from '../logger';

/** Where the active pass is kept (the pass itself, so it is re-checked and expires on its own across restarts). */
const PASS_KEY = 'support.pass';
/** The edition the person had chosen before support began, so the resume phrase and expiry put it back exactly. */
const BEFORE_KEY = 'support.beforeChosen';

export interface SupportDeps {
  meta: MetaStore;
  license: LicenseService;
  publicKeys: string[];
  audit: AuditLog;
  events: EventBus;
  log: Logger;
  installId: () => string;
  /**
   * Whether support mode may run here: always on a computer on its own; on an organization's computer only when the
   * organization turned it on (settings.support.allowOnManaged, from FBRX Command).
   */
  allowed: () => boolean;
  /** Tells an organization's FBRX Command that a support session started or ended on this computer. */
  report?: (message: string, data: Record<string, unknown>) => void;
}

/**
 * Support mode on this computer. A support pass (signed by FBRX, tied to this install id, short-lived) elevates the
 * computer to full access for troubleshooting; the resume phrase or the pass running out puts everything back. The
 * license service reads this service's elevation, so turning support on or off is one place. Everything is audited.
 */
export class SupportService {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly d: SupportDeps) {
    // The license service asks this for the current elevation; null means support is off (or the pass ran out).
    this.d.license.setSupportElevation(() => {
      const p = this.valid();
      return p ? { tier: p.tier, until: p.expiresAt } : null;
    });
  }

  /** The active, unexpired pass's payload, or null. A pass for another computer or a stale one never counts. */
  private valid(): { tier: Tier; expiresAt: string; issuedBy: string; note: string } | null {
    const pass = this.d.meta.get<string>(PASS_KEY);
    if (!pass || !this.d.allowed()) return null;
    const v = verifySupportPass(pass, this.d.publicKeys);
    if (!v.ok || v.expired || v.payload.installId !== this.d.installId()) return null;
    return { tier: v.payload.tier, expiresAt: v.payload.expiresAt, issuedBy: v.payload.issuedBy, note: v.payload.note };
  }

  status(): SupportStatus {
    const p = this.valid();
    return { active: !!p, installId: this.d.installId(), tier: p?.tier ?? null, until: p?.expiresAt ?? null, issuedBy: p?.issuedBy ?? null, note: p?.note ?? null };
  }

  /**
   * Begins support mode with a pass. The pass must be signed by FBRX, be for this computer and not have run out. The
   * edition the person had is remembered so it comes back exactly when support ends.
   */
  activate(pass: string, actor: string): SupportStatus {
    if (!this.d.allowed()) {
      this.d.audit.append({ category: 'security', action: 'support.refused', actor, outcome: 'failure', details: { reason: 'organization' } });
      throw new CoreError('FORBIDDEN', 'This computer belongs to an organization that has not turned on FBRX support access. Its FBRX Command can turn it on (support.allowOnManaged).');
    }
    const v = verifySupportPass(pass.trim(), this.d.publicKeys);
    if (!v.ok) throw new CoreError('INVALID_ARGUMENT', v.error);
    if (v.expired) throw new CoreError('INVALID_ARGUMENT', 'This support pass has expired. Ask for a fresh one.');
    if (v.payload.installId !== this.d.installId()) throw new CoreError('FORBIDDEN', 'This support pass is for a different computer.');
    if (!this.d.meta.get<string>(PASS_KEY)) this.d.meta.set(BEFORE_KEY, this.d.meta.get<Tier>('edition.chosen') ?? 'essentials');
    this.d.meta.set(PASS_KEY, pass.trim());
    this.d.license.refresh();
    this.d.audit.append({ category: 'security', action: 'support.activated', actor, target: v.payload.issuedBy, outcome: 'success', details: { tier: v.payload.tier, until: v.payload.expiresAt, note: v.payload.note } });
    this.d.report?.(`Support mode started on this computer (${v.payload.tier}).`, { until: v.payload.expiresAt, note: v.payload.note, by: v.payload.issuedBy });
    this.d.log.warn('Support mode activated', { until: v.payload.expiresAt, by: v.payload.issuedBy });
    this.schedule();
    this.d.events.emit('support.changed', this.status());
    return this.status();
  }

  /** Ends support mode (the resume phrase, a button, or the pass running out) and restores the previous edition. */
  end(actor: string, reason: 'resume-phrase' | 'ended' | 'expired' | 'withdrawn'): SupportStatus {
    if (!this.d.meta.get<string>(PASS_KEY)) return this.status();
    const before = this.d.meta.get<Tier>(BEFORE_KEY) ?? 'essentials';
    this.d.meta.delete(PASS_KEY);
    this.d.meta.delete(BEFORE_KEY);
    this.d.license.refresh();
    try {
      // Put the person's edition back to exactly what it was (never above what the computer may now run).
      this.d.license.choose(before);
    } catch {
      /* the ceiling fell back on its own */
    }
    this.stopTimer();
    this.d.audit.append({ category: 'security', action: 'support.ended', actor, outcome: 'success', details: { reason } });
    this.d.report?.('Support mode ended on this computer.', { reason });
    this.d.events.emit('support.changed', this.status());
    return this.status();
  }

  /** Whether some text is the resume phrase (used by the entry points: the license box, Spotlight, FBRX/1, browser). */
  isResumePhrase(text: string): boolean {
    return text.trim().toLowerCase() === SUPPORT_EXIT_PHRASE;
  }

  /** On start and every minute, end support by itself the moment its pass has run out. */
  start(): void {
    if (this.valid()) this.schedule();
    else if (this.d.meta.get<string>(PASS_KEY)) this.end('system', this.d.allowed() ? 'expired' : 'withdrawn');
  }

  /** The organization changed its mind (support.allowOnManaged turned off): support ends at once. */
  settingsChanged(): void {
    if (this.d.meta.get<string>(PASS_KEY) && !this.d.allowed()) this.end('system', 'withdrawn');
  }

  private schedule(): void {
    this.stopTimer();
    this.timer = setInterval(() => {
      if (!this.valid() && this.d.meta.get<string>(PASS_KEY)) this.end('system', this.d.allowed() ? 'expired' : 'withdrawn');
    }, 60_000);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  stop(): void {
    this.stopTimer();
  }
}
