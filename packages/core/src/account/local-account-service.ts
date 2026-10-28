import type { LocalAccountStatus, LocalAccountView } from '@fbrx/shared';
import { hashPassword, verifyPassword } from '@fbrx/shared/node';
import { CoreError } from '../errors';
import type { MetaStore } from '../storage/meta';
import type { AuditLog } from '../audit/audit-log';
import type { EventBus } from '../events';

/** The whole offline account, kept on this computer only. The password is stored as a scrypt hash, never in the clear. */
interface LocalAccountRecord {
  name: string;
  email: string | null;
  createdAt: string;
  passwordHash: string | null;
}

const KEY = 'localAccount';

/**
 * An offline FBRX account: a local identity for running FBRX with no cloud (a local-only environment, or the Beta
 * before the account server is live). It pairs with a license key for the edition. It never leaves the computer. An
 * optional password locks FBRX on start. This is separate from the cloud FBRX account (AccountService): a computer
 * uses one or the other.
 */
export class LocalAccountService {
  /** Set once the start password has been given this run (or when there is no password). */
  private unlocked = true;

  constructor(
    private readonly meta: MetaStore,
    private readonly audit: AuditLog,
    private readonly events: EventBus,
  ) {
    const rec = this.record();
    // At start, a computer with a start password waits for it before FBRX is used.
    this.unlocked = !rec?.passwordHash;
  }

  private record(): LocalAccountRecord | null {
    return this.meta.get<LocalAccountRecord>(KEY) ?? null;
  }

  private view(rec: LocalAccountRecord): LocalAccountView {
    return { name: rec.name, email: rec.email, passwordOnStart: !!rec.passwordHash, createdAt: rec.createdAt };
  }

  status(): LocalAccountStatus {
    const rec = this.record();
    return { exists: !!rec, account: rec ? this.view(rec) : null, locked: !!rec?.passwordHash && !this.unlocked };
  }

  /** Whether FBRX is waiting for the offline account's start password (the renderer shows a lock screen). */
  get isLocked(): boolean {
    return !this.unlocked;
  }

  async create(p: { name: string; email?: string; password?: string }, actor: string): Promise<LocalAccountStatus> {
    if (this.record()) throw new CoreError('CONFLICT', 'This computer already has an offline account');
    const name = p.name.trim();
    if (!name) throw new CoreError('INVALID_ARGUMENT', 'Enter a name for the account');
    const rec: LocalAccountRecord = {
      name,
      email: p.email?.trim() || null,
      createdAt: new Date().toISOString(),
      passwordHash: p.password ? await hashPassword(p.password) : null,
    };
    this.meta.set(KEY, rec);
    this.unlocked = true;
    this.audit.append({ category: 'user', action: 'localAccount.created', actor, target: name, outcome: 'success', details: { passwordOnStart: !!rec.passwordHash } });
    this.emit();
    return this.status();
  }

  update(p: { name?: string; email?: string | null }, actor: string): LocalAccountStatus {
    const rec = this.require();
    const next: LocalAccountRecord = { ...rec };
    if (p.name !== undefined) {
      const name = p.name.trim();
      if (!name) throw new CoreError('INVALID_ARGUMENT', 'Enter a name for the account');
      next.name = name;
    }
    if (p.email !== undefined) next.email = p.email?.trim() || null;
    this.meta.set(KEY, next);
    this.audit.append({ category: 'user', action: 'localAccount.updated', actor, outcome: 'success' });
    this.emit();
    return this.status();
  }

  /** Turns the start password on, or changes it (the current one is needed to change it). */
  async setPassword(p: { password: string; current?: string }, actor: string): Promise<LocalAccountStatus> {
    const rec = this.require();
    if (!p.password || p.password.length < 4) throw new CoreError('INVALID_ARGUMENT', 'Choose a password of at least 4 characters');
    if (rec.passwordHash) {
      if (!p.current || !(await verifyPassword(p.current, rec.passwordHash))) throw new CoreError('UNAUTHENTICATED', 'The current password is not right');
    }
    this.meta.set(KEY, { ...rec, passwordHash: await hashPassword(p.password) });
    this.unlocked = true;
    this.audit.append({ category: 'user', action: 'localAccount.passwordSet', actor, outcome: 'success' });
    this.emit();
    return this.status();
  }

  /** Turns the start password off (the current one is needed). */
  async clearPassword(p: { current: string }, actor: string): Promise<LocalAccountStatus> {
    const rec = this.require();
    if (!rec.passwordHash) return this.status();
    if (!(await verifyPassword(p.current, rec.passwordHash))) throw new CoreError('UNAUTHENTICATED', 'The current password is not right');
    this.meta.set(KEY, { ...rec, passwordHash: null });
    this.unlocked = true;
    this.audit.append({ category: 'user', action: 'localAccount.passwordCleared', actor, outcome: 'success' });
    this.emit();
    return this.status();
  }

  /** Gives the start password at launch; opens FBRX when it is right. */
  async unlock(p: { password: string }): Promise<LocalAccountStatus> {
    const rec = this.require();
    if (!rec.passwordHash) {
      this.unlocked = true;
    } else if (await verifyPassword(p.password, rec.passwordHash)) {
      this.unlocked = true;
      this.audit.append({ category: 'user', action: 'localAccount.unlocked', actor: `local:${rec.name}`, outcome: 'success' });
    } else {
      throw new CoreError('UNAUTHENTICATED', 'That password is not right');
    }
    this.emit();
    return this.status();
  }

  remove(p: { confirm: 'DELETE' }, actor: string): LocalAccountStatus {
    if (p.confirm !== 'DELETE') throw new CoreError('INVALID_ARGUMENT', 'Confirm with DELETE');
    const rec = this.require();
    this.meta.delete(KEY);
    this.unlocked = true;
    this.audit.append({ category: 'user', action: 'localAccount.removed', actor, target: rec.name, outcome: 'success' });
    this.emit();
    return this.status();
  }

  private require(): LocalAccountRecord {
    const rec = this.record();
    if (!rec) throw new CoreError('NOT_FOUND', 'This computer has no offline account yet');
    return rec;
  }

  private emit() {
    this.events.emit('localAccount.changed', this.status());
  }
}
