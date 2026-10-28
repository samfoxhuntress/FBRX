import { createHmac, timingSafeEqual } from 'node:crypto';
import { productById, type EntitlementStatus } from '@fbrx/shared';
import type { CloudConfig } from '../config';
import { HttpError, PaymentProviderError } from '../errors';

/**
 * Stripe, over its HTTPS API (form-encoded requests, JSON answers): Checkout for buying (cards, and the Apple Pay and
 * Google Pay wallets, which Checkout offers by itself once they are on in the Stripe Dashboard), the customer portal
 * for changing or ending a plan, and webhooks for what happened. Prices are found by their lookup key, which is the
 * product id in plans.ts, so the price list in Stripe and in FBRX stay one list.
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

export class Stripe {
  private prices = new Map<string, { id: string; at: number }>();

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

  /** The active price for a product id (its lookup key), cached for ten minutes. */
  async priceFor(productId: string): Promise<string> {
    const hit = this.prices.get(productId);
    if (hit && Date.now() - hit.at < 600_000) return hit.id;
    const r = await this.request<{ data: Array<{ id: string }> }>('GET', '/v1/prices', { lookup_keys: [productId], active: true });
    const id = r.data[0]?.id;
    if (!id) throw new StripeError(`Stripe has no active price with the lookup key ${productId}`);
    this.prices.set(productId, { id, at: Date.now() });
    return id;
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
    return this.request<StripeSubscription>('GET', `/v1/subscriptions/${encodeURIComponent(id)}`);
  }

  /** Sets how many computers a tenant subscription item counts (FBRX Command, per edition). */
  updateItemQuantity(itemId: string, quantity: number) {
    return this.request('POST', `/v1/subscription_items/${encodeURIComponent(itemId)}`, { quantity, proration_behavior: 'create_prorations' });
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

/** Each FBRX product in a subscription: how many, and until when (newer API versions keep the period on the item). */
export function subscriptionItems(sub: StripeSubscription): Array<{ itemId: string; productId: string; quantity: number; periodEnd: string | null }> {
  return sub.items.data
    .filter((i) => i.price.lookup_key && productById(i.price.lookup_key))
    .map((i) => {
      const end = i.current_period_end ?? sub.current_period_end;
      return { itemId: i.id, productId: i.price.lookup_key!, quantity: i.quantity ?? 1, periodEnd: end ? new Date(end * 1000).toISOString() : null };
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
