import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { CURRENCY, productById, type EntitlementStatus } from '@fbrx/shared';
import type { CloudConfig } from '../config';
import { HttpError, PaymentProviderError } from '../errors';

/**
 * Stripe, over its HTTPS API (form-encoded requests, JSON answers): Checkout for buying (cards, and the Apple Pay and
 * Google Pay wallets, which Checkout offers by itself once they are on in the Stripe Dashboard), the customer portal
 * for changing or ending a plan, and webhooks for what happened. Prices are found by their lookup key, which is the
 * product id in plans.ts, so the price list in Stripe and in FBRX stay one list. A price's lookup key moves to a new
 * price when the price changes: `onPrice` hears of every price found under a key, so one a subscription still pays
 * stays known after its key moved on.
 */
type StripeConfig = NonNullable<CloudConfig['stripe']>;

export class StripeError extends PaymentProviderError {}

/** a[b][0][c]=… form encoding, as Stripe takes it. */
export function formEncode(obj: Record<string, unknown>, prefix = ''): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => parts.push(typeof item === 'object' ? formEncode(item as Record<string, unknown>, `${key}[${i}]`) : `${encodeURIComponent(`${key}[]`)}=${encodeURIComponent(String(item))}`));
    else if (typeof v === 'object') parts.push(formEncode(v as Record<string, unknown>, key));
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return parts.filter(Boolean).join('&');
}

/** A coupon FBRX Command made for an organization's volume discount (`fbrx_volume_<percent>_<products>`). */
export const VOLUME_COUPON_PREFIX = 'fbrx_volume_';

export class Stripe {
  private prices = new Map<string, { id: string; product: string; at: number }>();
  /** Hears of each price found under a lookup key (FBRX Command remembers them). */
  onPrice: ((priceId: string, productId: string) => void) | null = null;

  constructor(private readonly cfg: StripeConfig) {}

