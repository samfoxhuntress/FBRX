import { z } from 'zod';
import { DEFAULT_MDM_PRICING, MDM_ADDON, type MdmPricing } from '@fbrx/shared';
import type { Db } from '@fbrx/shared/node';
import type { AppContext } from '../context';

/**
 * What FBRX Command's operator sets about prices (FBRX Command → Pricing): for now the MDM add-on, whether it is sold
 * and its price per managed computer, the same whatever edition the computer runs. Kept in the meta table; until the
 * operator sets it, the add-on is not sold and starts at MDM_ADDON's price. Stripe charges what its price under the
 * add-on's lookup key says: the Pricing page checks that the two agree.
 */

const KEY = 'pricing.mdm';

export const MdmPricingInput = z
  .object({
    available: z.boolean(),
    perEndpoint: z.number().int().min(0).max(MDM_ADDON.maxPerEndpoint),
  })
  .partial()
  .strict();

export function mdmPricing(db: Db): MdmPricing {
  try {
    const saved = JSON.parse(db.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', KEY)?.value ?? '{}') as Partial<MdmPricing>;
    const r = MdmPricingInput.safeParse(saved);
    return { ...DEFAULT_MDM_PRICING, ...(r.success ? r.data : {}) };
  } catch {
    return { ...DEFAULT_MDM_PRICING };
  }
}

export function setMdmPricing(ctx: AppContext, patch: z.infer<typeof MdmPricingInput>): MdmPricing {
  const next = { ...mdmPricing(ctx.db), ...patch };
  ctx.db.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', KEY, JSON.stringify(next));
  return next;
}

/** How many of an organization's active computers its groups manage with the MDM add-on. */
export function mdmManaged(db: Db, tenantId: string): number {
  return Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM devices d JOIN groups g ON g.id = d.group_id WHERE d.tenant_id = ? AND d.status = 'active' AND g.mdm = 1", tenantId)?.n ?? 0);
}
