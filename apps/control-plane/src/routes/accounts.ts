import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { COMMAND_PLAN, EDITION_PLANS, SERVER_OFFER, TIERS, TIER_SHORT, VERTICALS, atLeast, productById, type AccountView, type MemberView, type PlansInfo, type Tier } from '@fbrx/shared';
import { hashPassword, randomToken, safeEqual, sha256Hex, verifyPassword } from '@fbrx/shared/node';
import type { AppContext } from '../context';
import { ids } from '../context';
import { adminAuth, requirePerm, requireTenant } from '../auth';
import { badRequest, conflict, forbidden, HttpError, notFound, unauthorized } from '../errors';
import { PasswordSchema } from './auth';
import { accountEntitlements, accountLicense, accountTier, endPurchase, entitlementView, handledBefore, isValid, markHandled, purchaseOwner, recordPurchase } from '../billing/entitlements';
import { requireStripe, stripeOf, stripeStatus, subscriptionItems, type StripeEvent, type StripeSubscription } from '../billing/stripe';
import { appleStatus, appleTestPurchase, verifyAppleJws, type AppleNotification, type AppleRenewal, type AppleTransaction } from '../billing/apple';
import { GooglePlay, playStatus, type PlaySubscription } from '../billing/google';
import { scheduleSeatSync, syncTenantLicense } from '../billing/tenant-billing';
import { slugify } from './util';

/**
 * FBRX accounts and what they buy (FBRX Command in the cloud).
 *
 * - Anyone signs up (when FBRX_CP_PUBLIC_SIGNUP=1) with an email and a password; the app on a computer or a phone signs
 *   in and keeps a long-lived account token, and fetches the account's license with it (GET /v1/accounts/license).
 * - On the website and on computers, editions are bought with Stripe Checkout (cards, Apple Pay, Google Pay); in the
 *   phone apps, with the App Store or Google Play (their rules: purchases made in an app go through the store). Every
 *   purchase lands in the same entitlements, so whatever an account bought anywhere signs in everywhere.
 */

const ISSUER = 'fbrx-accounts';
const ACCOUNT_TOKEN_DAYS = 90;
const TEST_PURCHASE = 'That purchase was made in a test copy of the app, so nothing was charged and it does not turn on an edition.';

interface AccountRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  status: string;
  app_account_token: string;
  stripe_customer_id: string | null;
  failed_logins: number;
  locked_until: string | null;
  created_at: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    account?: AccountRow;
    accountSessionId?: string;
    rawBody?: string;
  }
}

export function accountView(ctx: AppContext, a: AccountRow): AccountView {
  return {
    id: a.id,
    email: a.email,
    name: a.name,
    tier: accountTier(ctx, a.id).tier,
    entitlements: accountEntitlements(ctx, a.id).map(entitlementView),
    billingPortal: !!a.stripe_customer_id && !!ctx.config.cloud.stripe,
    appAccountToken: a.app_account_token,
    memberships: ctx.db
      .all<{ tenant_id: string; name: string; tier: Tier }>("SELECT m.tenant_id, t.name, m.tier FROM tenant_members m JOIN tenants t ON t.id = m.tenant_id WHERE m.account_id = ? AND t.status = 'active' ORDER BY t.name", a.id)
      .map((m) => ({ tenantId: m.tenant_id, tenantName: m.name, tier: m.tier })),
    createdAt: a.created_at,
  };
}

async function issueAccountToken(ctx: AppContext, account: AccountRow, label: string) {
  const sid = ids.accountSession();
  const now = new Date();
  const expires = new Date(now.getTime() + ACCOUNT_TOKEN_DAYS * 86_400_000);
  ctx.db.run('INSERT INTO account_sessions (id, account_id, label, created_at, expires_at, last_seen_at) VALUES (?,?,?,?,?,?)', sid, account.id, label.slice(0, 120), now.toISOString(), expires.toISOString(), now.toISOString());
  const token = await new SignJWT({ sid }).setProtectedHeader({ alg: 'HS256' }).setSubject(account.id).setIssuedAt().setIssuer(ISSUER).setExpirationTime(Math.floor(expires.getTime() / 1000)).sign(ctx.keys.jwt);
  return { token, expiresAt: expires.toISOString() };
}

