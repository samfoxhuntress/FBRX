import { atLeast, tierRank, type AccountDevice, type AccountDeviceInfo, type AccountLicense, type AccountStatus, type AccountView, type Tier, type Vertical } from '@fbrx/shared';
import { CoreError } from '../errors';
import type { MetaStore } from '../storage/meta';
import type { Vault } from '../vault/vault';
import type { LicenseService } from '../license/license-service';
import type { AuditLog } from '../audit/audit-log';
import type { EventBus } from '../events';
import type { Logger } from '../logger';

/** The account token is a secret: it lives in the vault, like the computer's FBRX Command credential. */
const TOKEN_SECRET = 'fbrx.account.token';
/** How often the account's license is renewed while FBRX runs. */
const REFRESH_MS = 6 * 3600_000;
/** What this computer keeps about the account, forgotten at sign-out (the FBRX Command address stays for next time). */
const ACCOUNT_META = ['account.id', 'account.view', 'account.tier', 'account.licenseUntil', 'account.lastSyncAt', 'account.error', 'account.canBuy'];

export interface AccountDeps {
  meta: MetaStore;
  vault: Vault;
  license: LicenseService;
  audit: AuditLog;
  events: EventBus;
  log: Logger;
  /** The FBRX Command FBRX accounts live on when nobody named another (built in, or FBRX_ACCOUNT_SERVER). */
  defaultServer: string;
  /** This computer, as its sign-ins say (its name, system, FBRX version and install id). */
  device: () => AccountDeviceInfo;
  /** Joins this computer to an organization with a one-time token (FleetAgent.enroll). */
  enroll: (serverUrl: string, token: string, fingerprint: string | null, actor: string) => Promise<unknown>;
}

/**
 * The person's FBRX account on this computer. Signing in brings what the account bought (Standard or Ultra, bought on
 * the website, on another computer or in a phone app) as a license key, and turns that edition on; the key is renewed
 * every few hours, and when the account's purchase ends the computer goes back to what it had. An account that belongs
 * to an organization can join this computer to it, at the edition the organization gave that person.
 */