  private async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, unknown> = {}): Promise<T> {
    const body = formEncode(params);
    const url = `${this.cfg.apiBase}${path}${method === 'GET' && body ? `?${body}` : ''}`;
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${this.cfg.secretKey}`, ...(method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
      body: method === 'POST' ? body : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!res.ok) throw new StripeError(`Stripe: ${json.error?.message ?? `HTTP ${res.status}`}`);
    return json as T;
  }

  /** The active price for a product id (its lookup key) and its Stripe product, cached for ten minutes. */
  async price(productId: string): Promise<{ id: string; product: string }> {
    const hit = this.prices.get(productId);
    if (hit && Date.now() - hit.at < 600_000) return hit;
    const p = await this.priceInfo(productId);
    if (!p) throw new StripeError(`Stripe has no active price with the lookup key ${productId}`);
    const found = { id: p.id, product: p.product, at: Date.now() };
    this.prices.set(productId, found);
    return found;
  }

  /** The active price's id for a product id. */
  async priceFor(productId: string): Promise<string> {
    return (await this.price(productId)).id;
  }

  /** The active price under a lookup key, with what it charges (null when Stripe has none): for the Pricing page. */
  async priceInfo(productId: string): Promise<{ id: string; product: string; unitAmount: number | null; interval: string | null } | null> {
    const r = await this.request<{ data: Array<{ id: string; product: string; unit_amount?: number | null; recurring?: { interval?: string } | null }> }>('GET', '/v1/prices', { lookup_keys: [productId], active: true });
    const p = r.data[0];
    if (!p) return null;
    this.onPrice?.(p.id, productId);
    return { id: p.id, product: p.product, unitAmount: p.unit_amount ?? null, interval: p.recurring?.interval ?? null };
  }

  /**
   * A new monthly price under a lookup key, taking the key from the price that had it (Stripe prices never change). It
   * goes on `product`, or on a new product named `name`.
   */
  async createPrice(p: { productId: string; unitAmount: number; product: string | null; name: string }): Promise<{ id: string; product: string }> {
    const product = p.product ?? (await this.request<{ id: string }>('POST', '/v1/products', { name: p.name, metadata: { fbrx_product: p.productId } })).id;
    const price = await this.request<{ id: string; product: string }>('POST', '/v1/prices', {
      product,
      currency: CURRENCY,
      unit_amount: p.unitAmount,
      recurring: { interval: 'month' },
      lookup_key: p.productId,
      transfer_lookup_key: true,
      metadata: { fbrx_product: p.productId },
    });
    this.prices.delete(p.productId);
    this.onPrice?.(price.id, p.productId);
    return price;
  }

  createCustomer(p: { email: string; name: string; metadata: Record<string, string> }) {
    return this.request<{ id: string }>('POST', '/v1/customers', p);
  }

  /** A hosted Checkout page for a subscription. */
  async checkout(p: { customer: string; items: Array<{ productId: string; quantity: number }>; successUrl: string; cancelUrl: string; reference: string; metadata: Record<string, string> }) {
    const lineItems = await Promise.all(p.items.map(async (i) => ({ price: await this.priceFor(i.productId), quantity: i.quantity })));
    return this.request<{ id: string; url: string }>('POST', '/v1/checkout/sessions', {
      mode: 'subscription',
      customer: p.customer,
      line_items: lineItems,
      success_url: p.successUrl,
      cancel_url: p.cancelUrl,
      client_reference_id: p.reference,
      allow_promotion_codes: true,
      metadata: p.metadata,
      subscription_data: { metadata: p.metadata },
    });
  }

  /** The customer portal: change the plan or the card, see invoices, cancel. */
  portal(p: { customer: string; returnUrl: string }) {
    return this.request<{ url: string }>('POST', '/v1/billing_portal/sessions', { customer: p.customer, return_url: p.returnUrl });
  }

  cancel(subscriptionId: string) {
    return this.request('DELETE', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
  }

  subscription(id: string) {
    return this.request<StripeSubscription>('GET', `/v1/subscriptions/${encodeURIComponent(id)}`, { expand: ['discounts'] });
  }

  /** Sets how many computers a tenant subscription item counts (FBRX Command, per edition). */
  updateItemQuantity(itemId: string, quantity: number) {
    return this.request('POST', `/v1/subscription_items/${encodeURIComponent(itemId)}`, { quantity, proration_behavior: 'create_prorations' });
  }

  /** Moves a subscription item to another price (an organization's item, when its price changed). */
  updateItemPrice(itemId: string, price: string, quantity: number) {
    return this.request('POST', `/v1/subscription_items/${encodeURIComponent(itemId)}`, { price, quantity, proration_behavior: 'create_prorations' });
  }

  /**
   * The coupon for a volume discount of `percentOff` on these Stripe products (the computers' prices), made the first
   * time it is needed. Its id says both, so a coupon is never reused for other products.
   */
  async volumeCoupon(percentOff: number, products: string[]): Promise<string> {
    const sorted = [...new Set(products)].sort();
    const id = `${VOLUME_COUPON_PREFIX}${percentOff}_${createHash('sha256').update(sorted.join(',')).digest('hex').slice(0, 8)}`;
    try {
      await this.request('POST', '/v1/coupons', { id, percent_off: percentOff, duration: 'forever', name: `Volume discount, ${percentOff}% off`, applies_to: { products: sorted } });
    } catch (err) {
      if (!/already exists/i.test((err as Error).message)) throw err;
    }
    return id;
  }

  /** Sets a subscription's discounts (coupons, and discounts it already has, by id); none: no discount. */
  setDiscounts(subscriptionId: string, discounts: Array<{ coupon: string } | { discount: string }>) {
    return this.request('POST', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`, { discounts: discounts.length ? discounts : '', proration_behavior: 'create_prorations' });
  }

  /** Adds an edition's per-computer item to a tenant subscription. */
  async addItem(subscription: string, productId: string, quantity: number) {
    const price = await this.priceFor(productId);
    return this.request<{ id: string }>('POST', '/v1/subscription_items', { subscription, price, quantity, proration_behavior: 'create_prorations' });
  }

  /**
   * Checks a webhook's Stripe-Signature header (t=…,v1=…): an HMAC-SHA256 of "t.body" with the endpoint's signing
   * secret, no older than five minutes. Returns the parsed event.
   */
  verifyWebhook(rawBody: string, header: string | undefined, now = Date.now()): StripeEvent {
    if (!header) throw new StripeError('No Stripe-Signature header');
    const parts = header.split(',').map((p) => p.split('=') as [string, string]);
    const t = Number(parts.find(([k]) => k === 't')?.[1]);
    const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
    if (!t || !signatures.length) throw new StripeError('Malformed Stripe-Signature header');
    if (Math.abs(now / 1000 - t) > 300) throw new StripeError('Stripe webhook timestamp is too old');
    const expected = createHmac('sha256', this.cfg.webhookSecret).update(`${t}.${rawBody}`).digest();
    const ok = signatures.some((s) => {
      const got = Buffer.from(s, 'hex');
      return got.length === expected.length && timingSafeEqual(got, expected);
    });
    if (!ok) throw new StripeError('Stripe webhook signature does not match');
    return JSON.parse(rawBody) as StripeEvent;
  }
}

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, any> };
}