function accountAuth(ctx: AppContext) {
  return async (req: FastifyRequest) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) throw unauthorized('Sign in to your FBRX account');
    try {
      const { payload } = await jwtVerify(h.slice(7).trim(), ctx.keys.jwt, { issuer: ISSUER, algorithms: ['HS256'] });
      const s = ctx.db.get<{ id: string; expires_at: string }>('SELECT id, expires_at FROM account_sessions WHERE id = ? AND revoked_at IS NULL', String(payload.sid ?? ''));
      const a = ctx.db.get<AccountRow>("SELECT * FROM accounts WHERE id = ? AND status = 'active'", String(payload.sub ?? ''));
      if (!s || s.expires_at < new Date().toISOString() || !a) throw new Error('gone');
      ctx.db.run('UPDATE account_sessions SET last_seen_at = ? WHERE id = ?', new Date().toISOString(), s.id);
      req.account = a;
      req.accountSessionId = s.id;
    } catch {
      throw unauthorized('Your FBRX account sign-in has ended. Sign in again.');
    }
  };
}

const accountActor = (a: AccountRow, req: FastifyRequest) => ({ type: 'account' as const, id: a.id, label: a.email, tenantId: null, ip: req.ip });

/** A product an account may buy for itself: Standard or Ultra, the personal plans. */
function personalProduct(productId: string) {
  const p = productById(productId);
  if (!p || p.kind !== 'edition' || p.tenant) throw badRequest('That is not an edition you can buy for yourself (Standard or Ultra)');
  return p;
}

