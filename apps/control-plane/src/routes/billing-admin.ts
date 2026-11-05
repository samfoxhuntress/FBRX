import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BILLING_INTERVALS, MDM_ADDON, priceBookProducts, productFor } from '@fbrx/shared';
import type { AppContext } from '../context';
import { adminAuth, requirePerm, requireTenant } from '../auth';
import { badRequest } from '../errors';
import { isValid, planEntitlement } from '../billing/entitlements';
import { MdmPricingInput, PriceBookInput, mdmPricing, priceBook, rememberStripePrice, setMdmPricing, setPriceBook } from '../billing/pricing';
import { requireStripe, stripeOf } from '../billing/stripe';
import { syncStripeSubscription } from '../billing/stripe-sync';
import { changeInterval, scheduleSeatSync, syncSeats, syncTenantLicense, tenantBill, tenantInterval, tenantPlanView } from '../billing/tenant-billing';

/**
 * FBRX Command → Billing: the organization's plan in the cloud. Owners start it (Stripe Checkout for its organization
 * fee, monthly or yearly), move it between the two, manage it (the Stripe portal), and see what it comes to; the
 * per-person and per-computer items follow by themselves.
 *
 * FBRX Command → Pricing (the platform operator): the price list (the editions on their own, the organization fees,
 * each person's price in an organization and the computers it includes, the volume discount and what a year costs)
 * and the MDM add-on; whether Stripe charges the same under each lookup key, and bringing Stripe in step.
 */
