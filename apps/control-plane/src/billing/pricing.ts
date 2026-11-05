import { z } from 'zod';
import { DEFAULT_MDM_PRICING, DEFAULT_PRICE_BOOK, MAX_PRICE, MAX_VOLUME_STEPS, MAX_YEARLY_MONTHS, MDM_ADDON, type MdmPricing, type PriceBook } from '@fbrx/shared';
import type { Db } from '@fbrx/shared/node';
import type { AppContext } from '../context';

/**
 * What FBRX Command's operator sets about prices (FBRX Command → Pricing), kept in the meta table:
 * - the price list (PriceBook): the editions on their own, the organization fee by kind and size, each person's price
 *   in an organization and the computers it includes, the volume discount, and what a year costs paying yearly; until
 *   the operator sets it, the prices in plans.ts;
 * - the MDM add-on: whether it is sold and its price per managed computer, the same whatever edition the computer runs;
 *   until the operator sets it, it is not sold and starts at MDM_ADDON's price.
 * Stripe charges what its prices under the lookup keys say: the Pricing page checks that they agree, and can bring
 * Stripe in step.
 */

const KEY = 'pricing.mdm';
const BOOK_KEY = 'pricing.book';
/** Every price Stripe had under one of FBRX's lookup keys, by price id (a key moves on when its price changes). */
const STRIPE_PRICES_KEY = 'stripe.prices';

const readMeta = (db: Db, key: string): unknown => {
  try {
    return JSON.parse(db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value ?? 'null');
  } catch {
    return null;
  }
};
const writeMeta = (db: Db, key: string, value: unknown) => db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));

const cents = z.number().int().min(0).max(MAX_PRICE);
const size = z.number().int().min(2).max(1_000_000);

export const PriceBookInput = z
  .object({
    personal: z.object({ basic: cents, ultra: cents }).strict(),
    seats: z.object({ basic: cents, ultra: cents, blackhole: cents }).strict(),
    // A price list saved before computers were counted per person takes the prices in plans.ts for them.
    computers: z
      .object({
        included: z.object({ basic: z.number().int().min(1).max(1000), ultra: z.number().int().min(1).max(1000), blackhole: z.number().int().min(1).max(1000) }).strict(),
        extra: z.object({ basic: cents, ultra: cents, blackhole: cents }).strict(),
      })
      .strict()
      .default(DEFAULT_PRICE_BOOK.computers),
    volume: z
      .array(z.object({ from: size, percentOff: z.number().int().min(1).max(90) }).strict())
      .max(MAX_VOLUME_STEPS)
      .refine((steps) => steps.every((s, i) => i === 0 || s.from > steps[i - 1]!.from), 'Each volume step starts at more computers than the one before'),
    fees: z.object({ base: cents, large: z.object({ from: size, monthly: cents }).strict().nullable(), home: cents.nullable() }).strict(),
    // A price list saved before organizations could pay yearly takes the months in plans.ts.
    yearlyMonths: z.number().int().min(1).max(MAX_YEARLY_MONTHS).default(DEFAULT_PRICE_BOOK.yearlyMonths),
  })
  .strict();

/** The price list as the operator set it (the prices in plans.ts until they do). */
export function priceBook(db: Db): PriceBook {
  const r = PriceBookInput.safeParse(readMeta(db, BOOK_KEY));
  return r.success ? r.data : structuredClone(DEFAULT_PRICE_BOOK);
}

export function setPriceBook(ctx: AppContext, book: PriceBook): PriceBook {
  writeMeta(ctx.db, BOOK_KEY, book);
  return book;
}

/** Notes that a Stripe price was sold under a lookup key. */
export function rememberStripePrice(db: Db, priceId: string, productId: string): void {
  const known = (readMeta(db, STRIPE_PRICES_KEY) ?? {}) as Record<string, string>;
  if (known[priceId] === productId) return;
  writeMeta(db, STRIPE_PRICES_KEY, { ...known, [priceId]: productId });
}

/** The lookup key a Stripe price was sold under, even after the key moved to a newer price (null: not FBRX's). */
export function knownStripePrice(db: Db, priceId: string): string | null {
  return ((readMeta(db, STRIPE_PRICES_KEY) ?? {}) as Record<string, string>)[priceId] ?? null;
}

export const MdmPricingInput = z
  .object({
    available: z.boolean(),
    perEndpoint: z.number().int().min(0).max(MDM_ADDON.maxPerEndpoint),
  })
  .partial()
  .strict();

export function mdmPricing(db: Db): MdmPricing {
  const r = MdmPricingInput.safeParse(readMeta(db, KEY) ?? {});
  return { ...DEFAULT_MDM_PRICING, ...(r.success ? r.data : {}) };
}

export function setMdmPricing(ctx: AppContext, patch: z.infer<typeof MdmPricingInput>): MdmPricing {
  const next = { ...mdmPricing(ctx.db), ...patch };
  writeMeta(ctx.db, KEY, next);
  return next;
}

/** How many of an organization's active computers its groups manage with the MDM add-on. */
export function mdmManaged(db: Db, tenantId: string): number {
  return Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM devices d JOIN groups g ON g.id = d.group_id WHERE d.tenant_id = ? AND d.status = 'active' AND g.mdm = 1", tenantId)?.n ?? 0);
}
