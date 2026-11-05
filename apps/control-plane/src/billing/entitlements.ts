import { TIER_SHORT, formatPrice, licenseEditionFor, maxTier, productById, type AccountComputers, type AccountLicense, type EntitlementStatus, type EntitlementView, type PaidTier, type PurchaseSource, type Tier } from '@fbrx/shared';
import { signLicense, type Db } from '@fbrx/shared/node';
import type { AppContext } from '../context';
import { ids } from '../context';
import { priceBook } from './pricing';

/**
 * What accounts and organizations bought, one row per subscription item or store purchase, kept up to date by the
 * payment providers (Stripe webhooks, App Store Server Notifications, Google Play notifications). Every provider is
 * folded into the same shape, so an account's edition is the fullest one any of its purchases gives, wherever it was
 * bought.
 */

/** A license from an account lasts this long past the period paid for, so a late renewal does not lock anyone out. */
export const LICENSE_SLACK_DAYS = 3;
/** And at most this long, so a computer comes back for a fresh one (a refund or a revocation reaches it in time). */
export const LICENSE_MAX_DAYS = 35;

export interface PurchaseUpdate {
  source: PurchaseSource;
  /** The provider's id: the Stripe subscription, the App Store original transaction or the Play purchase token. */
  externalId: string;
  productId: string;
  status: EntitlementStatus;
  periodEnd: string | null;
  quantity?: number;
  accountId?: string | null;
  tenantId?: string | null;
}

interface Row {
  id: string;
  account_id: string | null;
  tenant_id: string | null;
  product_id: string;
  kind: EntitlementView['kind'];
  tier: Tier | null;
  source: PurchaseSource;
  external_id: string;
  status: EntitlementStatus;
  quantity: number;
  period_end: string | null;
}

/** Whether a purchase counts right now: paid for (or in the store's grace period), and its period has not ended. */
export function isValid(e: { status: EntitlementStatus; period_end: string | null }, now = Date.now()): boolean {
  if (e.status === 'pending' || e.status === 'expired') return false;
  return !e.period_end || Date.parse(e.period_end) > now;
}

export function entitlementView(e: Row): EntitlementView {
  return { id: e.id, productId: e.product_id, kind: e.kind, tier: e.tier, source: e.source, status: e.status, quantity: e.quantity, periodEnd: e.period_end, valid: isValid(e) };
}

/** Records a purchase or its new state. Unknown products are ignored (a price on the provider that is not FBRX's). */
export function recordPurchase(ctx: AppContext, u: PurchaseUpdate): EntitlementView | null {
  const product = productById(u.productId);
  if (!product) {
    ctx.log.warn({ productId: u.productId, source: u.source }, 'Ignoring a purchase of an unknown product');
    return null;
  }
  const now = new Date().toISOString();
  const tier = product.kind === 'edition' || product.kind === 'extra' ? product.tier : null;
  const existing = ctx.db.get<Row>('SELECT * FROM entitlements WHERE source = ? AND external_id = ? AND product_id = ?', u.source, u.externalId, u.productId);
  if (existing) {
    ctx.db.run(
      'UPDATE entitlements SET status = ?, period_end = ?, quantity = ?, account_id = COALESCE(?, account_id), tenant_id = COALESCE(?, tenant_id), updated_at = ? WHERE id = ?',
      u.status,
      u.periodEnd,
      u.quantity ?? existing.quantity,
      u.accountId ?? null,
      u.tenantId ?? null,
      now,
      existing.id,
    );
  } else {
    ctx.db.run(
      'INSERT INTO entitlements (id, account_id, tenant_id, product_id, kind, tier, source, external_id, status, quantity, period_end, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ids.entitlement(),
      u.accountId ?? null,
      u.tenantId ?? null,
      u.productId,
      product.kind,
      tier,
      u.source,
      u.externalId,
      u.status,
      u.quantity ?? 1,
      u.periodEnd,
      now,
      now,
    );
  }
  const row = ctx.db.get<Row>('SELECT * FROM entitlements WHERE source = ? AND external_id = ? AND product_id = ?', u.source, u.externalId, u.productId)!;
  ctx.audit.record({ type: 'system', id: null, label: `billing:${u.source}`, tenantId: row.tenant_id }, 'billing.purchase', { type: 'entitlement', id: row.id, tenantId: row.tenant_id }, { productId: u.productId, status: u.status, periodEnd: u.periodEnd, account: row.account_id });
  return entitlementView(row);
}