export async function accountRoutes(app: FastifyInstance, ctx: AppContext) {
  const cloud = ctx.config.cloud;
  const auth = accountAuth(ctx);
  const stripe = stripeOf(cloud);
  const play = cloud.google ? new GooglePlay(cloud.google) : null;

  app.get('/v1/plans', async (): Promise<PlansInfo & { editions: typeof EDITION_PLANS; command: typeof COMMAND_PLAN; server: typeof SERVER_OFFER }> => ({
    editions: EDITION_PLANS,
    command: COMMAND_PLAN,
    server: SERVER_OFFER,
    publicSignup: cloud.publicSignup,
    payments: { stripe: !!stripe, apple: !!cloud.apple, google: !!play },
  }));

  // ------------------------------------------------------------------------------------------- accounts
  app.post('/v1/accounts/signup', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    if (!cloud.publicSignup) throw forbidden('This FBRX Command does not take new accounts');
    const body = z.object({ email: z.string().email().max(200), name: z.string().trim().min(1).max(120), password: PasswordSchema, device: z.string().max(120).default('') }).parse(req.body);
    if (ctx.db.get('SELECT id FROM accounts WHERE email = ?', body.email.trim())) throw conflict('There is already an FBRX account with that email. Sign in instead.');
    const now = new Date().toISOString();
    const id = ids.account();
    ctx.db.run(
      'INSERT INTO accounts (id, email, name, password_hash, app_account_token, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      id,
      body.email.trim(),
      body.name,
      await hashPassword(body.password),
      randomUUID(),
      now,
      now,
    );
    const a = ctx.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', id)!;
    ctx.audit.record(accountActor(a, req), 'account.created', { type: 'account', id });
    return { ...(await issueAccountToken(ctx, a, body.device)), account: accountView(ctx, a) };
  });

  app.post('/v1/accounts/login', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const body = z.object({ email: z.string().max(200), password: z.string().max(200), device: z.string().max(120).default('') }).parse(req.body);
    const a = ctx.db.get<AccountRow>('SELECT * FROM accounts WHERE email = ?', body.email.trim());
    const fail = () => unauthorized('Wrong email or password');
    if (!a || a.status !== 'active') throw fail();
    if (a.locked_until && a.locked_until > new Date().toISOString()) throw unauthorized('Too many tries: wait a quarter of an hour and try again');
    if (!(await verifyPassword(body.password, a.password_hash))) {
      const fails = Number(a.failed_logins) + 1;
      ctx.db.run('UPDATE accounts SET failed_logins = ?, locked_until = ? WHERE id = ?', fails, fails >= 10 ? new Date(Date.now() + 15 * 60_000).toISOString() : null, a.id);
      throw fail();
    }
    ctx.db.run('UPDATE accounts SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', new Date().toISOString(), a.id);
    ctx.audit.record(accountActor(a, req), 'account.login', { type: 'account', id: a.id }, { device: body.device });
    return { ...(await issueAccountToken(ctx, a, body.device)), account: accountView(ctx, a) };
  });

  app.post('/v1/accounts/logout', { preHandler: auth }, async (req) => {
    ctx.db.run('UPDATE account_sessions SET revoked_at = ? WHERE id = ?', new Date().toISOString(), req.accountSessionId!);
    return { ok: true };
  });

  app.get('/v1/accounts/me', { preHandler: auth }, async (req) => accountView(ctx, req.account!));

  /** The license this account signs a computer up to (no key with nothing bought), fetched again before it ends. */
  app.get('/v1/accounts/license', { preHandler: auth }, async (req) => accountLicense(ctx, req.account!));

  app.post('/v1/accounts/password', { preHandler: auth }, async (req) => {
    const body = z.object({ current: z.string().max(200), password: PasswordSchema }).parse(req.body);
    const a = req.account!;
    if (!(await verifyPassword(body.current, a.password_hash))) throw unauthorized('Your current password is not right');
    ctx.db.run('UPDATE accounts SET password_hash = ?, updated_at = ? WHERE id = ?', await hashPassword(body.password), new Date().toISOString(), a.id);
    // Signed out everywhere else.
    ctx.db.run('UPDATE account_sessions SET revoked_at = ? WHERE account_id = ? AND id != ? AND revoked_at IS NULL', new Date().toISOString(), a.id, req.accountSessionId!);
    ctx.audit.record(accountActor(a, req), 'account.password', { type: 'account', id: a.id });
    return { ok: true };
  });

  /**
   * Deletes the account (the stores require that an app which makes accounts can delete them too). Subscriptions bought
   * with Stripe end now; ones bought in the App Store or Google Play are ended in the store's subscription settings.
   */
  app.delete('/v1/accounts/me', { preHandler: auth }, async (req) => {
    const body = z.object({ password: z.string().max(200) }).parse(req.body ?? {});
    const a = req.account!;
    if (!(await verifyPassword(body.password, a.password_hash))) throw unauthorized('Your password is not right');
    const owned = accountEntitlements(ctx, a.id).filter((e) => isValid(e));
    if (stripe) for (const subId of new Set(owned.filter((e) => e.source === 'stripe').map((e) => e.external_id))) await stripe.cancel(subId).catch(() => undefined);
    const stores = [...new Set(owned.filter((e) => e.source === 'apple' || e.source === 'google').map((e) => e.source))];
    ctx.db.run('DELETE FROM accounts WHERE id = ?', a.id);
    ctx.audit.record(accountActor(a, req), 'account.deleted', { type: 'account', id: a.id });
    return {
      ok: true,
      note: stores.length ? `Your ${stores.map((s) => (s === 'apple' ? 'App Store' : 'Google Play')).join(' and ')} subscription is not ended by this: end it in the store's subscription settings.` : null,
    };
  });

  /**
   * Joins a computer to an organization the account belongs to: a one-time enrollment token (fifteen minutes) that
   * carries the edition the organization gave this member, so the computer runs it as soon as it joins.
   */
  app.post('/v1/accounts/memberships/:tenantId/enroll', { preHandler: auth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const a = req.account!;
    const tenantId = (req.params as { tenantId: string }).tenantId;
    const m = ctx.db.get<{ tier: Tier; name: string }>("SELECT m.tier, t.name FROM tenant_members m JOIN tenants t ON t.id = m.tenant_id WHERE m.tenant_id = ? AND m.account_id = ? AND t.status = 'active'", tenantId, a.id);
    if (!m) throw forbidden('Your FBRX account is not a member of that organization');
    const token = randomToken('fbrx_enr');
    ctx.db.run(
      'INSERT INTO enrollment_tokens (id, tenant_id, group_id, label, prefix, token_hash, max_uses, expires_at, created_by, created_at, tier, account_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      ids.enrollment(),
      tenantId,
      null,
      `Sign-in: ${a.email}`,
      token.slice(0, 15),
      sha256Hex(token),
      1,
      new Date(Date.now() + 15 * 60_000).toISOString(),
      `account:${a.id}`,
      new Date().toISOString(),
      m.tier,
      a.id,
    );
    ctx.audit.record({ ...accountActor(a, req), tenantId }, 'account.enroll', { type: 'tenant', id: tenantId, tenantId }, { tier: m.tier });
    return { serverUrl: ctx.config.publicUrl, token, fingerprint: ctx.tls?.selfSigned ? ctx.tls.fingerprint : null, tenantName: m.name, tier: m.tier };
  });

  /**
   * Starts an organization's own FBRX Command (in the cloud): the account becomes its owner (signing in to the console
   * with the account's password) and a member on Essentials. Nothing is charged until the owner starts the plan in
   * Billing; until then its computers run Essentials.
   */
  app.post('/v1/accounts/tenants', { preHandler: auth, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (req) => {
    if (!cloud.publicSignup) throw forbidden('This FBRX Command does not take new organizations');
    const body = z.object({ name: z.string().trim().min(1).max(120), kind: z.enum(VERTICALS).default('business') }).parse(req.body);
    const a = req.account!;
    if (ctx.db.get('SELECT id FROM users WHERE email = ?', a.email)) throw conflict('That email already signs in to an FBRX Command console');
    const now = new Date().toISOString();
    const tenantId = ids.tenant();
    let slug = slugify(body.name);
    if (ctx.db.get('SELECT id FROM tenants WHERE slug = ?', slug)) slug = `${slug}-${tenantId.slice(-6)}`;
    ctx.db.tx(() => {
      ctx.db.run("INSERT INTO tenants (id, name, slug, contact_email, vertical, billing, created_at, updated_at) VALUES (?,?,?,?,?,'cloud',?,?)", tenantId, body.name, slug, a.email, body.kind, now, now);
      ctx.db.run("INSERT INTO users (id, tenant_id, email, name, password_hash, role, account_id, created_at, updated_at) VALUES (?,?,?,?,'','owner',?,?,?)", ids.user(), tenantId, a.email, a.name, a.id, now, now);
      ctx.db.run("INSERT INTO tenant_members (tenant_id, account_id, tier, created_at) VALUES (?,?,'essentials',?)", tenantId, a.id, now);
    });
    ctx.audit.record({ ...accountActor(a, req), tenantId }, 'tenant.created', { type: 'tenant', id: tenantId, tenantId }, { name: body.name, kind: body.kind, billing: 'cloud' });
    return { tenantId, consoleUrl: ctx.config.publicUrl, email: a.email };
  });

  // ------------------------------------------------------------------------------------------- Stripe
  async function stripeCustomer(a: AccountRow): Promise<string> {
    if (a.stripe_customer_id) return a.stripe_customer_id;
    const c = await requireStripe(cloud).createCustomer({ email: a.email, name: a.name, metadata: { fbrx_account: a.id } });
    ctx.db.run('UPDATE accounts SET stripe_customer_id = ?, updated_at = ? WHERE id = ?', c.id, new Date().toISOString(), a.id);
    return c.id;
  }

  app.post('/v1/billing/checkout', { preHandler: auth, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const body = z.object({ productId: z.string().max(80) }).parse(req.body);
    const product = personalProduct(body.productId);
    const a = req.account!;
    const s = requireStripe(cloud);
    const now = accountTier(ctx, a.id).tier;
    if (atLeast(now, product.tier)) throw conflict(`Your FBRX account already has ${TIER_SHORT[now]}`);
    if (accountEntitlements(ctx, a.id).some((e) => e.source === 'stripe' && e.kind === 'edition' && !e.tenant_id && isValid(e))) {
      throw conflict('You already have a plan: change it in Manage billing');
    }
    const session = await s.checkout({
      customer: await stripeCustomer(a),
      items: [{ productId: body.productId, quantity: 1 }],
      successUrl: `${cloud.returnUrl}?checkout=done&session={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${cloud.returnUrl}?checkout=canceled`,
      reference: a.id,
      metadata: { fbrx_account: a.id },
    });
    ctx.audit.record(accountActor(a, req), 'billing.checkout', { type: 'account', id: a.id }, { productId: body.productId, tier: product.tier });
    return { url: session.url, id: session.id };
  });

  app.post('/v1/billing/portal', { preHandler: auth }, async (req) => {
    const a = req.account!;
    if (!a.stripe_customer_id) throw badRequest('Nothing was bought with this account on the website or a computer yet');
    const p = await requireStripe(cloud).portal({ customer: a.stripe_customer_id, returnUrl: cloud.returnUrl });
    return { url: p.url };
  });

  /** Brings one Stripe subscription's items into the entitlements (an account's, or an organization's). */
  async function syncStripeSubscription(sub: StripeSubscription) {
    const meta = sub.metadata ?? {};
    const accountId = meta.fbrx_account ?? ctx.db.get<{ id: string }>('SELECT id FROM accounts WHERE stripe_customer_id = ?', sub.customer)?.id ?? null;
    const tenantId = meta.fbrx_tenant ?? ctx.db.get<{ id: string }>('SELECT id FROM tenants WHERE stripe_customer_id = ?', sub.customer)?.id ?? null;
    const status = stripeStatus(sub.status);
    const items = subscriptionItems(sub);
    for (const i of items) recordPurchase(ctx, { source: 'stripe', externalId: sub.id, productId: i.productId, status, periodEnd: i.periodEnd, quantity: i.quantity, accountId: tenantId ? null : accountId, tenantId });
    endPurchase(ctx, 'stripe', sub.id, items.map((i) => i.productId));
    // An organization's plan: its license follows, and (once it starts) its computers are counted in.
    if (tenantId) {
      syncTenantLicense(ctx, tenantId);
      scheduleSeatSync(ctx, stripe, tenantId, 0);
    }
  }

  // The webhook is signed over the exact bytes Stripe sent, so this route keeps the raw body.
  await app.register(async (scoped) => {
    scoped.removeContentTypeParser('application/json');
    scoped.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
      (req as FastifyRequest).rawBody = body as string;
      try {
        done(null, JSON.parse(body as string));
      } catch (e) {
        done(e as Error, undefined);
      }
    });
    scoped.post('/v1/billing/stripe/webhook', async (req, reply) => {
      const s = requireStripe(cloud);
      let event: StripeEvent;
      try {
        event = s.verifyWebhook(req.rawBody ?? '', req.headers['stripe-signature'] as string | undefined);
      } catch (e) {
        return reply.status(400).send({ error: { code: 'INVALID_SIGNATURE', message: (e as Error).message } });
      }
      if (handledBefore(ctx, 'stripe', event.id)) return { received: true, duplicate: true };
      const o = event.data.object;
      if (event.type.startsWith('customer.subscription.')) await syncStripeSubscription(o as StripeSubscription);
      else if (event.type === 'checkout.session.completed' && o.mode === 'subscription' && typeof o.subscription === 'string') {
        await syncStripeSubscription(await s.subscription(o.subscription));
      } else if (event.type.startsWith('invoice.')) {
        const subId = typeof o.subscription === 'string' ? o.subscription : o.parent?.subscription_details?.subscription;
        if (typeof subId === 'string') await syncStripeSubscription(await s.subscription(subId));
      }
      markHandled(ctx, 'stripe', event.id, event.type);
      return { received: true };
    });
  });

  /** A store purchase recorded for another account is not this one's to claim. */
  const assertNotOthers = (source: 'apple' | 'google', externalId: string, accountId: string) => {
    const owner = purchaseOwner(ctx, source, externalId);
    if (owner && owner !== accountId) throw forbidden('That purchase belongs to another FBRX account');
  };

  // ------------------------------------------------------------------------------------------- App Store
  const needApple = () => {
    if (!cloud.apple) throw new HttpError(503, 'App Store purchases are not set up on this FBRX Command', 'UNAVAILABLE');
    return cloud.apple;
  };
  const verifyApple = <T>(jws: string): T => verifyAppleJws<T>(jws, needApple());

  /** The iPhone or iPad app sends the transaction StoreKit gave it after a purchase (or a restore). */
  app.post('/v1/billing/apple/transactions', { preHandler: auth }, async (req) => {
    const body = z.object({ signedTransaction: z.string().max(20_000) }).parse(req.body);
    const t = verifyApple<AppleTransaction>(body.signedTransaction);
    const a = req.account!;
    if (t.bundleId !== needApple().bundleId) throw badRequest('That purchase is for another app');
    if (appleTestPurchase(t.environment) && !needApple().allowSandbox) throw badRequest(TEST_PURCHASE);
    personalProduct(t.productId);
    if (t.appAccountToken && t.appAccountToken.toLowerCase() !== a.app_account_token.toLowerCase()) throw forbidden('That purchase belongs to another FBRX account');
    assertNotOthers('apple', t.originalTransactionId, a.id);
    const { status, periodEnd } = appleStatus(t);
    recordPurchase(ctx, { source: 'apple', externalId: t.originalTransactionId, productId: t.productId, status, periodEnd, accountId: a.id });
    return accountView(ctx, a);
  });

  /** App Store Server Notifications V2 (set this URL in App Store Connect). */
  app.post('/v1/billing/apple/notifications', async (req) => {
    const body = z.object({ signedPayload: z.string().max(100_000) }).parse(req.body);
    const n = verifyApple<AppleNotification>(body.signedPayload);
    if (handledBefore(ctx, 'apple', n.notificationUUID)) return { received: true, duplicate: true };
    if (n.data?.bundleId && n.data.bundleId !== needApple().bundleId) throw badRequest('That notification is for another app');
    if (appleTestPurchase(n.data?.environment) && !needApple().allowSandbox) {
      markHandled(ctx, 'apple', n.notificationUUID, `${n.notificationType} (test)`);
      return { received: true };
    }
    if (n.data?.signedTransactionInfo) {
      const t = verifyApple<AppleTransaction>(n.data.signedTransactionInfo);
      const renewal = n.data.signedRenewalInfo ? verifyApple<AppleRenewal>(n.data.signedRenewalInfo) : undefined;
      const product = productById(t.productId);
      if (product) {
        const accountId =
          purchaseOwner(ctx, 'apple', t.originalTransactionId) ??
          (t.appAccountToken ? ctx.db.get<{ id: string }>('SELECT id FROM accounts WHERE app_account_token = ? COLLATE NOCASE', t.appAccountToken)?.id : null) ??
          null;
        const { status, periodEnd } = appleStatus(t, { type: n.notificationType, subtype: n.subtype }, renewal);
        recordPurchase(ctx, { source: 'apple', externalId: t.originalTransactionId, productId: t.productId, status, periodEnd, accountId });
      }
    }
    markHandled(ctx, 'apple', n.notificationUUID, n.notificationType);
    return { received: true };
  });

  // ------------------------------------------------------------------------------------------- Google Play
  const needPlay = () => {
    if (!play) throw new HttpError(503, 'Google Play purchases are not set up on this FBRX Command', 'UNAVAILABLE');
    return play;
  };

  /** Records a Play subscription (and ends the one it replaced, after an upgrade or a downgrade). */
  async function syncPlay(purchaseToken: string, sub: PlaySubscription, accountId: string | null) {
    const status = playStatus(sub.subscriptionState);
    if (sub.linkedPurchaseToken) endPurchase(ctx, 'google', sub.linkedPurchaseToken);
    const known = sub.lineItems.filter((i) => productById(i.productId));
    for (const i of known) {
      recordPurchase(ctx, { source: 'google', externalId: purchaseToken, productId: i.productId, status, periodEnd: i.expiryTime ?? null, accountId });
      if (sub.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING' && (status === 'active' || status === 'grace')) await needPlay().acknowledge(i.productId, purchaseToken);
    }
  }

  /** The Android app sends the purchase token Play Billing gave it. */
  app.post('/v1/billing/google/purchases', { preHandler: auth }, async (req) => {
    const body = z.object({ productId: z.string().max(80), purchaseToken: z.string().min(10).max(4000) }).parse(req.body);
    personalProduct(body.productId);
    const a = req.account!;
    const sub = await needPlay().subscription(body.purchaseToken);
    if (!sub.lineItems.some((i) => i.productId === body.productId)) throw badRequest('That purchase is for another product');
    if (sub.testPurchase && !cloud.google!.allowTest) throw badRequest(TEST_PURCHASE);
    const external = sub.externalAccountIdentifiers?.obfuscatedExternalAccountId;
    if (external && external !== a.id) throw forbidden('That purchase belongs to another FBRX account');
    assertNotOthers('google', body.purchaseToken, a.id);
    await syncPlay(body.purchaseToken, sub, a.id);
    return accountView(ctx, a);
  });

  /** Real-time developer notifications, pushed by Cloud Pub/Sub to …/rtdn?token=<FBRX_GOOGLE_RTDN_TOKEN>. */
  app.post('/v1/billing/google/rtdn', async (req, reply) => {
    const p = needPlay();
    const token = String((req.query as Record<string, string>)?.token ?? '');
    if (!safeEqual(token, cloud.google!.rtdnToken)) return reply.status(403).send({ error: { code: 'FORBIDDEN', message: 'Wrong token' } });
    const body = z.object({ message: z.object({ data: z.string(), messageId: z.string().optional(), message_id: z.string().optional() }) }).parse(req.body);
    const messageId = body.message.messageId ?? body.message.message_id ?? '';
    if (messageId && handledBefore(ctx, 'google', messageId)) return { received: true, duplicate: true };
    const data = JSON.parse(Buffer.from(body.message.data, 'base64').toString('utf8')) as { packageName?: string; subscriptionNotification?: { notificationType: number; purchaseToken: string; subscriptionId?: string } };
    if (data.packageName && data.packageName !== cloud.google!.packageName) throw badRequest('That notification is for another app');
    const n = data.subscriptionNotification;
    if (n) {
      // Never what the notification says: what Play says about the purchase now.
      const sub = await p.subscription(n.purchaseToken);
      if (sub.testPurchase && !cloud.google!.allowTest) {
        if (messageId) markHandled(ctx, 'google', messageId, `subscription.${n.notificationType} (test)`);
        return { received: true };
      }
      const accountId =
        purchaseOwner(ctx, 'google', n.purchaseToken) ??
        ctx.db.get<{ id: string }>('SELECT id FROM accounts WHERE id = ?', sub.externalAccountIdentifiers?.obfuscatedExternalAccountId ?? '')?.id ??
        null;
      await syncPlay(n.purchaseToken, sub, accountId);
    }
    if (messageId) markHandled(ctx, 'google', messageId, n ? `subscription.${n.notificationType}` : 'other');
    return { received: true };
  });

  // ------------------------------------------------------------------------------------------- the platform operator
  await app.register(async (admin) => {
    admin.addHook('preHandler', adminAuth(ctx));

    // An organization's members: FBRX accounts it gives an edition to. They sign in on any computer and it joins the
    // organization at that edition (Essentials members cost nothing).
    const memberView = (tenantId: string, r: { account_id: string; email: string; name: string; tier: Tier; created_at: string }): MemberView => ({
      accountId: r.account_id,
      email: r.email,
      name: r.name,
      tier: r.tier,
      devices: Number(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM devices WHERE tenant_id = ? AND account_id = ? AND status = 'active'", tenantId, r.account_id)?.n ?? 0),
      createdAt: r.created_at,
    });
    const members = (tenantId: string) =>
      ctx.db.all<{ account_id: string; email: string; name: string; tier: Tier; created_at: string }>('SELECT m.account_id, a.email, a.name, m.tier, m.created_at FROM tenant_members m JOIN accounts a ON a.id = m.account_id WHERE m.tenant_id = ? ORDER BY a.name', tenantId);
    admin.get('/v1/admin/members', async (req) => {
      requirePerm(req, 'users.manage');
      const tenantId = requireTenant(req);
      return members(tenantId).map((r) => memberView(tenantId, r));
    });
    admin.post('/v1/admin/members', async (req) => {
      const p = requirePerm(req, 'users.manage');
      const tenantId = requireTenant(req);
      const body = z.object({ email: z.string().email(), tier: z.enum(TIERS).default('essentials') }).parse(req.body);
      const a = ctx.db.get<AccountRow>('SELECT * FROM accounts WHERE email = ?', body.email.trim());
      if (!a) throw notFound('There is no FBRX account with that email yet: ask them to make one, then add them');
      if (ctx.db.get('SELECT 1 FROM tenant_members WHERE tenant_id = ? AND account_id = ?', tenantId, a.id)) throw conflict(`${a.email} is already a member`);
      ctx.db.run('INSERT INTO tenant_members (tenant_id, account_id, tier, created_at) VALUES (?,?,?,?)', tenantId, a.id, body.tier, new Date().toISOString());
      ctx.audit.record({ type: 'user', id: p.id, label: p.label, tenantId, ip: req.ip }, 'member.added', { type: 'account', id: a.id, tenantId }, { tier: body.tier });
      return memberView(tenantId, members(tenantId).find((m) => m.account_id === a.id)!);
    });
    /** Changes a member's edition, on the computers they already joined too. */
    admin.patch('/v1/admin/members/:accountId', async (req) => {
      const p = requirePerm(req, 'users.manage');
      const tenantId = requireTenant(req);
      const accountId = (req.params as { accountId: string }).accountId;
      const body = z.object({ tier: z.enum(TIERS) }).parse(req.body);
      if (!ctx.db.get('SELECT 1 FROM tenant_members WHERE tenant_id = ? AND account_id = ?', tenantId, accountId)) throw notFound('No such member');
      ctx.db.run('UPDATE tenant_members SET tier = ? WHERE tenant_id = ? AND account_id = ?', body.tier, tenantId, accountId);
      ctx.db.run('UPDATE devices SET tier = ? WHERE tenant_id = ? AND account_id = ?', body.tier, tenantId, accountId);
      ctx.bumpConfig(tenantId);
      ctx.audit.record({ type: 'user', id: p.id, label: p.label, tenantId, ip: req.ip }, 'member.updated', { type: 'account', id: accountId, tenantId }, body);
      return memberView(tenantId, members(tenantId).find((m) => m.account_id === accountId)!);
    });
    admin.delete('/v1/admin/members/:accountId', async (req) => {
      const p = requirePerm(req, 'users.manage');
      const tenantId = requireTenant(req);
      const accountId = (req.params as { accountId: string }).accountId;
      ctx.db.run('DELETE FROM tenant_members WHERE tenant_id = ? AND account_id = ?', tenantId, accountId);
      // Their computers stay in the organization, on Essentials, until someone removes them.
      ctx.db.run("UPDATE devices SET tier = 'essentials' WHERE tenant_id = ? AND account_id = ?", tenantId, accountId);
      ctx.bumpConfig(tenantId);
      ctx.audit.record({ type: 'user', id: p.id, label: p.label, tenantId, ip: req.ip }, 'member.removed', { type: 'account', id: accountId, tenantId });
      return { ok: true };
    });

    admin.get('/v1/admin/accounts', async (req) => {
      requirePerm(req, 'tenants.manage');
      const q = String((req.query as Record<string, string>)?.q ?? '').trim();
      const rows = q ? ctx.db.all<AccountRow>('SELECT * FROM accounts WHERE email LIKE ? OR name LIKE ? ORDER BY created_at DESC LIMIT 200', `%${q}%`, `%${q}%`) : ctx.db.all<AccountRow>('SELECT * FROM accounts ORDER BY created_at DESC LIMIT 200');
      return rows.map((a) => ({ ...accountView(ctx, a), status: a.status }));
    });
    /** Gives an account an edition (support, a promotion), for a number of days or with no end. */
    admin.post('/v1/admin/accounts/:id/grant', async (req) => {
      const p = requirePerm(req, 'tenants.manage');
      const body = z.object({ tier: z.enum(['basic', 'ultra']), days: z.number().int().min(1).max(3650).nullable().default(30) }).parse(req.body);
      const a = ctx.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', (req.params as { id: string }).id);
      if (!a) throw notFound('No such account');
      recordPurchase(ctx, {
        source: 'grant',
        externalId: `grant_${randomUUID()}`,
        productId: EDITION_PLANS[body.tier].productId!,
        status: 'active',
        periodEnd: body.days ? new Date(Date.now() + body.days * 86_400_000).toISOString() : null,
        accountId: a.id,
      });
      ctx.audit.record({ type: 'user', id: p.id, label: p.label, tenantId: null, ip: req.ip }, 'account.granted', { type: 'account', id: a.id }, body);
      return accountView(ctx, a);
    });
    admin.post('/v1/admin/accounts/:id/status', async (req) => {
      const p = requirePerm(req, 'tenants.manage');
      const body = z.object({ status: z.enum(['active', 'disabled']) }).parse(req.body);
      const a = ctx.db.get<AccountRow>('SELECT * FROM accounts WHERE id = ?', (req.params as { id: string }).id);
      if (!a) throw notFound('No such account');
      ctx.db.run('UPDATE accounts SET status = ?, updated_at = ? WHERE id = ?', body.status, new Date().toISOString(), a.id);
      if (body.status === 'disabled') ctx.db.run('UPDATE account_sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL', new Date().toISOString(), a.id);
      ctx.audit.record({ type: 'user', id: p.id, label: p.label, tenantId: null, ip: req.ip }, `account.${body.status}`, { type: 'account', id: a.id });
      return { ok: true };
    });
  });
}
