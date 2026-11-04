import type { Vertical } from './editions';
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
 * - FBRX Command's operator may change the prices (Pricing, the PriceBook below): the organization fee by kind and
 *   size, each computer's price in an organization with discounts by how many it has, and the editions on their own.
 *   The prices here are where that price list starts.
 * - The MDM add-on manages an organization's computers, per computer, at one price whatever the computer's edition;
 *   FBRX Command's operator sets that price and when it is sold (FBRX Command → Pricing).
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
    highlights: ['Your AI’s controls: steps, answer length, how much it keeps in mind', 'Dash (the dashboard), alerts, notes, tasks, calendar and messages', 'Storage, FBRX Shield, updates, network and backups', 'Files, the clipboard history, the toolbox and how-tos'],
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

/**
 * The MDM add-on: device management for an organization's computers (patching, remote help, device security), per
 * managed computer per month, the same price whatever edition the computer runs, Essentials included. An organization
 * turns it on for a group's computers. FBRX Command's operator sets the price and when it goes on sale (Pricing); this
 * is where both start. Stripe charges it under `productId`, as many as the organization manages.
 */
export const MDM_ADDON = {
  productId: 'fbrx_mdm_tenant_monthly',
  /** Per managed computer per month, in cents, until the operator sets another. */
  perEndpoint: 400,
  /** The most the operator may set, in cents (a typo of $400 a computer is caught). */
  maxPerEndpoint: 5000,
  summary: 'Device management for your organization’s computers, at one price per computer whatever its edition.',
};

/** What FBRX Command's operator set for the MDM add-on: whether it is sold, and its price per computer (cents). */
export interface MdmPricing {
  available: boolean;
  perEndpoint: number;
}
export const DEFAULT_MDM_PRICING: MdmPricing = { available: false, perEndpoint: MDM_ADDON.perEndpoint };

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

/**
 * The organization fee's three Stripe prices: Work and School organizations pay `base` (the FBRX Command plan), or the
 * fee for larger organizations once they reach its size; Home organizations pay theirs. Only the ones the price list
 * uses need a price in Stripe.
 */
export const COMMAND_FEE_PRODUCTS = { base: COMMAND_PLAN.productId, large: 'fbrx_command_large_monthly', home: 'fbrx_command_home_monthly' } as const;
export type CommandFee = keyof typeof COMMAND_FEE_PRODUCTS;

/** The most any one price may be, in cents ($1,000): a slip of the finger is caught. */
export const MAX_PRICE = 100_000;
/** At most this many volume discount steps. */
export const MAX_VOLUME_STEPS = 5;

/** The editions an organization pays for, per computer. */
export const PAID_TIERS = ['basic', 'ultra', 'blackhole'] as const;
export type PaidTier = (typeof PAID_TIERS)[number];

/**
 * The price list FBRX Command's operator sets (FBRX Command → Pricing), in cents a month. Until they do, it is
 * DEFAULT_PRICE_BOOK: the prices above.
 */
export interface PriceBook {
  /** Standard and Ultra on their own, for a person's own computers. */
  personal: { basic: number; ultra: number };
  /** Each computer in an organization, before the volume discount. */
  seats: Record<PaidTier, number>;
  /**
   * Off every paid computer in an organization once it has `from` of them (Standard, Ultra and Black Hole together; the
   * highest step reached counts). Steps go up in `from`; none: no volume discount.
   */
  volume: Array<{ from: number; percentOff: number }>;
  /**
   * The organization's own fee, never discounted: Work and School organizations pay `base`, or `large.monthly` once
   * they have `large.from` computers (null: one fee for every size); Home organizations pay `home` (null: `base`).
   */
  fees: { base: number; large: { from: number; monthly: number } | null; home: number | null };
}

export const DEFAULT_PRICE_BOOK: PriceBook = {
  personal: { basic: EDITION_PLANS.basic.monthly!, ultra: EDITION_PLANS.ultra.monthly! },
  seats: { basic: EDITION_PLANS.basic.tenantMonthly, ultra: EDITION_PLANS.ultra.tenantMonthly, blackhole: EDITION_PLANS.blackhole.tenantMonthly },
  volume: [],
  fees: { base: COMMAND_PLAN.monthly, large: null, home: null },
};

/** Which organization fee an organization pays: by its kind, and by how many computers it has (Essentials included). */
export function organizationFee(book: PriceBook, kind: Vertical | null, computers: number): CommandFee {
  if (kind === 'home') return book.fees.home === null ? 'base' : 'home';
  return book.fees.large && computers >= book.fees.large.from ? 'large' : 'base';
}

/** The fee's price a month. */
export function feeAmount(book: PriceBook, fee: CommandFee): number {
  return fee === 'home' ? (book.fees.home ?? book.fees.base) : fee === 'large' ? (book.fees.large?.monthly ?? book.fees.base) : book.fees.base;
}

/** The volume discount (percent) on an organization's computers, by how many paid computers it has. */
export function volumeDiscount(book: PriceBook, paid: number): number {
  let off = 0;
  for (const step of book.volume) if (paid >= step.from) off = step.percentOff;
  return off;
}