export interface StripeSubscription {
  id: string;
  customer: string;
  status: string;
  current_period_end?: number;
  cancel_at_period_end?: boolean;
  metadata?: Record<string, string>;
  items: { data: Array<{ id: string; quantity?: number; current_period_end?: number; price: { id: string; lookup_key?: string | null } }> };
  /** With `expand[]=discounts`: its discounts (newer API versions name the coupon under `source`). */
  discounts?: Array<string | StripeDiscount>;
}

export interface StripeDiscount {
  id: string;
  coupon?: { id: string } | null;
  source?: { coupon?: string | { id: string } | null } | null;
}

/** The coupon a discount applies (null when the subscription was not read with its discounts expanded). */
export function discountCoupon(d: string | StripeDiscount): string | null {
  if (typeof d === 'string') return null;
  const c = d.coupon?.id ?? d.source?.coupon;
  return typeof c === 'string' ? c : (c?.id ?? null);
}

/** A Stripe subscription's state, as FBRX counts it. */
export function stripeStatus(status: string): EntitlementStatus {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
      return 'grace';
    case 'incomplete':
      return 'pending';
    default:
      // canceled, unpaid, incomplete_expired, paused
      return 'expired';
  }
}

/** The FBRX product a subscription item pays for: its price's lookup key, or the key its price had (`known`). */
export function itemProduct(i: StripeSubscription['items']['data'][number], known: (priceId: string) => string | null = () => null): string | null {
  const id = i.price.lookup_key || known(i.price.id);
  return id && productById(id) ? id : null;
}

/**
 * Each FBRX product in a subscription: how many, and until when (newer API versions keep the period on the item). A
 * price whose lookup key moved to a newer price counts as the product it was sold as (`known`).
 */
export function subscriptionItems(sub: StripeSubscription, known?: (priceId: string) => string | null): Array<{ itemId: string; productId: string; quantity: number; periodEnd: string | null }> {
  return sub.items.data.flatMap((i) => {
    const productId = itemProduct(i, known);
    if (!productId) return [];
    const end = i.current_period_end ?? sub.current_period_end;
    return [{ itemId: i.id, productId, quantity: i.quantity ?? 1, periodEnd: end ? new Date(end * 1000).toISOString() : null }];
  });
}

const instances = new WeakMap<object, Stripe>();

/** The one Stripe client for this FBRX Command (null until Stripe is set up). */
export function stripeOf(cloud: CloudConfig): Stripe | null {
  if (!cloud.stripe) return null;
  let s = instances.get(cloud.stripe);
  if (!s) instances.set(cloud.stripe, (s = new Stripe(cloud.stripe)));
  return s;
}

/** The Stripe client, for something only Stripe does. */
export function requireStripe(cloud: CloudConfig): Stripe {
  const s = stripeOf(cloud);
  if (!s) throw new HttpError(503, 'Card payments are not set up on this FBRX Command', 'UNAVAILABLE');
  return s;
}