export class AccountService {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly d: AccountDeps) {}

  private get server(): string {
    return this.d.meta.get<string>('account.server') ?? this.d.defaultServer;
  }

  private token(): string | null {
    if (!this.d.vault.isUnlocked) return null;
    try {
      return this.d.vault.get(TOKEN_SECRET, { allowInternal: true }) ?? null;
    } catch {
      return null;
    }
  }

  status(): AccountStatus {
    const view = this.d.meta.get<AccountView>('account.view');
    const signedIn = !!this.d.meta.get<string>('account.id');
    return {
      signedIn,
      emailVerified: signedIn && !!view?.emailVerified,
      server: this.server,
      email: signedIn ? (view?.email ?? null) : null,
      name: signedIn ? (view?.name ?? null) : null,
      tier: signedIn ? (view?.tier ?? 'essentials') : 'essentials',
      licenseUntil: this.d.meta.get<string>('account.licenseUntil') ?? null,
      memberships: signedIn ? (view?.memberships ?? []) : [],
      canBuy: signedIn && !!this.d.meta.get<boolean>('account.canBuy'),
      billingPortal: signedIn && !!view?.billingPortal,
      lastSyncAt: this.d.meta.get<string>('account.lastSyncAt') ?? null,
      error: this.d.meta.get<string>('account.error') ?? null,
    };
  }

  private async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, token?: string | null, server = this.server): Promise<T> {
    if (!server) throw new CoreError('INVALID_ARGUMENT', 'Enter the address of your FBRX Command');
    let url: URL;
    try {
      url = new URL(path, server.includes('://') ? server : `https://${server}`);
    } catch {
      throw new CoreError('INVALID_ARGUMENT', 'That is not an FBRX Command address');
    }
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      throw new CoreError('UNAVAILABLE', `FBRX Command could not be reached at ${url.host}: ${(err as Error).message}`);
    }
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    if (res.status === 401) throw new CoreError('UNAUTHENTICATED', json.error?.message ?? 'Sign in to your FBRX account again');
    if (!res.ok) throw new CoreError(res.status === 403 ? 'FORBIDDEN' : res.status === 409 ? 'CONFLICT' : 'UNAVAILABLE', json.error?.message ?? `FBRX Command answered ${res.status}`);
    return json as T;
  }

  /** Signs in (or makes a new account first), brings the account's edition and turns it on. */
  async signIn(p: { server?: string; email: string; password: string; name?: string; create?: boolean }, actor: string): Promise<AccountStatus> {
    if (!this.d.vault.isUnlocked) throw new CoreError('LOCKED', 'Unlock the vault before signing in');
    const server = (p.server?.trim() || this.server).replace(/\/+$/, '');
    const r = await this.request<{ token: string; account: AccountView }>(
      'POST',
      p.create ? '/v1/accounts/signup' : '/v1/accounts/login',
      { email: p.email.trim(), password: p.password, device: this.d.device(), ...(p.create ? { name: p.name?.trim() || p.email.split('@')[0] } : {}) },
      null,
      server,
    );
    this.d.vault.set({ name: TOKEN_SECRET, value: r.token, kind: 'token', description: 'FBRX account sign-in' }, { internal: true });
    this.d.meta.set('account.server', server);
    this.d.meta.set('account.id', r.account.id);
    this.d.audit.append({ category: 'license', action: p.create ? 'account.created' : 'account.signedIn', actor, target: r.account.email, outcome: 'success', details: { server } });
    await this.refresh({ adopt: true });
    this.start();
    return this.status();
  }

  async signOut(actor: string): Promise<AccountStatus> {
    const token = this.token();
    if (token) await this.request('POST', '/v1/accounts/logout', {}, token).catch(() => undefined);
    try {
      this.d.vault.delete(TOKEN_SECRET, { internal: true });
    } catch {
      /* locked */
    }
    const email = this.status().email;
    for (const k of ACCOUNT_META) this.d.meta.delete(k);
    this.d.license.applyAccount(null);
    this.stop();
    this.d.audit.append({ category: 'license', action: 'account.signedOut', actor, target: email ?? undefined, outcome: 'success' });
    this.emit();
    return this.status();
  }

  /**
   * Renews the account's license and what it knows about the account. `adopt`: turn the account's edition on (at
   * sign-in, and whenever the account gets more than it had); otherwise what the person chose stays.
   */
  async refresh(opts: { adopt?: boolean } = {}): Promise<AccountStatus> {
    const token = this.token();
    if (!this.d.meta.get<string>('account.id') || !token) return this.status();
    try {
      const [view, lic, plans] = await Promise.all([
        this.request<AccountView>('GET', '/v1/accounts/me', undefined, token),
        this.request<AccountLicense>('GET', '/v1/accounts/license', undefined, token),
        this.request<{ payments?: { stripe?: boolean } }>('GET', '/v1/plans').catch(() => ({ payments: undefined })),
      ]);
      const before = this.d.meta.get<Tier>('account.tier') ?? 'essentials';
      this.d.meta.set('account.view', view);
      this.d.meta.set('account.tier', lic.tier);
      this.d.meta.set('account.canBuy', !!plans.payments?.stripe);
      this.d.meta.set('account.lastSyncAt', new Date().toISOString());
      this.d.meta.delete('account.error');
      if (lic.expiresAt) this.d.meta.set('account.licenseUntil', lic.expiresAt);
      else this.d.meta.delete('account.licenseUntil');
      this.d.license.applyAccount(lic.key);
      // "Whatever their credentials have access to": the account's edition comes on by itself.
      if ((opts.adopt || tierRank(lic.tier) > tierRank(before)) && lic.tier !== 'essentials') this.adopt(lic.tier);
    } catch (err) {
      const e = err as CoreError;
      this.d.meta.set('account.error', e.code === 'UNAUTHENTICATED' ? 'Your FBRX account sign-in has ended: sign in again.' : e.message);
      if (e.code === 'UNAUTHENTICATED') {
        // The license it gave stays until it runs out; nothing renews it now.
        this.d.meta.delete('account.id');
        try {
          this.d.vault.delete(TOKEN_SECRET, { internal: true });
        } catch {
          /* locked */
        }
      }
      this.d.log.warn('FBRX account renewal failed', { error: e.message });
    }
    this.emit();
    return this.status();
  }

  /** Turns an edition on if this computer may run it (an organization may hold it lower). */
  private adopt(tier: Tier) {
    const st = this.d.license.status();
    const target = st.ceiling && !atLeast(st.ceiling, tier) ? st.ceiling : tier;
    if (st.ceilingReason !== 'learner' && st.chosen !== target && (!st.chosen || tierRank(target) > tierRank(st.chosen))) {
      try {
        this.d.license.choose(target);
      } catch {
        /* held lower */
      }
    }
  }

  /** Where the account is signed in: this computer, others, phones and browsers. */
  devices(): Promise<AccountDevice[]> {
    return this.request<AccountDevice[]>('GET', '/v1/accounts/sessions', undefined, this.requireToken());
  }

  /** Signs the account out on another computer, phone or browser. */
  async signOutDevice(id: string, actor: string): Promise<{ ok: true }> {
    await this.request('DELETE', `/v1/accounts/sessions/${encodeURIComponent(id)}`, undefined, this.requireToken());
    this.d.audit.append({ category: 'license', action: 'account.signedOutDevice', actor, target: id, outcome: 'success' });
    return { ok: true };
  }

  /** Sends the email that confirms the account's address again. */
  resendConfirmation(): Promise<{ sent: boolean }> {
    return this.request<{ sent: boolean }>('POST', '/v1/accounts/verify/resend', {}, this.requireToken());
  }

  /** Emails a link to choose a new password (opened on the website); says the same whether the account exists or not. */
  async forgotPassword(p: { email: string; server?: string }): Promise<{ ok: true }> {
    await this.request('POST', '/v1/accounts/password/forgot', { email: p.email.trim() }, null, (p.server?.trim() || this.server).replace(/\/+$/, ''));
    return { ok: true };
  }

  /** A Stripe Checkout page for Standard or Ultra, opened in the browser. */
  async checkout(productId: string): Promise<{ url: string }> {
    return this.request<{ url: string }>('POST', '/v1/billing/checkout', { productId }, this.requireToken());
  }

  /** The billing portal (change plan or card, invoices, cancel), opened in the browser. */
  async portal(): Promise<{ url: string }> {
    return this.request<{ url: string }>('POST', '/v1/billing/portal', {}, this.requireToken());
  }

  /** Joins this computer to an organization the account belongs to, at the edition it gives the account. */
  async join(tenantId: string, actor: string): Promise<AccountStatus> {
    const r = await this.request<{ serverUrl: string; token: string; fingerprint: string | null; tier: Tier }>('POST', `/v1/accounts/memberships/${encodeURIComponent(tenantId)}/enroll`, {}, this.requireToken());
    await this.d.enroll(r.serverUrl, r.token, r.fingerprint, actor);
    this.adopt(r.tier);
    this.emit();
    return this.status();
  }

  /** Starts an FBRX Command for the person's organization; they own it and sign in to its console with this account. */
  async startOrganization(p: { name: string; kind: Vertical }): Promise<{ consoleUrl: string; tenantId: string }> {
    const r = await this.request<{ consoleUrl: string; tenantId: string }>('POST', '/v1/accounts/tenants', p, this.requireToken());
    await this.refresh();
    return r;
  }

  private requireToken(): string {
    const t = this.token();
    if (!t) throw new CoreError('UNAUTHENTICATED', 'Sign in to your FBRX account first');
    return t;
  }

  private emit() {
    this.d.events.emit('account.changed', this.status());
  }

  /** Renews now (when signed in) and every few hours. */
  start() {
    if (this.timer || !this.d.meta.get<string>('account.id')) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), REFRESH_MS);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
