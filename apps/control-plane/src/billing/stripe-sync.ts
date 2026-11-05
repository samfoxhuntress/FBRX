import { EXTRA_COMPUTER_PRODUCTS, productById, productFor, productInterval, type PaidTier } from '@fbrx/shared';
import type { AppContext } from '../context';
import { endPurchase, recordPurchase } from './entitlements';
import { knownStripePrice, rememberStripePrice } from './pricing';
import { itemProduct, stripeStatus, subscriptionItems, type Stripe, type StripeSubscription } from './stripe';
import { scheduleSeatSync, syncTenantLicense } from './tenant-billing';

/**
 * What a Stripe subscription says, brought into FBRX: the entitlements it gives (an account's, or an organization's),
 * and what follows from them. Stripe's webhook calls it, and so does FBRX Command after it changes a subscription.
 */

/**
 * A person's extra computers follow their plan: when it moves to another edition (in the Stripe portal), they move to
 * that edition's price at the plan's interval, as many as before. Answers with the subscription as it is now.
 */
async function extraComputersFollow(ctx: AppContext, stripe: Stripe, sub: StripeSubscription): Promise<StripeSubscription> {
  const productOf = (i: StripeSubscription['items']['data'][number]) => itemProduct(i, (id) => knownStripePrice(ctx.db, id)) ?? '';
  const plan = sub.items.data.map(productOf).find((id) => productById(id)?.kind === 'edition');
  const edition = plan ? productById(plan) : null;
  if (!plan || edition?.kind !== 'edition') return sub;
  const want = productFor(EXTRA_COMPUTER_PRODUCTS[edition.tier as PaidTier], productInterval(plan));
  const right = sub.items.data.find((i) => productOf(i) === want);
  const stale = sub.items.data.filter((i) => productById(productOf(i))?.kind === 'extra' && productOf(i) !== want && (i.quantity ?? 0) > 0);
  if (!stale.length) return sub;
  const count = stale.reduce((n, i) => n + (i.quantity ?? 0), right?.quantity ?? 0);
  if (right) await stripe.updateItemQuantity(right.id, count);
  for (const [n, i] of stale.entries()) {
    if (!right && n === 0) await stripe.updateItemPrice(i.id, await stripe.priceFor(want), count);
    else await stripe.updateItemQuantity(i.id, 0);
  }
  return stripe.subscription(sub.id);
}

/** Brings one Stripe subscription's items into the entitlements (an account's, or an organization's). */
export async function syncStripeSubscription(ctx: AppContext, stripe: Stripe | null, sub: StripeSubscription): Promise<void> {
  const meta = sub.metadata ?? {};
  const accountId = meta.fbrx_account ?? ctx.db.get<{ id: string }>('SELECT id FROM accounts WHERE stripe_customer_id = ?', sub.customer)?.id ?? null;
  const tenantId = meta.fbrx_tenant ?? ctx.db.get<{ id: string }>('SELECT id FROM tenants WHERE stripe_customer_id = ?', sub.customer)?.id ?? null;
  const status = stripeStatus(sub.status);
  // A price sold under one of FBRX's lookup keys stays that product after the key moves to a newer price.
  for (const i of sub.items.data) if (i.price.lookup_key && productById(i.price.lookup_key)) rememberStripePrice(ctx.db, i.price.id, i.price.lookup_key);
  if (!tenantId && stripe && status === 'active') sub = await extraComputersFollow(ctx, stripe, sub);
  const items = subscriptionItems(sub, (priceId) => knownStripePrice(ctx.db, priceId));
  for (const i of items) recordPurchase(ctx, { source: 'stripe', externalId: sub.id, productId: i.productId, status, periodEnd: i.periodEnd, quantity: i.quantity, accountId: tenantId ? null : accountId, tenantId });
  endPurchase(ctx, 'stripe', sub.id, items.map((i) => i.productId));
  // An organization's plan: its license follows, and (once it starts) its computers are counted in.
  if (tenantId) {
    syncTenantLicense(ctx, tenantId);
    scheduleSeatSync(ctx, stripe, tenantId, 0);
  }
}
