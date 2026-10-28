import { EDITION_PLANS, LEARNER_TIER, TIERS, isLearner, licenseEditionFor, tenantMonthlyTotal, type TenantPlanView, type Tier } from '@fbrx/shared';
import type { Db } from '@fbrx/shared/node';
import { signLicense } from '@fbrx/shared/node';
import type { AppContext } from '../context';
import { ids } from '../context';
import { givenEdition } from '../services/device-config';
import { LICENSE_SLACK_DAYS, isValid, planEntitlement } from './entitlements';
import type { Stripe } from './stripe';

/**
 * An organization's FBRX Command in the cloud (`billing = 'cloud'`): the FBRX Command plan ($54.99 a month) and each of
 * its computers at its edition's tenant price, counted from what the organization gives them: Standard and Ultra at 20%
 * off, Black Hole as a full-price add-on, Essentials free. With the plan active, FBRX Command holds a license for the
 * organization that allows everything (Black Hole); each computer runs what it is given, Essentials when nobody gave it
 * anything. Without the plan, its computers run Essentials.
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

export function tenantPlanView(ctx: AppContext, tenantId: string): TenantPlanView {
  const t = ctx.db.get<{ billing: string | null; stripe_customer_id: string | null }>('SELECT billing, stripe_customer_id FROM tenants WHERE id = ?', tenantId);
  const e = planEntitlement(ctx.db, tenantId);
  const computers = computersByTier(ctx.db, tenantId);
  return {
    billing: t?.billing === 'cloud' ? 'cloud' : 'manual',
    active: !!e && isValid(e),
    periodEnd: e?.period_end ?? null,
    status: e?.status ?? null,
    computers,
    monthly: tenantMonthlyTotal(computers),
    portal: !!t?.stripe_customer_id && !!ctx.config.cloud.stripe,
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
 * Brings the plan's per-computer items in Stripe to the organization's computers (each edition's tenant price, as many
 * as its computers run). Stripe prorates the change on the next invoice.
 */
export async function syncSeats(ctx: AppContext, stripe: Stripe | null, tenantId: string): Promise<{ changed: string[] }> {
  const t = ctx.db.get<{ billing: string | null }>('SELECT billing FROM tenants WHERE id = ?', tenantId);
  const e = planEntitlement(ctx.db, tenantId);
  if (!stripe || t?.billing !== 'cloud' || !e || e.source !== 'stripe' || !isValid(e)) return { changed: [] };
  const sub = await stripe.subscription(e.external_id);
  const computers = computersByTier(ctx.db, tenantId);
  const changed: string[] = [];
  for (const tier of ['basic', 'ultra', 'blackhole'] as const) {
    const productId = EDITION_PLANS[tier].tenantProductId!;
    const want = computers[tier];
    const item = sub.items.data.find((i) => i.price.lookup_key === productId);
    if (item && (item.quantity ?? 0) !== want) {
      await stripe.updateItemQuantity(item.id, want);
      changed.push(`${productId}=${want}`);
    } else if (!item && want > 0) {
      await stripe.addItem(sub.id, productId, want);
      changed.push(`${productId}=${want}`);
    }
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