export async function billingAdminRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', adminAuth(ctx));
  const stripe = stripeOf(ctx.config.cloud);
  const consoleUrl = () => `${ctx.config.publicUrl}/#/billing`;

  /** The plan and its bill; before the plan runs, `interval` shows the bill paying monthly or yearly. */
  app.get('/v1/admin/billing', async (req) => {
    requirePerm(req, 'billing.read');
    const tenantId = requireTenant(req);
    const { interval } = z.object({ interval: z.enum(BILLING_INTERVALS).optional() }).parse(req.query);
    return { plan: tenantPlanView(ctx, tenantId, interval), payments: !!stripe };
  });

  /** Starts the FBRX Command plan, paid monthly or yearly: a Stripe Checkout page for the organization. */
  app.post('/v1/admin/billing/checkout', async (req) => {
    const p = requirePerm(req, 'billing.manage');
    const tenantId = requireTenant(req);
    const { interval } = z.object({ interval: z.enum(BILLING_INTERVALS).default('month') }).strict().parse(req.body ?? {});
    const s = requireStripe(ctx.config.cloud);
    const t = ctx.db.get<{ name: string; contact_email: string | null; stripe_customer_id: string | null; billing: string }>('SELECT name, contact_email, stripe_customer_id, billing FROM tenants WHERE id = ?', tenantId)!;
    if (t.billing !== 'cloud') throw badRequest('This organization’s licenses come from the operator of this FBRX Command, not a plan');
    if (tenantPlanView(ctx, tenantId).active) throw badRequest('The FBRX Command plan is already running: change it in Manage billing');
    let customer = t.stripe_customer_id;
    if (!customer) {
      customer = (await s.createCustomer({ email: t.contact_email ?? p.label, name: t.name, metadata: { fbrx_tenant: tenantId } })).id;
      ctx.db.run('UPDATE tenants SET stripe_customer_id = ?, updated_at = ? WHERE id = ?', customer, new Date().toISOString(), tenantId);
    }
    const session = await s.checkout({
      customer,
      items: [{ productId: tenantBill(ctx, tenantId, interval).bill.lines[0]!.productId, quantity: 1 }],
      successUrl: `${consoleUrl()}?checkout=done`,
      cancelUrl: `${consoleUrl()}?checkout=canceled`,
      reference: tenantId,
      metadata: { fbrx_tenant: tenantId },
    });
    ctx.audit.record({ type: 'user', id: p.id, label: p.label, tenantId, ip: req.ip }, 'billing.checkout', { type: 'tenant', id: tenantId, tenantId }, { interval });
    return { url: session.url };
  });

  /** Moves the running plan to paying monthly or yearly: every item at once, prorated by Stripe. */
  app.post('/v1/admin/billing/interval', async (req) => {
    const p = requirePerm(req, 'billing.manage');
    const tenantId = requireTenant(req);
    const { interval } = z.object({ interval: z.enum(BILLING_INTERVALS) }).strict().parse(req.body);
    const s = requireStripe(ctx.config.cloud);
    const e = planEntitlement(ctx.db, tenantId);
    if (!e || e.source !== 'stripe' || !isValid(e)) throw badRequest('There is no running plan to change');
    const before = tenantInterval(ctx.db, tenantId);
    if (before === interval) throw badRequest(`The plan is paid ${interval === 'year' ? 'yearly' : 'monthly'} already`);
    await syncStripeSubscription(ctx, s, await changeInterval(ctx, s, tenantId, interval));
    ctx.audit.record({ type: 'user', id: p.id, label: p.label, tenantId, ip: req.ip }, 'billing.interval', { type: 'tenant', id: tenantId, tenantId }, { before, after: interval });
    return { plan: tenantPlanView(ctx, tenantId) };
  });

  app.post('/v1/admin/billing/portal', async (req) => {
    requirePerm(req, 'billing.manage');
    const tenantId = requireTenant(req);
    const t = ctx.db.get<{ stripe_customer_id: string | null }>('SELECT stripe_customer_id FROM tenants WHERE id = ?', tenantId);
    if (!t?.stripe_customer_id) throw badRequest('There is no plan to manage yet');
    return { url: (await requireStripe(ctx.config.cloud).portal({ customer: t.stripe_customer_id, returnUrl: consoleUrl() })).url };
  });

  /** What Stripe charges under each lookup key the price list uses (null: Stripe is not set up here). */
  async function stripePrices() {
    if (!stripe) return null;
    const out: Record<string, { found: boolean; unitAmount: number | null; interval: string | null; error?: string }> = {};
    await Promise.all(
      priceBookProducts(priceBook(ctx.db), mdmPricing(ctx.db)).map(async ({ productId }) => {
        try {
          const p = await stripe.priceInfo(productId);
          out[productId] = p ? { found: true, unitAmount: p.unitAmount, interval: p.interval } : { found: false, unitAmount: null, interval: null };
        } catch (err) {
          out[productId] = { found: false, unitAmount: null, interval: null, error: (err as Error).message };
        }
      }),
    );
    return out;
  }

  /** The price list and the MDM add-on as the operator set them, and what Stripe charges for each. */
  app.get('/v1/admin/pricing', async (req) => {
    requirePerm(req, 'tenants.manage');
    const book = priceBook(ctx.db);
    const mdm = mdmPricing(ctx.db);
    return { book, mdm, products: priceBookProducts(book, mdm), maxPerEndpoint: MDM_ADDON.maxPerEndpoint, stripe: await stripePrices() };
  });

  /** Sets the price list or the MDM add-on (selling it or not, its price); every organization's plan follows. */
  app.post('/v1/admin/pricing', async (req) => {
    const p = requirePerm(req, 'tenants.manage');
    const body = z.object({ book: PriceBookInput.optional(), mdm: MdmPricingInput.optional() }).strict().parse(req.body);
    const actor = { type: 'user' as const, id: p.id, label: p.label, tenantId: null, ip: req.ip };
    let resync = false;
    if (body.book) {
      const before = priceBook(ctx.db);
      setPriceBook(ctx, body.book);
      ctx.audit.record(actor, 'pricing.book', { type: 'pricing' }, { before, after: body.book });
      // The fees and the volume discount decide which items and coupon an organization's plan carries.
      resync = JSON.stringify(before.fees) !== JSON.stringify(body.book.fees) || JSON.stringify(before.volume) !== JSON.stringify(body.book.volume);
    }
    if (body.mdm) {
      const before = mdmPricing(ctx.db);
      const after = setMdmPricing(ctx, body.mdm);
      ctx.audit.record(actor, 'pricing.mdm', { type: 'pricing' }, { before, after });
      resync ||= before.available !== after.available;
    }
    if (resync) for (const t of ctx.db.all<{ id: string }>("SELECT id FROM tenants WHERE billing = 'cloud'")) scheduleSeatSync(ctx, stripe, t.id, 0);
    return { book: priceBook(ctx.db), mdm: mdmPricing(ctx.db) };
  });

  /**
   * Brings Stripe to the price list: each price Stripe lacks or charges differently gets a new price, monthly or yearly,
   * that takes its lookup key: on the product the old price was on, a yearly price on its monthly one's product (so
   * the volume discount's coupon covers both), or on a new product. People who already pay keep their price;
   * organizations move to the new one at their next seat update.
   */
  app.post('/v1/admin/pricing/stripe', async (req) => {
    const p = requirePerm(req, 'tenants.manage');
    const s = requireStripe(ctx.config.cloud);
    const created: string[] = [];
    // Each month's prices come first, so a yearly one finds its monthly one's product.
    for (const want of priceBookProducts(priceBook(ctx.db), mdmPricing(ctx.db))) {
      const now = await s.priceInfo(want.productId);
      if (now && now.unitAmount === want.amount && now.interval === want.interval) continue;
      // The old price stays known as this product for whoever still pays it.
      if (now) rememberStripePrice(ctx.db, now.id, want.productId);
      const product = now?.product ?? (want.interval === 'year' ? ((await s.priceInfo(productFor(want.productId, 'month')))?.product ?? null) : null);
      await s.createPrice({ productId: want.productId, unitAmount: want.amount, interval: want.interval, product, name: `FBRX: ${want.label}` });
      created.push(want.productId);
    }
    ctx.audit.record({ type: 'user', id: p.id, label: p.label, tenantId: null, ip: req.ip }, 'pricing.stripe', { type: 'pricing' }, { created });
    if (created.length) for (const t of ctx.db.all<{ id: string }>("SELECT id FROM tenants WHERE billing = 'cloud'")) scheduleSeatSync(ctx, stripe, t.id, 0);
    return { created, stripe: await stripePrices() };
  });

  /** Brings the plan (its license and its per-computer items) up to date now. */
  app.post('/v1/admin/billing/sync', async (req) => {
    requirePerm(req, 'billing.manage');
    const tenantId = requireTenant(req);
    syncTenantLicense(ctx, tenantId);
    const r = await syncSeats(ctx, stripe, tenantId);
    return { ...r, plan: tenantPlanView(ctx, tenantId) };
  });
}
