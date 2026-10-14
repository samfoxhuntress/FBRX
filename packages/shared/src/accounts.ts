import type { Tier } from './license';

/**
 * FBRX accounts: one per person, held by FBRX Command in the cloud. An account keeps what its person bought (Standard or
 * Ultra, through Stripe on the website and the computer, or the App Store / Google Play on the phone), and signs any
 * computer or phone they sign in on up to that edition. In an organization, FBRX Command hands out the editions.
 */

/** Where a purchase came from. `grant`: given by FBRX (support, a promotion). */
export const PURCHASE_SOURCES = ['stripe', 'apple', 'google', 'grant'] as const;
export type PurchaseSource = (typeof PURCHASE_SOURCES)[number];

/**
 * A purchase's state. `active` and `grace` (a payment failed; the store is still trying) count; so does `canceled` until
 * the period it paid for ends. `pending`: not paid yet. `expired`: over, refunded or revoked.
 */
export type EntitlementStatus = 'pending' | 'active' | 'grace' | 'canceled' | 'expired';

export interface EntitlementView {
  id: string;
  productId: string;
  kind: 'edition' | 'command' | 'server';
  tier: Tier | null;
  source: PurchaseSource;
  status: EntitlementStatus;
  quantity: number;
  /** The end of the period paid for (null: no end, such as a grant without one or a one-time purchase). */
  periodEnd: string | null;
  /** Counts now. */
  valid: boolean;
}

export interface AccountView {
  id: string;
  email: string;
  name: string;
  /** The edition the account's own purchases give its computers and phones (Essentials when nothing is bought). */
  tier: Tier;
  entitlements: EntitlementView[];
  /** Can open the billing portal (has bought through Stripe). */
  billingPortal: boolean;
  createdAt: string;
}

/** What an account signs a computer up to: a license key (null with nothing bought), until it is renewed. */
export interface AccountLicense {
  key: string | null;
  tier: Tier;
  expiresAt: string | null;
}

/** GET /v1/plans: the price list and which ways to pay this FBRX Command offers. */
export interface PlansInfo {
  publicSignup: boolean;
  payments: { stripe: boolean; apple: boolean; google: boolean };
}
