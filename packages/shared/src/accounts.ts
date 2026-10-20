import type { Tier } from './license';
import type { ProductInfo } from './plans';

/**
 * FBRX accounts: one per person, held by FBRX Command in the cloud. An account keeps what its person bought (Standard
 * or Ultra, through Stripe on the website and the computer, or the App Store / Google Play on the phone), and signs any
 * computer or phone they sign in on up to that edition. In an organization, FBRX Command hands out the editions.
 */

/** Where a purchase came from. `grant`: given by FBRX (support, a promotion). */
export const PURCHASE_SOURCES = ['stripe', 'apple', 'google', 'grant'] as const;
export type PurchaseSource = (typeof PURCHASE_SOURCES)[number];
/** Where a purchase was made, as the account pages say it ("Ultra · in the App Store"). */
export const PURCHASE_SOURCE_NAMES: Record<PurchaseSource, string> = { stripe: 'on the website or a computer', apple: 'in the App Store', google: 'on Google Play', grant: 'from FBRX' };

/**
 * A purchase's state. `active` and `grace` (a payment failed; the store is still trying) count; so does `canceled`
 * until the period it paid for ends. `pending`: not paid yet. `expired`: over, refunded or revoked.
 */
export type EntitlementStatus = 'pending' | 'active' | 'grace' | 'canceled' | 'expired';

export interface EntitlementView {
  id: string;
  productId: string;
  kind: ProductInfo['kind'];
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
  /** The email was confirmed (the link FBRX sent to it was opened). */
  emailVerified: boolean;
  name: string;
  /** The edition the account's own purchases give its computers and phones (Essentials when nothing is bought). */
  tier: Tier;
  entitlements: EntitlementView[];
  /** Can open the billing portal (has bought through Stripe). */
  billingPortal: boolean;
  /** The UUID the iPhone and iPad app gives the App Store with each purchase, so the purchase finds this account. */
  appAccountToken: string;
  /** The organizations (FBRX Command tenants) the account belongs to, and the edition each gives it. */
  memberships: AccountMembership[];
  createdAt: string;
}

export interface AccountMembership {
  tenantId: string;
  tenantName: string;
  tier: Tier;
}

/** A member of an organization, as its FBRX Command shows them. */
export interface MemberView {
  accountId: string;
  email: string;
  name: string;
  tier: Tier;
  devices: number;
  createdAt: string;
}

/** What an account signs a computer up to: a license key (null with nothing bought), until it is renewed. */
export interface AccountLicense {
  key: string | null;
  tier: Tier;
  expiresAt: string | null;
}

/** Where an FBRX account is signed in: FBRX on a computer, the phone app, or the website. */
export const ACCOUNT_DEVICE_KINDS = ['computer', 'phone', 'website'] as const;
export type AccountDeviceKind = (typeof ACCOUNT_DEVICE_KINDS)[number];

/** What a sign-in says about where it happens. `installId` is the install's own id: signing in again replaces it. */
export interface AccountDeviceInfo {
  name: string;
  kind: AccountDeviceKind;
  platform?: string;
  appVersion?: string;
  installId?: string;
}

/** A computer, phone or browser signed in to the account (GET /v1/accounts/sessions). */
export interface AccountDevice {
  id: string;
  name: string;
  kind: AccountDeviceKind;
  platform: string | null;
  appVersion: string | null;
  signedInAt: string;
  lastSeenAt: string | null;
  /** The one asking. */
  current: boolean;
}

/** An organization's FBRX Command plan in the cloud, as its console shows it (GET /v1/admin/billing). */
export interface TenantPlanView {
  /** `manual`: the operator of this FBRX Command issues its licenses; `cloud`: it pays for its plan. */
  billing: 'manual' | 'cloud';
  active: boolean;
  periodEnd: string | null;
  status: EntitlementStatus | null;
  /** Computers at each edition (what the organization gives them). */
  computers: Record<Tier, number>;
  /** What a month comes to, in cents: the plan and the computers. */
  monthly: number;
  /** Can open the Stripe billing portal. */
  portal: boolean;
}

/** GET /v1/plans: the price list and which ways to pay this FBRX Command offers. */
export interface PlansInfo {
  publicSignup: boolean;
  payments: { stripe: boolean; apple: boolean; google: boolean };
}

/** The FBRX account this computer is signed in to (Settings → Account). */
export interface AccountStatus {
  signedIn: boolean;
  /** The account's email is confirmed (needed to join an organization's members or start one). */
  emailVerified: boolean;
  /** The FBRX Command the account lives on ("" until one is known: then the sign-in asks for its address). */
  server: string;
  email: string | null;
  name: string | null;
  /** The edition the account's own purchases give (Essentials with none). */
  tier: Tier;
  /** Until when the account's license on this computer runs (it is renewed by itself well before). */
  licenseUntil: string | null;
  memberships: AccountMembership[];
  /** Whether the account can buy and manage plans from this computer (the website's way: Stripe). */
  canBuy: boolean;
  billingPortal: boolean;
  lastSyncAt: string | null;
  /** Why the last renewal did not work (the internet, or the sign-in ended). */
  error: string | null;
}

/**
 * A local, offline FBRX account: an identity kept on this computer, for a person who runs FBRX without the cloud (a
 * local-only environment, or the Beta before the account server is live). It is paired with a license key for its
 * edition (a Beta key, or a key from a local FBRX Command). It never leaves the computer and never reaches a server;
 * an optional password locks FBRX on start. The cloud FBRX account (signing in to FBRX Command) is separate and
 * unchanged: a computer uses one or the other.
 */
export interface LocalAccountView {
  name: string;
  /** Optional, only to recognize the person (never emailed or sent anywhere). */
  email: string | null;
  /** FBRX asks for the password when it starts. */
  passwordOnStart: boolean;
  createdAt: string;
}

/** Settings → Account, the offline side (localAccount.status). */
export interface LocalAccountStatus {
  exists: boolean;
  account: LocalAccountView | null;
  /** Locked until the start password is given (only when passwordOnStart and FBRX has just started). */
  locked: boolean;
}
