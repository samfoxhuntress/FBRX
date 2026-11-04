import { COMMAND_FEE_PRODUCTS, LEARNER_TIER, MDM_ADDON, TIERS, VERTICALS, isLearner, licenseEditionFor, organizationBill, type OrganizationBill, type TenantPlanView, type Tier, type Vertical } from '@fbrx/shared';
import type { Db } from '@fbrx/shared/node';
import { signLicense } from '@fbrx/shared/node';
import type { AppContext } from '../context';
import { ids } from '../context';
import { givenEdition } from '../services/device-config';
import { LICENSE_SLACK_DAYS, isValid, planEntitlement } from './entitlements';
import { knownStripePrice, mdmManaged, mdmPricing, priceBook } from './pricing';
import { VOLUME_COUPON_PREFIX, discountCoupon, itemProduct, type Stripe } from './stripe';

/**
 * An organization's FBRX Command in the cloud (`billing = 'cloud'`): its organization fee (by its kind and size) and
 * each of its computers at its edition's price, counted from what the organization gives them, less the volume
 * discount; Essentials is free. The prices are the operator's price list (pricing.ts). With the plan active, FBRX
 * Command holds a license for the organization that allows everything (Black Hole); each computer runs what it is
 * given, Essentials when nobody gave it anything. Without the plan, its computers run Essentials.
 *
 * The MDM add-on, once the operator sells it, adds each computer the organization's groups manage with it, at one price
 * whatever the computer's edition.
 *
 * Organizations FBRX Command's operator set up by hand (`billing = 'manual'`) keep the licenses the operator issues.
 */

/**
 * How many of the organization's active computers run each edition: what each is given, as its configuration gives it
 * (device-config.ts), with learner computers on LEARNER_TIER and Essentials for the rest.
 */
export function computersByTier(db: Db, tenantId: string): Record<Tier, number> {
  const out = Object.fromEntries(TIERS.map((t) => [t, 0])) as Record<Tier, number>;
  const tenant = db.get<{ vertical: string | null }>('SELECT vertical FROM tenants WHERE id = ?', tenantId);
  const rows = db.all<{ tier: string | null; audience: string | null; gtier: string | null; gaudience: string | null }>(
    "SELECT d.tier, d.audience, g.tier AS gtier, g.audience AS gaudience FROM devices d LEFT JOIN groups g ON g.id = d.group_id WHERE d.tenant_id = ? AND d.status = 'active'",
    tenantId,
  );
  for (const r of rows) {
    const { audience, tier } = givenEdition(tenant ?? {}, r, { tier: r.gtier, audience: r.gaudience });
    out[isLearner(audience) ? LEARNER_TIER : (tier ?? 'essentials')] += 1;
  }
  return out;
}

/** The organization's monthly bill at the operator's prices, from its kind and what its computers run. */
export function tenantBill(ctx: AppContext, tenantId: string): { bill: OrganizationBill; computers: Record<Tier, number>; managed: number } {
  const vertical = ctx.db.get<{ vertical: string | null }>('SELECT vertical FROM tenants WHERE id = ?', tenantId)?.vertical ?? null;
  const kind = (VERTICALS as readonly string[]).includes(vertical ?? '') ? (vertical as Vertical) : null;
  const computers = computersByTier(ctx.db, tenantId);
  const managed = mdmManaged(ctx.db, tenantId);
  return { bill: organizationBill(priceBook(ctx.db), { kind, computers, mdm: { managed, pricing: mdmPricing(ctx.db) } }), computers, managed };
}

export function tenantPlanView(ctx: AppContext, tenantId: string): TenantPlanView {
  const t = ctx.db.get<{ billing: string | null; stripe_customer_id: string | null }>('SELECT billing, stripe_customer_id FROM tenants WHERE id = ?', tenantId);
  const e = planEntitlement(ctx.db, tenantId);
  const { bill, computers, managed } = tenantBill(ctx, tenantId);
  return {
    billing: t?.billing === 'cloud' ? 'cloud' : 'manual',
    active: !!e && isValid(e),
    periodEnd: e?.period_end ?? null,
    status: e?.status ?? null,
    computers,
    monthly: bill.total,
    bill,
    portal: !!t?.stripe_customer_id && !!ctx.config.cloud.stripe,
    mdm: { ...mdmPricing(ctx.db), managed },
  };
}

/**
 * Keeps the organization's license in step with its plan: while the plan runs, one license that allows everything
 * (each computer is held to what it is given), lasting a few days past the period paid for; when the plan ends, it is
 * revoked. Computers get it with their configuration.
 */
export function syncTenantLicense(ctx: AppContext, tenantId: string): void {
  const t = ctx.db.get<{ name: string; billing: string | null; vertical: string | null }>('SELECT name, billing, vertical FROM tenants WHERE id = ?', tenantId);
  if (!t || t.billing !== 'cloud') return;
  const now = new Date();
  const current = ctx.db.get<{ id: string; expires_at: string | null }>("SELECT id, expires_at FROM licenses WHERE tenant_id = ? AND created_by = 'billing' AND revoked_at IS NULL ORDER BY issued_at DESC LIMIT 1", tenantId);
  const e = planEntitlement(ctx.db, tenantId);
  if (!e || !isValid(e)) {
    if (current) {
      ctx.db.run('UPDATE licenses SET revoked_at = ? WHERE id = ?', now.toISOString(), current.id);
      ctx.bumpConfig(tenantId);
    }
    return;
  }
  const expiresAt = e.period_end ? new Date(Date.parse(e.period_end) + LICENSE_SLACK_DAYS * 86_400_000).toISOString() : null;
  if (current && current.expires_at === expiresAt) return;
  const id = ids.license();
  const edition = licenseEditionFor('blackhole');
  const key = signLicense(
    { v: 1, lid: id, tenantId, customer: t.name, edition, seats: 0, features: [], issuedAt: now.toISOString(), expiresAt, maxMajorVersion: null, tier: 'blackhole', ...(t.vertical === 'education' || t.vertical === 'home' ? { vertical: t.vertical } : {}) },
    ctx.keys.licensePrivatePem,
  );
  ctx.db.tx(() => {
    if (current) ctx.db.run('UPDATE licenses SET revoked_at = ? WHERE id = ?', now.toISOString(), current.id);
    ctx.db.run(
      'INSERT INTO licenses (id, tenant_id, customer, edition, seats, features, issued_at, expires_at, max_major_version, key_text, created_by, vertical) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      id,
      tenantId,
      t.name,
      edition,
      0,
      '[]',
      now.toISOString(),
      expiresAt,
      null,
      key,
      'billing',
      t.vertical ?? null,
    );
  });
  ctx.bumpConfig(tenantId);
}