/**
 * Ends a provider's purchase: every product in it but the ones it still has (a subscription item that was removed), or
 * all of it (a store subscription that another replaced).
 */
export function endPurchase(ctx: AppContext, source: PurchaseSource, externalId: string, keep: string[] = []) {
  const now = new Date().toISOString();
  const rows = ctx.db.all<Row>("SELECT * FROM entitlements WHERE source = ? AND external_id = ? AND status != 'expired'", source, externalId);
  for (const r of rows) if (!keep.includes(r.product_id)) ctx.db.run("UPDATE entitlements SET status = 'expired', updated_at = ? WHERE id = ?", now, r.id);
}

/** The account a provider's purchase was recorded for, if it was. */
export function purchaseOwner(ctx: AppContext, source: PurchaseSource, externalId: string): string | null {
  return ctx.db.get<{ account_id: string | null }>('SELECT account_id FROM entitlements WHERE source = ? AND external_id = ? AND account_id IS NOT NULL', source, externalId)?.account_id ?? null;
}

export function accountEntitlements(ctx: AppContext, accountId: string): Row[] {
  return ctx.db.all<Row>('SELECT * FROM entitlements WHERE account_id = ? ORDER BY created_at', accountId);
}

/** Black Hole is never bought on an account: one there (a grant, say) counts as Ultra. */
const onAccount = (t: Tier): Tier => (t === 'blackhole' ? 'ultra' : t);

/** The edition an account's own purchases give (Essentials with none), and until when. */
export function accountTier(ctx: AppContext, accountId: string): { tier: Tier; until: string | null } {
  const owned = accountEntitlements(ctx, accountId).filter((e) => e.kind === 'edition' && e.tier && !e.tenant_id && isValid(e));
  const tier = owned.reduce<Tier>((t, e) => maxTier(t, onAccount(e.tier!)), 'essentials');
  const best = owned.filter((e) => onAccount(e.tier!) === tier);
  // No end at all (a grant without one) wins; otherwise the latest end.
  const until = best.some((e) => !e.period_end) ? null : best.reduce<string | null>((u, e) => (!u || e.period_end! > u ? e.period_end : u), null);
  return { tier, until };
}

/**
 * An account's computers: how many its edition covers (what it includes, and the extra computers bought on top with
 * Stripe), and which place this sign-in's computer has. A computer's place is when it first signed in, so signing in
 * again keeps it; a computer signed out frees its place.
 */
export function accountComputers(ctx: AppContext, accountId: string, tier: PaidTier, sessionId: string | null): AccountComputers & { place: number | null; installId: string | null } {
  const now = new Date().toISOString();
  const sessions = ctx.db.all<{ id: string; install_id: string | null; created_at: string; revoked_at: string | null; expires_at: string }>(
    "SELECT id, install_id, created_at, revoked_at, expires_at FROM account_sessions WHERE account_id = ? AND kind = 'computer'",
    accountId,
  );
  const computer = (x: { id: string; install_id: string | null }) => x.install_id ?? x.id;
  const first = new Map<string, string>();
  for (const x of sessions) if (!first.has(computer(x)) || x.created_at < first.get(computer(x))!) first.set(computer(x), x.created_at);
  const here = [...new Set(sessions.filter((x) => !x.revoked_at && x.expires_at > now).map(computer))].sort((a, b) => first.get(a)!.localeCompare(first.get(b)!) || a.localeCompare(b));
  const book = priceBook(ctx.db);
  const bought = accountEntitlements(ctx, accountId).filter((e) => e.kind === 'extra' && e.tier === tier && !e.tenant_id && isValid(e));
  const extra = bought.reduce((n, e) => n + e.quantity, 0);
  const included = book.computers.included[tier];
  const mine = sessions.find((x) => x.id === sessionId);
  const canAdd = accountEntitlements(ctx, accountId).some((e) => e.kind === 'edition' && e.source === 'stripe' && !e.tenant_id && e.tier === tier && isValid(e));
  return {
    used: here.length,
    allowed: included + extra,
    included,
    extra,
    extraPrice: book.computers.extra[tier],
    canAdd,
    place: mine ? here.indexOf(computer(mine)) : null,
    installId: mine?.install_id ?? null,
  };
}