/** One line of an organization's monthly bill. */
export interface BillLine {
  /** The organization fee, an edition's computers, or the MDM add-on. */
  item: 'fee' | PaidTier | 'mdm';
  /** The Stripe lookup key it is charged under. */
  productId: string;
  quantity: number;
  /** Each, a month, before any discount (cents). */
  each: number;
  /** Off this line, in percent: the volume discount, on computers only. */
  percentOff: number;
  /** The line, a month, after the discount (cents; Stripe rounds the discount on the line the same way). */
  total: number;
}

export interface OrganizationBill {
  lines: BillLine[];
  /** A month, in cents. */
  total: number;
  /** The organization fee it pays. */
  fee: CommandFee;
  /** Its computers at a paid edition (what the volume discount counts). */
  paid: number;
  /** The volume discount on them, in percent. */
  percentOff: number;
}

/**
 * An organization's monthly bill: its fee, each paid computer at its edition's price less the volume discount, and the
 * MDM add-on for each computer it manages (when it is sold, the same price whatever the edition).
 */
export function organizationBill(
  book: PriceBook,
  o: { kind: Vertical | null; computers: Partial<Record<Tier, number>>; mdm?: { managed: number; pricing: MdmPricing } },
): OrganizationBill {
  const count = (t: Tier) => Math.max(0, o.computers[t] ?? 0);
  const paid = PAID_TIERS.reduce((n, t) => n + count(t), 0);
  const fee = organizationFee(book, o.kind, paid + count('essentials'));
  const percentOff = volumeDiscount(book, paid);
  const lines: BillLine[] = [{ item: 'fee', productId: COMMAND_FEE_PRODUCTS[fee], quantity: 1, each: feeAmount(book, fee), percentOff: 0, total: feeAmount(book, fee) }];
  for (const t of PAID_TIERS) {
    const n = count(t);
    lines.push({ item: t, productId: EDITION_PLANS[t].tenantProductId!, quantity: n, each: book.seats[t], percentOff, total: Math.round((book.seats[t] * n * (100 - percentOff)) / 100) });
  }
  if (o.mdm?.pricing.available) {
    const n = Math.max(0, o.mdm.managed);
    lines.push({ item: 'mdm', productId: MDM_ADDON.productId, quantity: n, each: o.mdm.pricing.perEndpoint, percentOff: 0, total: o.mdm.pricing.perEndpoint * n });
  }
  return { lines, total: lines.reduce((sum, l) => sum + l.total, 0), fee, paid, percentOff };
}

/** A Work organization's monthly bill at the prices above (organizationBill with DEFAULT_PRICE_BOOK). */
export function tenantMonthlyTotal(computers: Partial<Record<Tier, number>>, mdm?: { managed: number; pricing: MdmPricing }): number {
  return organizationBill(DEFAULT_PRICE_BOOK, { kind: null, computers, mdm }).total;
}

/** Every price a price list charges, with its Stripe lookup key and what it is: for checking Stripe against it. */
export function priceBookProducts(book: PriceBook, mdm: MdmPricing): Array<{ productId: string; label: string; amount: number }> {
  return [
    { productId: EDITION_PLANS.basic.productId!, label: 'Standard on its own', amount: book.personal.basic },
    { productId: EDITION_PLANS.ultra.productId!, label: 'Ultra on its own', amount: book.personal.ultra },
    { productId: COMMAND_FEE_PRODUCTS.base, label: book.fees.large || book.fees.home !== null ? 'Organization fee, Work and School' : 'Organization fee', amount: book.fees.base },
    ...(book.fees.large ? [{ productId: COMMAND_FEE_PRODUCTS.large, label: `Organization fee, ${book.fees.large.from} computers or more`, amount: book.fees.large.monthly }] : []),
    ...(book.fees.home !== null ? [{ productId: COMMAND_FEE_PRODUCTS.home, label: 'Organization fee, Home', amount: book.fees.home }] : []),
    ...PAID_TIERS.map((t) => ({ productId: EDITION_PLANS[t].tenantProductId!, label: `${TIER_SHORT[t]} in an organization, each computer`, amount: book.seats[t] })),
    { productId: MDM_ADDON.productId, label: 'MDM add-on, each managed computer', amount: mdm.perEndpoint },
  ];
}

/** What a product id (Stripe lookup key, store product id) sells. */
export type ProductInfo =
  | { kind: 'edition'; tier: Tier; tenant: boolean }
  | { kind: 'command' }
  | { kind: 'mdm' }
  | { kind: 'server' };

export function productById(id: string): ProductInfo | null {
  for (const p of Object.values(EDITION_PLANS)) {
    if (p.productId === id) return { kind: 'edition', tier: p.tier, tenant: false };
    if (p.tenantProductId === id) return { kind: 'edition', tier: p.tier, tenant: true };
  }
  if ((Object.values(COMMAND_FEE_PRODUCTS) as string[]).includes(id)) return { kind: 'command' };
  if (id === MDM_ADDON.productId) return { kind: 'mdm' };
  if (id === SERVER_OFFER.productId) return { kind: 'server' };
  return null;
}