/**
 * Brings the organization's Stripe subscription to its bill: the organization fee it pays now (the others at none),
 * each edition's computers, the MDM add-on for the computers its groups manage while it is sold (none when it is not),
 * and the volume discount as a coupon on the computers' prices. An item on an older price of its product moves to the
 * current one. Stripe prorates the changes on the next invoice.
 */
export function syncSeats(ctx: AppContext, stripe: Stripe | null, tenantId: string): Promise<{ changed: string[] }> {
  // One at a time per organization: two at once would both read the subscription, and both add the same item.
  const next = (syncing.get(tenantId) ?? Promise.resolve()).catch(() => undefined).then(() => syncSeatsNow(ctx, stripe, tenantId));
  syncing.set(tenantId, next);
  void next.then(
    () => syncing.get(tenantId) === next && syncing.delete(tenantId),
    () => syncing.get(tenantId) === next && syncing.delete(tenantId),
  );
  return next;
}

const syncing = new Map<string, Promise<unknown>>();

async function syncSeatsNow(ctx: AppContext, stripe: Stripe | null, tenantId: string): Promise<{ changed: string[] }> {
  const t = ctx.db.get<{ billing: string | null }>('SELECT billing FROM tenants WHERE id = ?', tenantId);
  const e = planEntitlement(ctx.db, tenantId);
  if (!stripe || t?.billing !== 'cloud' || !e || e.source !== 'stripe' || !isValid(e)) return { changed: [] };
  const sub = await stripe.subscription(e.external_id);
  const { bill } = tenantBill(ctx, tenantId);
  const fee = COMMAND_FEE_PRODUCTS[bill.fee];
  const wanted: Array<[string, number]> = [
    // The fee it pays first: should adding it fail, the one it paid stays.
    [fee, 1],
    ...Object.values(COMMAND_FEE_PRODUCTS)
      .filter((id) => id !== fee)
      .map((id): [string, number] => [id, 0]),
    ...bill.lines.filter((l) => l.item !== 'fee' && l.item !== 'mdm').map((l): [string, number] => [l.productId, l.quantity]),
    [MDM_ADDON.productId, bill.lines.find((l) => l.item === 'mdm')?.quantity ?? 0],
  ];
  const known = (priceId: string) => knownStripePrice(ctx.db, priceId);
  const changed: string[] = [];
  for (const [productId, want] of wanted) {
    const item = sub.items.data.find((i) => itemProduct(i, known) === productId);
    if (item) {
      const current = want > 0 ? await stripe.priceFor(productId) : item.price.id;
      if (item.price.id !== current) await stripe.updateItemPrice(item.id, current, want);
      else if ((item.quantity ?? 0) !== want) await stripe.updateItemQuantity(item.id, want);
      else continue;
      changed.push(`${productId}=${want}`);
    } else if (want > 0) {
      await stripe.addItem(sub.id, productId, want);
      changed.push(`${productId}=${want}`);
    }
  }
  // The volume discount: FBRX's coupon for it on the computers' prices, beside any other discount (a promotion code).
  const discounts = (sub.discounts ?? []).map((d) => (typeof d === 'string' ? { id: d } : d));
  const ours = discounts.filter((d) => discountCoupon(d)?.startsWith(VOLUME_COUPON_PREFIX));
  const seats = bill.lines.filter((l) => l.item !== 'fee' && l.item !== 'mdm' && l.quantity > 0);
  const coupon = bill.percentOff ? await stripe.volumeCoupon(bill.percentOff, await Promise.all(seats.map(async (l) => (await stripe.price(l.productId)).product))) : null;
  if (ours.length !== (coupon ? 1 : 0) || (coupon && discountCoupon(ours[0]!) !== coupon)) {
    const others = discounts.filter((d) => !ours.includes(d)).map((d) => ({ discount: d.id }));
    await stripe.setDiscounts(sub.id, [...(coupon ? [{ coupon }] : []), ...others]);
    changed.push(`volume=${bill.percentOff}%`);
  }
  return { changed };
}

const pending = new Map<string, ReturnType<typeof setTimeout>>();

/** After the organization's computers change: the seat count follows a moment later (several changes, one update). */
export function scheduleSeatSync(ctx: AppContext, stripe: Stripe | null, tenantId: string, delayMs = 3000) {
  if (!stripe) return;
  const t = ctx.db.get<{ billing: string | null }>('SELECT billing FROM tenants WHERE id = ?', tenantId);
  if (t?.billing !== 'cloud') return;
  clearTimeout(pending.get(tenantId));
  const timer = setTimeout(() => {
    pending.delete(tenantId);
    syncSeats(ctx, stripe, tenantId).catch((err) => ctx.log.warn({ err, tenantId }, 'Could not update the plan with the computers'));
  }, delayMs);
  timer.unref?.();
  pending.set(tenantId, timer);
}

