import { licenseEditionFor, maxTier, productById, type AccountLicense, type EntitlementStatus, type EntitlementView, type PurchaseSource, type Tier } from '@fbrx/shared';
import { signLicense, type Db } from '@fbrx/shared/node';
import type { AppContext } from '../context';
import { ids } from '../context';

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
  const tier = product.kind === 'edition' ? product.tier : null;
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
 * The license key an account signs its computers up to: Standard or Ultra (no FBRX Command tenant in it, so it works on
 * a computer on its own). It runs a few days past the period paid for, and never more than LICENSE_MAX_DAYS, so
 * computers fetch a fresh one as they renew.
 */
export function accountLicense(ctx: AppContext, account: { id: string; email: string; name: string }): AccountLicense {
  const { tier, until } = accountTier(ctx, account.id);
  if (tier === 'essentials') return { key: null, tier, expiresAt: null };
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
    },
    ctx.keys.licensePrivatePem,
  );
  return { key, tier, expiresAt };
}

/** An organization's FBRX Command plan: its latest purchase, if it has one. */
export function planEntitlement(db: Db, tenantId: string) {
  return db.get<{ external_id: string; source: PurchaseSource; status: EntitlementStatus; period_end: string | null }>(
    "SELECT external_id, source, status, period_end FROM entitlements WHERE tenant_id = ? AND kind = 'command' ORDER BY updated_at DESC LIMIT 1",
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
