import { EDITION_PLANS, TIERS, tenantMonthlyTotal, type Tier } from '@fbrx/shared';
import type { Db } from '@fbrx/shared/node';
import { signLicense } from '@fbrx/shared/node';
import type { AppContext } from '../context';
import { ids } from '../context';
import { LICENSE_SLACK_DAYS, isValid } from './entitlements';
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

export interface TenantPlanView {
  billing: 'manual' | 'cloud';
  active: boolean;
  periodEnd: string | null;
  status: string | null;
  /** Computers at each edition (what the organization gives them). */
  computers: Record<Tier, number>;
  /** What a month comes to, in cents: the plan and the computers. */
  monthly: number;
  /** Can open the Stripe billing portal. */
  portal: boolean;
}

/** The plan's purchase (the FBRX Command plan item), if any. */
function commandEntitlement(db: Db, tenantId: string) {
  return db.get<{ external_id: string; status: string; period_end: string | null; source: string }>(
    "SELECT external_id, status, period_end, source FROM entitlements WHERE tenant_id = ? AND kind = 'command' ORDER BY updated_at DESC LIMIT 1",
    tenantId,
  );
}

export function cloudPlanActive(db: Db, tenantId: string): boolean {
  const e = commandEntitlement(db, tenantId);
  return !!e && isValid({ status: e.status as never, period_end: e.period_end });
}

/** How many of the organization's active computers run each edition (what they are given; Essentials when nothing). */
export function computersByTier(db: Db, tenantId: string): Record<Tier, number> {
  const out = Object.fromEntries(TIERS.map((t) => [t, 0])) as Record<Tier, number>;
  const rows = db.all<{ tier: string | null; gtier: string | null; audience: string | null; gaudience: string | null }>(
    "SELECT d.tier, g.tier AS gtier, d.audience, g.audience AS gaudience FROM devices d LEFT JOIN groups g ON g.id = d.group_id WHERE d.tenant_id = ? AND d.status = 'active'",
    tenantId,
  );
  for (const r of rows) {
    const learner = ['student', 'child'].includes(r.audience ?? r.gaudience ?? '');
    // Student and child computers run the learner edition on Standard.
    const t = (learner ? 'basic' : ((r.tier ?? r.gtier) as Tier | null)) ?? 'essentials';
    out[(TIERS as readonly string[]).includes(t) ? t : 'essentials'] += 1;
  }
  return out;
}

export function tenantPlanView(ctx: AppContext, tenantId: string): TenantPlanView {
  const t = ctx.db.get<{ billing: string | null; stripe_customer_id: string | null }>('SELECT billing, stripe_customer_id FROM tenants WHERE id = ?', tenantId);
  const e = commandEntitlement(ctx.db, tenantId);
  const computers = computersByTier(ctx.db, tenantId);
  return {
    billing: t?.billing === 'cloud' ? 'cloud' : 'manual',
    active: cloudPlanActive(ctx.db, tenantId),
    periodEnd: e?.period_end ?? null,
    status: e?.status ?? null,
    computers,
    monthly: tenantMonthlyTotal({ basic: computers.basic, ultra: computers.ultra, blackhole: computers.blackhole }),
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
  const e = commandEntitlement(ctx.db, tenantId);
  if (!cloudPlanActive(ctx.db, tenantId) || !e) {
    if (current) {
      ctx.db.run('UPDATE licenses SET revoked_at = ? WHERE id = ?', now.toISOString(), current.id);
      ctx.bumpConfig(tenantId);
    }
    return;
  }
  const expiresAt = e.period_end ? new Date(Date.parse(e.period_end) + LICENSE_SLACK_DAYS * 86_400_000).toISOString() : null;
  if (current && current.expires_at === expiresAt) return;
  const id = ids.license();
  const key = signLicense(
    { v: 1, lid: id, tenantId, customer: t.name, edition: 'enterprise', seats: 0, features: [], issuedAt: now.toISOString(), expiresAt, maxMajorVersion: null, tier: 'blackhole', ...(t.vertical === 'education' || t.vertical === 'home' ? { vertical: t.vertical } : {}) },
    ctx.keys.licensePrivatePem,
  );
  ctx.db.tx(() => {
    if (current) ctx.db.run('UPDATE licenses SET revoked_at = ? WHERE id = ?', now.toISOString(), current.id);
    ctx.db.run(
      'INSERT INTO licenses (id, tenant_id, customer, edition, seats, features, issued_at, expires_at, max_major_version, key_text, created_by, vertical) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      id,
      tenantId,
      t.name,
      'enterprise',
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
  const e = commandEntitlement(ctx.db, tenantId);
  if (!stripe || t?.billing !== 'cloud' || !e || e.source !== 'stripe' || !cloudPlanActive(ctx.db, tenantId)) return { changed: [] };
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

