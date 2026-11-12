import { DEVELOPER_UNLOCK_LAST_MAJOR, SUPPORT_ENTER_PHRASE, SUPPORT_EXIT_PHRASE, type SupportStatus, type Tier } from '@fbrx/shared';
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
/** Black Hole Edition unlocked for FBRX's own development (SUPPORT_ENTER_PHRASE, until 3.0): when, and by whom. */
const DEVELOPER_KEY = 'support.developer';

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
  /** The organization this computer is enrolled in (fleet.tenantId), or null on a computer on its own. */
  tenantId?: () => string | null;
  /** This build's major version: the developer unlock works only up to DEVELOPER_UNLOCK_LAST_MAJOR. */
  appMajor?: number;
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
      if (p) return { tier: p.tier, until: p.expiresAt };
      return this.developer() ? { tier: 'blackhole', until: null } : null;
    });
  }

  /** Whether the pass may run here: the computer's own organization made it, or support is allowed here at all. */
  private permits(passTenant: string | undefined): boolean {
    const mine = this.d.tenantId?.() ?? null;
    return (!!passTenant && !!mine && passTenant === mine) || this.d.allowed();
  }

  /** The active, unexpired pass's payload, or null. A pass for another computer or a stale one never counts. */
  private valid(): { tier: Tier; expiresAt: string; issuedBy: string; note: string } | null {
    const pass = this.d.meta.get<string>(PASS_KEY);
    if (!pass) return null;
    const v = verifySupportPass(pass, this.d.publicKeys);
    if (!v.ok || v.expired || v.payload.installId !== this.d.installId() || !this.permits(v.payload.tenantId)) return null;
    return { tier: v.payload.tier, expiresAt: v.payload.expiresAt, issuedBy: v.payload.issuedBy, note: v.payload.note };
  }

  /** Whether this build still honors the developer unlock (it stops by itself from DEVELOPER_UNLOCK_LAST_MAJOR + 1). */
  developerUnlockAvailable(): boolean {
    return (this.d.appMajor ?? 0) <= DEVELOPER_UNLOCK_LAST_MAJOR;
  }

  /** Whether Black Hole Edition is unlocked here for FBRX's development (and this build still honors it). */
  private developer(): boolean {
    return !!this.d.meta.get<{ at: string }>(DEVELOPER_KEY) && this.developerUnlockAvailable();
  }

  status(): SupportStatus {
    const p = this.valid();
    return {
      active: !!p,
      installId: this.d.installId(),
      tier: p?.tier ?? null,
      until: p?.expiresAt ?? null,
      issuedBy: p?.issuedBy ?? null,
      note: p?.note ?? null,
      developer: this.developer(),
    };
  }

  /** Whether some text is the developer phrase (the entry points pass it here instead of to a license or a search). */
  isDeveloperPhrase(text: string): boolean {
    return text.trim().toLowerCase() === SUPPORT_ENTER_PHRASE;
  }

  /**
   * Unlocks Black Hole Edition on this computer at once, for FBRX's own development (until FBRX 3.0, then it is gone). It is
   * not a support pass: settings an organization locked stay locked, and it stays until the resume phrase ends it. On
   * an organization's computer its FBRX Command is told, as with a pass.
   */
  developerUnlock(actor: string): SupportStatus {
    if (!this.developerUnlockAvailable()) throw new CoreError('INVALID_ARGUMENT', 'That is not a license key or a support pass.');
    if (!this.developer()) {
      if (!this.d.meta.get<string>(PASS_KEY) && !this.d.meta.get<Tier>(BEFORE_KEY)) this.d.meta.set(BEFORE_KEY, this.d.meta.get<Tier>('edition.chosen') ?? 'essentials');
      this.d.meta.set(DEVELOPER_KEY, { at: new Date().toISOString(), by: actor });
      this.d.license.refresh();
      this.d.audit.append({ category: 'security', action: 'support.developer', actor, outcome: 'success', details: { tier: 'blackhole' } });
      this.d.report?.('Black Hole Edition was unlocked on this computer for FBRX development.', { by: actor });
      this.d.log.warn('Black Hole Edition unlocked for development');
      this.d.events.emit('support.changed', this.status());
    }
    return this.status();
  }

  /**
   * Begins support mode with a pass. The pass must be signed by FBRX, be for this computer and not have run out. The
   * edition the person had is remembered so it comes back exactly when support ends.
   */
  activate(pass: string, actor: string): SupportStatus {
    const v = verifySupportPass(pass.trim(), this.d.publicKeys);
    if (!v.ok) throw new CoreError('INVALID_ARGUMENT', v.error);
    if (v.expired) throw new CoreError('INVALID_ARGUMENT', 'This support pass has expired. Ask for a fresh one.');
    if (v.payload.installId !== this.d.installId()) throw new CoreError('FORBIDDEN', 'This support pass is for a different computer.');
    if (!this.permits(v.payload.tenantId)) {
      this.d.audit.append({ category: 'security', action: 'support.refused', actor, outcome: 'failure', details: { reason: 'organization', by: v.payload.issuedBy } });
      throw new CoreError(
        'FORBIDDEN',
        'This computer belongs to an organization, and this pass was not made by its FBRX Command. Ask that organization for a pass, or for it to turn on FBRX support access (support.allowOnManaged).',
      );
    }
    if (!this.d.meta.get<string>(PASS_KEY) && !this.d.meta.get<Tier>(BEFORE_KEY)) this.d.meta.set(BEFORE_KEY, this.d.meta.get<Tier>('edition.chosen') ?? 'essentials');
    this.d.meta.set(PASS_KEY, pass.trim());
    this.d.license.refresh();
    this.d.audit.append({ category: 'security', action: 'support.activated', actor, target: v.payload.issuedBy, outcome: 'success', details: { tier: v.payload.tier, until: v.payload.expiresAt, note: v.payload.note } });
    this.d.report?.(`Support mode started on this computer (${v.payload.tier}).`, { until: v.payload.expiresAt, note: v.payload.note, by: v.payload.issuedBy });
    this.d.log.warn('Support mode activated', { until: v.payload.expiresAt, by: v.payload.issuedBy });
    this.schedule();
    this.d.events.emit('support.changed', this.status());
    return this.status();
  }

  /**
   * Ends support mode (the resume phrase, a button, or the pass running out) and restores the previous edition. The
   * resume phrase and the button also end the developer unlock; a pass running out leaves it.
   */
  end(actor: string, reason: 'resume-phrase' | 'ended' | 'expired' | 'withdrawn'): SupportStatus {
    const pass = !!this.d.meta.get<string>(PASS_KEY);
    const developer = !!this.d.meta.get(DEVELOPER_KEY) && (reason === 'resume-phrase' || reason === 'ended');
    if (!pass && !developer) return this.status();
    this.d.meta.delete(PASS_KEY);
    if (developer) this.d.meta.delete(DEVELOPER_KEY);
    // The developer unlock still holds: the edition stays Black Hole Edition, and what came before is kept for its end.
    if (this.developer()) {
      this.d.license.refresh();
      this.stopTimer();
      this.d.audit.append({ category: 'security', action: 'support.ended', actor, outcome: 'success', details: { reason } });
      this.d.report?.('Support mode ended on this computer.', { reason });
      this.d.events.emit('support.changed', this.status());
      return this.status();
    }
    const before = this.d.meta.get<Tier>(BEFORE_KEY) ?? 'essentials';
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

  /** Why a stored pass no longer counts: it ran out, or the organization no longer allows it here. */
  private lapsed(): 'expired' | 'withdrawn' | null {
    const pass = this.d.meta.get<string>(PASS_KEY);
    if (!pass || this.valid()) return null;
    const v = verifySupportPass(pass, this.d.publicKeys);
    return v.ok && !v.expired && v.payload.installId === this.d.installId() ? 'withdrawn' : 'expired';
  }

  /** On start and every minute, end support by itself the moment its pass has run out. */
  start(): void {
    // A build past the developer unlock's last version forgets it (and the edition it was keeping, when no pass is on).
    if (this.d.meta.get(DEVELOPER_KEY) && !this.developerUnlockAvailable()) {
      this.d.meta.delete(DEVELOPER_KEY);
      if (!this.d.meta.get<string>(PASS_KEY)) this.d.meta.delete(BEFORE_KEY);
    }
    const lapsed = this.lapsed();
    if (lapsed) this.end('system', lapsed);
    else if (this.valid()) this.schedule();
  }

  /** The organization changed its mind (support.allowOnManaged turned off): a pass it did not make ends at once. */
  settingsChanged(): void {
    if (this.lapsed() === 'withdrawn') this.end('system', 'withdrawn');
  }

  private schedule(): void {
    this.stopTimer();
    this.timer = setInterval(() => {
      const lapsed = this.lapsed();
      if (lapsed) this.end('system', lapsed);
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