/**
 * The license key an account signs one of its computers up to: Standard or Ultra (no FBRX Command tenant in it, so it
 * works on a computer on its own), for that computer's install only, while it is one of the computers the edition
 * covers. It runs a few days past the period paid for, and never more than LICENSE_MAX_DAYS, so computers fetch a fresh
 * one as they renew.
 */
export function accountLicense(ctx: AppContext, account: { id: string; email: string; name: string }, sessionId: string | null = null): AccountLicense {
  const { tier, until } = accountTier(ctx, account.id);
  if (tier === 'essentials') return { key: null, tier, expiresAt: null, computers: null, note: null };
  const { place, installId, ...computers } = accountComputers(ctx, account.id, tier as PaidTier, sessionId);
  if (place === null) return { key: null, tier, expiresAt: null, computers, note: 'A license goes to a computer: sign in to your FBRX account in FBRX on it.' };
  if (place >= computers.allowed) {
    const how = computers.canAdd ? `Sign one of the others out, or add a computer for ${formatPrice(computers.extraPrice)} a month.` : 'Sign one of the others out to use it here.';
    return { key: null, tier, expiresAt: null, computers, note: `Your ${TIER_SHORT[tier]} covers ${computers.allowed} ${computers.allowed === 1 ? 'computer' : 'computers'}, and ${computers.used} are signed in: this one runs Essentials. ${how}` };
  }
  const cap = Date.now() + LICENSE_MAX_DAYS * 86_400_000;
  const end = until ? Math.min(Date.parse(until) + LICENSE_SLACK_DAYS * 86_400_000, cap) : cap;
  const expiresAt = new Date(end).toISOString();
  const key = signLicense(
    {
      v: 1,
      lid: `lic_${account.id}`,
      tenantId: 'personal',
      customer: account.name || account.email,
      edition: licenseEditionFor(tier),
      seats: 0,
      features: [],
      issuedAt: new Date().toISOString(),
      expiresAt,
      maxMajorVersion: null,
      tier,
      ...(installId ? { installId } : {}),
    },
    ctx.keys.licensePrivatePem,
  );
  return { key, tier, expiresAt, computers, note: null };
}

/**
 * An organization's FBRX Command plan: the organization fee it pays, if it has one. A fee still running comes before
 * one that ended (moving to another fee or interval ends the old one), and the fee it is charged before those at none.
 */
export function planEntitlement(db: Db, tenantId: string) {
  return db.get<{ external_id: string; source: PurchaseSource; status: EntitlementStatus; period_end: string | null; product_id: string }>(
    `SELECT external_id, source, status, period_end, product_id FROM entitlements WHERE tenant_id = ? AND kind = 'command'
     ORDER BY status IN ('pending', 'expired'), quantity = 0, updated_at DESC LIMIT 1`,
    tenantId,
  );
}

/** Whether an organization's FBRX Command plan counts right now. */
export function cloudPlanActive(db: Db, tenantId: string): boolean {
  const e = planEntitlement(db, tenantId);
  return !!e && isValid(e);
}

/** Whether a provider's notification was handled already (they retry, and may send the same one twice). */
export function handledBefore(ctx: AppContext, source: string, eventId: string): boolean {
  return !!ctx.db.get('SELECT id FROM billing_events WHERE id = ?', `${source}:${eventId}`);
}

/** Notes a notification as handled, once it was (one that failed comes again and is handled then). */
export function markHandled(ctx: AppContext, source: string, eventId: string, type: string) {
  ctx.db.run('INSERT OR IGNORE INTO billing_events (id, source, type, received_at) VALUES (?,?,?,?)', `${source}:${eventId}`, source, type, new Date().toISOString());
}
