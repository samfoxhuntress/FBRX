import { CLOUD_AI_PATH, atLeast, tierRank, type AccountComputers, type AccountDevice, type AccountDeviceInfo, type AccountLicense, type AccountStatus, type AccountView, type CloudAiUsage, type InvitationPreview, type PriceBook, type PromoRedeemed, type Tier, type Vertical } from '@fbrx/shared';
import { CoreError } from '../errors';
import type { MetaStore } from '../storage/meta';
import type { Vault } from '../vault/vault';
import type { LicenseService } from '../license/license-service';
import type { AuditLog } from '../audit/audit-log';
import type { EventBus } from '../events';
import type { Logger } from '../logger';
import { formatFingerprint, pinnedAgent, pinnedFetch, untrustedCertificate } from '../util/pinned-tls';

/** The account token is a secret: it lives in the vault, like the computer's FBRX Command credential. */
const TOKEN_SECRET = 'fbrx.account.token';
/** How often the account's license is renewed while FBRX runs. */
const REFRESH_MS = 6 * 3600_000;
/**
 * What this computer keeps about the account, forgotten at sign-out (the FBRX Command address stays for next time, with
 * the fingerprint of its own certificate when it has one: account.server, account.fingerprint).
 */
const ACCOUNT_META = ['account.id', 'account.view', 'account.tier', 'account.licenseUntil', 'account.lastSyncAt', 'account.error', 'account.canBuy', 'account.prices', 'account.computers', 'account.licenseNote'];

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
  /** This computer is in an organization already (it then joins another only when the person says so). */
  enrolled: () => boolean;
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
      computers: signedIn ? (this.d.meta.get<AccountComputers>('account.computers') ?? null) : null,
      licenseNote: signedIn ? (this.d.meta.get<string>('account.licenseNote') ?? null) : null,
      memberships: signedIn ? (view?.memberships ?? []) : [],
      canBuy: signedIn && !!this.d.meta.get<boolean>('account.canBuy'),
      prices: signedIn ? (this.d.meta.get<PriceBook>('account.prices') ?? null) : null,
      billingPortal: signedIn && !!view?.billingPortal,
      lastSyncAt: this.d.meta.get<string>('account.lastSyncAt') ?? null,
      error: this.d.meta.get<string>('account.error') ?? null,
    };
  }

  /** An address on the account's FBRX Command (https:// when only its name was given). */
  private url(path: string, server = this.server): URL {
    if (!server) throw new CoreError('INVALID_ARGUMENT', 'Enter the address of your FBRX Command');
    try {
      return new URL(path, server.includes('://') ? server : `https://${server}`);
    } catch {
      throw new CoreError('INVALID_ARGUMENT', 'That is not an FBRX Command address');
    }
  }

  /**
   * The fingerprint of the certificate to trust for an FBRX Command that uses its own (one on this computer or the home
   * network): the one just given, or the one kept for the account's FBRX Command.
   */
  private pinFor(server: string, given?: string): string | null {
    if (given) {
      const pin = formatFingerprint(given);
      if (pin.length !== 95) throw new CoreError('INVALID_ARGUMENT', 'That certificate fingerprint is not a SHA-256 fingerprint (32 pairs like AB:CD:…)');
      return pin;
    }
    return server === this.server ? (this.d.meta.get<string>('account.fingerprint') ?? null) : null;
  }

  private async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, token?: string | null, at: { server?: string; pin?: string | null; signal?: AbortSignal } = {}): Promise<T> {
    const server = at.server ?? this.server;
    const url = this.url(path, server);
    const pin = at.pin !== undefined ? at.pin : this.pinFor(server);
    const timeout = AbortSignal.timeout(20_000);
    const init: RequestInit = {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: at.signal ? AbortSignal.any([at.signal, timeout]) : timeout,
    };
    let res: Response;
    try {
      res = pin && url.protocol === 'https:' ? await pinnedFetch(url.toString(), init, pinnedAgent(pin, `FBRX Command at ${url.host} presented a different certificate than the one this computer trusts. If it was reinstalled, check its fingerprint and trust it again.`)) : await fetch(url, init);
    } catch (err) {
      if (err instanceof CoreError) throw err;
      if (url.protocol === 'https:' && untrustedCertificate(err)) throw new CoreError('FORBIDDEN', `FBRX Command at ${url.host} uses its own certificate: check its fingerprint and trust it to go on.`);
      throw new CoreError('UNAVAILABLE', `FBRX Command could not be reached at ${url.host}: ${(err as Error).message}`);
    }
    const json = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    if (res.status === 401) throw new CoreError('UNAUTHENTICATED', json.error?.message ?? 'Sign in to your FBRX account again', { signedOut: json.error?.code === 'SIGNED_OUT' });
    if (!res.ok) throw new CoreError(res.status === 403 ? 'FORBIDDEN' : res.status === 409 ? 'CONFLICT' : res.status === 400 ? 'INVALID_ARGUMENT' : 'UNAVAILABLE', json.error?.message ?? `FBRX Command answered ${res.status}`);
    return json as T;
  }

  /** The FBRX Command a sign-in goes to: the one named, or the one this computer uses. */
  private serverFor(named?: string): string {
    return (named?.trim() || this.server).replace(/\/+$/, '');
  }

  /** Signs in (or makes a new account first), brings the account's edition and turns it on. */
  async signIn(p: { server?: string; fingerprint?: string; email: string; password: string; name?: string; create?: boolean }, actor: string): Promise<AccountStatus> {
    if (!this.d.vault.isUnlocked) throw new CoreError('LOCKED', 'Unlock the vault before signing in');
    const server = this.serverFor(p.server);
    const pin = this.pinFor(server, p.fingerprint);
    const r = await this.request<{ token: string; account: AccountView }>(
      'POST',
      p.create ? '/v1/accounts/signup' : '/v1/accounts/login',
      { email: p.email.trim(), password: p.password, device: this.d.device(), ...(p.create ? { name: p.name?.trim() || p.email.split('@')[0] } : {}) },
      null,
      { server, pin },
    );
    return this.signedIn(server, pin, r, actor, p.create ? 'account.created' : 'account.signedIn');
  }

  /** What an invitation code from an organization is for, before using it. */
  async previewInvitation(p: { code: string; server?: string; fingerprint?: string }): Promise<InvitationPreview> {
    const server = this.serverFor(p.server);
    return this.request<InvitationPreview>('POST', '/v1/accounts/invitations/preview', { code: p.code }, null, { server, pin: this.pinFor(server, p.fingerprint) });
  }

  /**
   * Uses an organization's invitation code: FBRX Command makes the account (or checks the password of the one that
   * email has), adds it to the organization, and signs in here; then this computer joins the organization too, unless
   * it is in one already (the organization is then listed with its Join button, like any other membership).
   */
  async acceptInvitation(p: { code: string; server?: string; fingerprint?: string; name?: string; password: string }, actor: string): Promise<AccountStatus> {
    if (!this.d.vault.isUnlocked) throw new CoreError('LOCKED', 'Unlock the vault before signing in');
    const server = this.serverFor(p.server);
    const pin = this.pinFor(server, p.fingerprint);
    const r = await this.request<{ token: string; account: AccountView; tenantId: string }>('POST', '/v1/accounts/invitations/accept', { code: p.code, name: p.name?.trim() || undefined, password: p.password, device: this.d.device() }, null, { server, pin });
    await this.signedIn(server, pin, r, actor, 'account.invitationAccepted');
    return this.d.enrolled() ? this.status() : this.join(r.tenantId, actor);
  }

  /** Keeps a new sign-in's token and account, and turns on what the account brings. */
  private async signedIn(server: string, pin: string | null, r: { token: string; account: AccountView }, actor: string, action: string): Promise<AccountStatus> {
    this.d.vault.set({ name: TOKEN_SECRET, value: r.token, kind: 'token', description: 'FBRX account sign-in' }, { internal: true });
    this.d.meta.set('account.server', server);
    if (pin) this.d.meta.set('account.fingerprint', pin);
    else this.d.meta.delete('account.fingerprint');
    this.d.meta.set('account.id', r.account.id);
    this.d.audit.append({ category: 'license', action, actor, target: r.account.email, outcome: 'success', details: { server } });
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

  /** Keeps the license the account gave this computer, the computers its edition covers, and why it has none. */
  private keepLicense(lic: AccountLicense) {
    if (lic.expiresAt) this.d.meta.set('account.licenseUntil', lic.expiresAt);
    else this.d.meta.delete('account.licenseUntil');
    if (lic.computers) this.d.meta.set('account.computers', lic.computers);
    else this.d.meta.delete('account.computers');
    if (lic.note) this.d.meta.set('account.licenseNote', lic.note);
    else this.d.meta.delete('account.licenseNote');
    this.d.license.applyAccount(lic.key);
  }

  /** Extra computers past those the account's edition covers (on its Stripe plan), then this computer's license. */
  async setExtraComputers(extra: number, actor: string): Promise<AccountStatus> {
    const token = this.token();
    if (!token) throw new CoreError('UNAUTHENTICATED', 'Sign in to your FBRX account first');
    const lic = await this.request<AccountLicense>('POST', '/v1/billing/computers', { extra }, token);
    this.keepLicense(lic);
    if (lic.key && lic.tier !== 'essentials') this.adopt(lic.tier);
    this.d.audit.append({ category: 'license', action: 'account.extraComputers', actor, outcome: 'success', details: { extra } });
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
        this.request<{ payments?: { stripe?: boolean }; prices?: PriceBook }>('GET', '/v1/plans').catch(() => ({ payments: undefined, prices: undefined })),
      ]);
      const before = this.d.meta.get<Tier>('account.tier') ?? 'essentials';
      this.d.meta.set('account.view', view);
      this.d.meta.set('account.tier', lic.tier);
      this.d.meta.set('account.canBuy', !!plans.payments?.stripe);
      if (plans.prices) this.d.meta.set('account.prices', plans.prices);
      this.d.meta.set('account.lastSyncAt', new Date().toISOString());
      this.d.meta.delete('account.error');
      this.keepLicense(lic);
      // "Whatever their credentials have access to": the account's edition comes on by itself (on a computer it covers).
      if (lic.key && (opts.adopt || tierRank(lic.tier) > tierRank(before)) && lic.tier !== 'essentials') this.adopt(lic.tier);
    } catch (err) {
      const e = err as CoreError;
      const signedOut = e.code === 'UNAUTHENTICATED' && (e.details as { signedOut?: boolean } | undefined)?.signedOut === true;
      this.d.meta.set('account.error', signedOut ? 'This computer was signed out of your FBRX account: sign in again.' : e.code === 'UNAUTHENTICATED' ? 'Your FBRX account sign-in has ended: sign in again.' : e.message);
      if (e.code === 'UNAUTHENTICATED') {
        // An ended sign-in leaves the license it gave until that runs out, as nothing renews it now. A computer signed
        // out from elsewhere gives it back at once, so its place goes to another of the person's computers.
        if (signedOut) this.keepLicense({ key: null, tier: 'essentials', expiresAt: null, computers: null, note: null });
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
  async forgotPassword(p: { email: string; server?: string; fingerprint?: string }): Promise<{ ok: true }> {
    const server = this.serverFor(p.server);
    await this.request('POST', '/v1/accounts/password/forgot', { email: p.email.trim() }, null, { server, pin: this.pinFor(server, p.fingerprint) });
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

  /** Where FBRX Cloud AI is for the signed-in account, with its sign-in as the key; null when none is signed in. */
  cloudAccess(): { baseUrl: string; token: string; fingerprint: string | null } | null {
    const token = this.d.meta.get<string>('account.id') ? this.token() : null;
    return token ? { baseUrl: this.url(CLOUD_AI_PATH).toString(), token, fingerprint: this.pinFor(this.server) } : null;
  }

  /** The account's FBRX Cloud AI this month: its allowance, what it used, extra tokens, and whether it takes chats. */
  cloudAi(signal?: AbortSignal): Promise<CloudAiUsage> {
    return this.request<CloudAiUsage>('GET', '/v1/accounts/ai', undefined, this.requireToken(), { signal });
  }

  /** Uses a promo code on the account, and turns on an edition it gives. */
  async redeemPromo(code: string, actor: string): Promise<{ redeemed: PromoRedeemed; status: AccountStatus; ai: CloudAiUsage }> {
    const r = await this.request<{ redeemed: PromoRedeemed; ai: CloudAiUsage }>('POST', '/v1/accounts/promo', { code }, this.requireToken());
    this.d.audit.append({ category: 'license', action: 'account.promoRedeemed', actor, target: r.redeemed.code, outcome: 'success' });
    return { redeemed: r.redeemed, status: r.redeemed.tier ? await this.refresh({ adopt: true }) : this.status(), ai: r.ai };
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
