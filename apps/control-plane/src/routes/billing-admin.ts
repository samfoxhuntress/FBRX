import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { COMMAND_PLAN, MDM_ADDON } from '@fbrx/shared';
import type { AppContext } from '../context';
import { adminAuth, requirePerm, requireTenant } from '../auth';
import { badRequest } from '../errors';
import { requireStripe, stripeOf } from '../billing/stripe';
import { scheduleSeatSync, syncSeats, syncTenantLicense, tenantPlanView } from '../billing/tenant-billing';
import { MdmPricingInput, mdmPricing, setMdmPricing } from '../billing/pricing';

/**
 * FBRX Command → Billing: the organization's plan in the cloud. Owners start it (Stripe Checkout for the FBRX Command
 * plan), manage it (the Stripe portal), and see what a month comes to; the per-computer items follow the computers by
 * themselves.
 *
 * FBRX Command → Pricing (the platform operator): the MDM add-on, whether it is sold and its price per managed computer,
 * and whether Stripe's price under the add-on's lookup key charges the same.
 */
export async function billingAdminRoutes(app: FastifyInstance, ctx: AppContext) {
  app.addHook('preHandler', adminAuth(ctx));
  const stripe = stripeOf(ctx.config.cloud);
  const consoleUrl = () => `${ctx.config.publicUrl}/#/billing`;

  app.get('/v1/admin/billing', async (req) => {
    requirePerm(req, 'billing.read');
    const tenantId = requireTenant(req);
    return { plan: tenantPlanView(ctx, tenantId), payments: !!stripe };
  });

  /** Starts the FBRX Command plan: a Stripe Checkout page for the organization. */
  app.post('/v1/admin/billing/checkout', async (req) => {
    const p = requirePerm(req, 'billing.manage');
    const tenantId = requireTenant(req);
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
      items: [{ productId: COMMAND_PLAN.productId, quantity: 1 }],
      successUrl: `${consoleUrl()}?checkout=done`,
      cancelUrl: `${consoleUrl()}?checkout=canceled`,
      reference: tenantId,
      metadata: { fbrx_tenant: tenantId },
    });
    ctx.audit.record({ type: 'user', id: p.id, label: p.label, tenantId, ip: req.ip }, 'billing.checkout', { type: 'tenant', id: tenantId, tenantId });
    return { url: session.url };
  });

  app.post('/v1/admin/billing/portal', async (req) => {
    requirePerm(req, 'billing.manage');
    const tenantId = requireTenant(req);
    const t = ctx.db.get<{ stripe_customer_id: string | null }>('SELECT stripe_customer_id FROM tenants WHERE id = ?', tenantId);
    if (!t?.stripe_customer_id) throw badRequest('There is no plan to manage yet');
    return { url: (await requireStripe(ctx.config.cloud).portal({ customer: t.stripe_customer_id, returnUrl: consoleUrl() })).url };
  });

  /** The MDM add-on as the operator set it, and what Stripe charges for it (null: Stripe is not set up). */
  app.get('/v1/admin/pricing', async (req) => {
    requirePerm(req, 'tenants.manage');
    const mdm = mdmPricing(ctx.db);
    let stripePrice: { found: boolean; unitAmount: number | null; interval: string | null; error?: string } | null = null;
    if (stripe) {
      try {
        const p = await stripe.priceInfo(MDM_ADDON.productId);
        stripePrice = p ? { found: true, unitAmount: p.unitAmount, interval: p.interval } : { found: false, unitAmount: null, interval: null };
      } catch (err) {
        stripePrice = { found: false, unitAmount: null, interval: null, error: (err as Error).message };
      }
    }
    return { mdm, productId: MDM_ADDON.productId, maxPerEndpoint: MDM_ADDON.maxPerEndpoint, stripe: stripePrice };
  });

  /** Sells the MDM add-on or stops, and sets its price; every organization's plan follows. */
  app.post('/v1/admin/pricing', async (req) => {
    const p = requirePerm(req, 'tenants.manage');
    const body = z.object({ mdm: MdmPricingInput }).strict().parse(req.body);
    const before = mdmPricing(ctx.db);
    const mdm = setMdmPricing(ctx, body.mdm);
    ctx.audit.record({ type: 'user', id: p.id, label: p.label, tenantId: null, ip: req.ip }, 'pricing.mdm', { type: 'pricing' }, { before, after: mdm });
    // Selling it or not changes what each organization's plan carries.
    if (before.available !== mdm.available) for (const t of ctx.db.all<{ id: string }>("SELECT id FROM tenants WHERE billing = 'cloud'")) scheduleSeatSync(ctx, stripe, t.id, 0);
    return { mdm };
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
