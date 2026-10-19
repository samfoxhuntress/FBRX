import { TIERS, TIER_SHORT, type Tier } from './license';

/**
 * FBRX's prices: one list for the app, FBRX Command, the website and the billing service. US dollars, amounts in cents,
 * per month unless said otherwise. Stripe and the App Store / Google Play carry the same prices under the product ids
 * here (Stripe: the price's lookup key; the stores: the subscription's product id).
 *
 * - Essentials is free, and joins an FBRX Command tenant for free.
 * - Standard and Ultra are sold to anyone for their own computers (an FBRX account), and through a tenant with the
 *   tenant's discount.
 * - Black Hole is only an add-on in a tenant, per endpoint, at its full price.
 * - An FBRX Command tenant is a monthly plan of its own.
 * - FBRX Server is announced, not sold yet: a one-time purchase of the installer ISO, kept on the account for good.
 */
export const CURRENCY = 'usd';

/**
 * Standard, free, for this many days: once per computer on its own, no card needed (Settings → Edition). A computer
 * that ran FBRX before 2.0 starts it by itself when it updates; then it is Essentials unless Standard (or Ultra) is
 * bought.
 */
export const STANDARD_TRIAL_DAYS = 7;

/** Off Standard and Ultra bought through an FBRX Command tenant (Black Hole is always full price). */
export const TENANT_DISCOUNT = 0.2;

const tenantPrice = (cents: number) => Math.round(cents * (1 - TENANT_DISCOUNT));

export interface EditionPlan {
  tier: Tier;
  /** Per month on its own, for a person's own computers; null when it is not sold on its own. */
  monthly: number | null;
  /** Per endpoint per month in an FBRX Command tenant (0 = free). */
  tenantMonthly: number;
  /** Free, sold to anyone, or only as an add-on in a tenant. */
  sold: 'free' | 'personal' | 'tenant';
  /** Stripe lookup key and store product id for the monthly subscription (null for the free edition). */
  productId: string | null;
  /** The same in a tenant (its own price, with the discount where there is one). */
  tenantProductId: string | null;
  /** One line: what the edition is for. */
  summary: string;
  /** What it adds to the edition before it (editionPoints puts the two together). */
  highlights: string[];
}

export const EDITION_PLANS: Record<Tier, EditionPlan> = {
  essentials: {
    tier: 'essentials',
    monthly: 0,
    tenantMonthly: 0,
    sold: 'free',
    productId: null,
    tenantProductId: null,
    summary: 'Your own AI on your computer, free.',
    highlights: ['The chat, its memory and voice', 'AI models on your computer, working Quick, Everyday or Thorough', 'Joins your organization for free'],
  },
  basic: {
    tier: 'basic',
    monthly: 499,
    tenantMonthly: tenantPrice(499),
    sold: 'personal',
    productId: 'fbrx_standard_monthly',
    tenantProductId: 'fbrx_standard_tenant_monthly',
    summary: 'The everyday tools, and control over your AI.',
    highlights: ['Your AI’s controls: steps, answer length, how much it keeps in mind', 'FBRX Glass, alerts, notes, tasks, calendar and messages', 'Storage, FBRX Shield, updates, network and backups', 'Files, the clipboard history, the toolbox and how-tos'],
  },
  ultra: {
    tier: 'ultra',
    monthly: 1199,
    tenantMonthly: tenantPrice(1199),
    sold: 'personal',
    productId: 'fbrx_ultra_monthly',
    tenantProductId: 'fbrx_ultra_tenant_monthly',
    summary: 'Expert tools, your devices together, and every look.',
    highlights: ['Terminal, Task Manager, the virtual lab and IT tools', 'Mesh with your computers and phone, AI coordination', 'Connections, plugins and the theme studio'],
  },
  blackhole: {
    tier: 'blackhole',
    monthly: null,
    tenantMonthly: 2499,
    sold: 'tenant',
    productId: null,
    tenantProductId: 'fbrx_blackhole_tenant_monthly',
    summary: 'Everything, for the people who run your FBRX Command and FBRX Servers.',
    highlights: ['The whole Library, FBRX commands included', 'Network environments in Network Center', 'The FBRX Server page'],
  },
};

/** An FBRX Command tenant: the organization's own FBRX Command, per month. */
export const COMMAND_PLAN = {
  monthly: 5499,
  productId: 'fbrx_command_tenant_monthly',
  summary: 'Your organization’s FBRX Command: computers, people, licenses and billing in one place.',
  highlights: [
    'Add and look after your organization’s computers',
    `Standard and Ultra at ${Math.round(TENANT_DISCOUNT * 100)}% off for every computer`,
    'Essentials computers join for free',
    'Black Hole for your admins and server people',
  ],
};

/** FBRX Server: announced, not for sale yet. */
export const SERVER_OFFER = {
  available: false,
  /** One-time, in cents: the installer ISO stays on the account (or the tenant) for good. */
  price: 10000,
  productId: 'fbrx_server_iso',
  summary: 'FBRX Server: your own server for virtual machines, backups, AI and your network. Coming soon.',
  highlights: ['Virtual machines, image backups checked by starting them', 'AI for your whole organization', 'One purchase, the installer is yours to keep'],
};

/** What an edition has, as a list of editions shows it: everything in the one before it, then what it adds. */
export function editionPoints(t: Tier): string[] {
  const before = TIERS[TIERS.indexOf(t) - 1];
  return before ? [`Everything in ${TIER_SHORT[before]}`, ...EDITION_PLANS[t].highlights] : EDITION_PLANS[t].highlights;
}

/** "$4.99", "Free", "$100". */
export function formatPrice(cents: number): string {
  if (cents === 0) return 'Free';
  const d = cents / 100;
  return `$${Number.isInteger(d) ? d : d.toFixed(2)}`;
}

/** What a computer of this edition costs per month: on its own, or in a tenant. Null when it cannot be had that way. */
export function priceOf(tier: Tier, where: 'personal' | 'tenant'): number | null {
  const p = EDITION_PLANS[tier];
  return where === 'tenant' ? p.tenantMonthly : p.monthly;
}

/** A tenant's monthly bill: the FBRX Command plan plus each computer at its edition's tenant price. */
export function tenantMonthlyTotal(computers: Partial<Record<Tier, number>>): number {
  let total = COMMAND_PLAN.monthly;
  for (const [tier, n] of Object.entries(computers) as Array<[Tier, number]>) total += EDITION_PLANS[tier].tenantMonthly * Math.max(0, n);
  return total;
}

/** What a product id (Stripe lookup key, store product id) sells. */
export type ProductInfo =
  | { kind: 'edition'; tier: Tier; tenant: boolean }
  | { kind: 'command' }
  | { kind: 'server' };

export function productById(id: string): ProductInfo | null {
  for (const p of Object.values(EDITION_PLANS)) {
    if (p.productId === id) return { kind: 'edition', tier: p.tier, tenant: false };
    if (p.tenantProductId === id) return { kind: 'edition', tier: p.tier, tenant: true };
  }
  if (id === COMMAND_PLAN.productId) return { kind: 'command' };
  if (id === SERVER_OFFER.productId) return { kind: 'server' };
  return null;
}
