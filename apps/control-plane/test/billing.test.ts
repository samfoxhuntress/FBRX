import { createHmac, generateKeyPairSync } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { licenseStatusFrom } from '@fbrx/shared/node';
import { buildServer, type BuiltServer } from '../src/server';
import { accountLicense } from '../src/billing/entitlements';
import { loadConfig } from '../src/config';
import { appleLikeChain, signJws } from './cert-chain';

const PASSWORD = 'A-long-enough-password-1';
const WEBHOOK_SECRET = 'whsec_test_secret';
const RTDN_TOKEN = 'rtdn-secret-token';

const readBody = (req: IncomingMessage) => new Promise<string>((r) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => r(b));
});
const listen = (s: Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

/**
 * Just enough of Stripe: prices by lookup key (each $4 a month until a new one takes its key), products, customers,
 * Checkout, subscriptions with their items and discounts, coupons.
 */
function fakeStripe() {
  const calls: Array<{ method: string; path: string; body: string }> = [];
  const subscriptions = new Map<string, any>();
  const coupons = new Map<string, any>();
  /** The price under each lookup key that has a new one. */
  const prices = new Map<string, { id: string; unit_amount: number; product: string; recurring: { interval: string } }>();
  const priceFor = (key: string) => prices.get(key) ?? { id: `price_${key}`, unit_amount: 400, product: `prod_${key}`, recurring: { interval: 'month' } };
  /** The lookup key a price has (none once a newer price took it). */
  const keyOf = (priceId: string) => {
    for (const [key, p] of prices) if (p.id === priceId) return key;
    const key = priceId.replace(/^price_/, '');
    return !prices.has(key) && `price_${key}` === priceId ? key : null;
  };
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    const url = new URL(req.url!, 'http://x');
    const f = new URLSearchParams(body);
    calls.push({ method: req.method!, path: url.pathname, body: body || url.search });
    const json = (o: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    if (req.headers.authorization !== 'Bearer sk_test_123') return json({ error: { message: 'bad key' } }, 401);
    if (url.pathname === '/v1/prices' && req.method === 'GET') {
      const key = url.searchParams.get('lookup_keys[]')!;
      return json({ data: [{ ...priceFor(key), lookup_key: key }] });
    }
    if (url.pathname === '/v1/prices' && req.method === 'POST') {
      const key = f.get('lookup_key')!;
      const price = { id: `price_${key}_${prices.size + 1}`, unit_amount: Number(f.get('unit_amount')), product: f.get('product')!, recurring: { interval: f.get('recurring[interval]')! } };
      if (f.get('transfer_lookup_key') !== 'true') return json({ error: { message: 'lookup key in use' } }, 400);
      prices.set(key, price);
      return json(price);
    }
    if (url.pathname === '/v1/products') return json({ id: `prod_new_${f.get('metadata[fbrx_product]')}` });
    if (url.pathname === '/v1/coupons') {
      if (coupons.has(f.get('id')!)) return json({ error: { message: 'Coupon already exists.' } }, 400);
      coupons.set(f.get('id')!, Object.fromEntries(f));
      return json({ id: f.get('id') });
    }
    if (url.pathname === '/v1/customers') return json({ id: 'cus_1' });
    if (url.pathname === '/v1/checkout/sessions') return json({ id: 'cs_1', url: 'https://checkout.example/cs_1' });
    if (url.pathname === '/v1/billing_portal/sessions') return json({ url: 'https://billing.example/portal' });
    if (url.pathname === '/v1/subscription_items' && req.method === 'POST') {
      const sub = subscriptions.get(f.get('subscription')!);
      const item = { id: `si_${sub.items.data.length + 1}`, quantity: Number(f.get('quantity')), price: { id: f.get('price'), lookup_key: keyOf(f.get('price')!) } };
      sub.items.data.push(item);
      return json(item);
    }
    const si = /^\/v1\/subscription_items\/(.+)$/.exec(url.pathname);
    if (si && req.method === 'POST') {
      for (const sub of subscriptions.values())
        for (const i of sub.items.data)
          if (i.id === si[1]) {
            i.quantity = Number(f.get('quantity'));
            if (f.get('price')) i.price = { id: f.get('price'), lookup_key: keyOf(f.get('price')!) };
          }
      return json({ id: si[1] });
    }
    const m = /^\/v1\/subscriptions\/(.+)$/.exec(url.pathname);
    if (m && req.method === 'GET') return json(subscriptions.get(m[1]!));
    if (m && req.method === 'POST') {
      const sub = subscriptions.get(m[1]!);
      const before: any[] = sub.discounts ?? [];
      sub.discounts = [];
      for (let i = 0; f.has(`discounts[${i}][coupon]`) || f.has(`discounts[${i}][discount]`); i++) {
        const coupon = f.get(`discounts[${i}][coupon]`);
        sub.discounts.push(coupon ? { id: `di_${coupon}`, source: { coupon, type: 'coupon' } } : before.find((d) => d.id === f.get(`discounts[${i}][discount]`)));
      }
      return json(sub);
    }
    if (m && req.method === 'DELETE') return json({ id: m[1], status: 'canceled' });
    json({ error: { message: `no route ${url.pathname}` } }, 404);
  });
  return { server, calls, subscriptions, coupons, prices };
}

/** Just enough of Google: the OAuth token endpoint and purchases.subscriptionsv2. */
function fakeGoogle() {
  const purchases = new Map<string, any>();
  const acknowledged: string[] = [];
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    const json = (o: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    if (req.url === '/token') return new URLSearchParams(body).get('assertion') ? json({ access_token: 'ya29.test', expires_in: 3600 }) : json({ error: 'invalid_grant' }, 400);
    if (req.headers.authorization !== 'Bearer ya29.test') return json({ error: { message: 'unauthenticated' } }, 401);
    const get = /\/applications\/com\.fbrx\.app\/purchases\/subscriptionsv2\/tokens\/(.+)$/.exec(req.url!);
    if (get) return purchases.has(get[1]!) ? json(purchases.get(get[1]!)) : json({ error: { message: 'not found' } }, 404);
    const ack = /\/purchases\/subscriptions\/(.+)\/tokens\/(.+):acknowledge$/.exec(req.url!);
    if (ack) {
      acknowledged.push(decodeURIComponent(ack[2]!));
      return json({});
    }
    json({ error: { message: 'no route' } }, 404);
  });
  return { server, purchases, acknowledged };
}

describe('FBRX accounts and what they buy', () => {
  let cp: BuiltServer;
  let base: string;
  let dataDir: string;
  /** Each test calls from an address of its own, so the routes' rate limits count each test on its own. */
  let client = 0;
  const stripe = fakeStripe();
  const google = fakeGoogle();
  const chain = appleLikeChain();

  const call = async (method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'x-forwarded-for': `198.51.100.${client}`,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
  };
  const ok = async (method: string, path: string, body?: unknown, token?: string) => {
    const r = await call(method, path, body, token);
    if (r.status >= 400) throw new Error(`${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  };
  /** The token in the newest link of a kind FBRX emailed to `to` (email is not set up here, so it is kept). */
  const linkFor = (to: string, kind: 'verify' | 'reset') => {
    const m = cp.ctx.mail.kept.filter((x) => x.to === to).at(-1);
    return decodeURIComponent(new RegExp(`#${kind}=(\\S+)`).exec(m?.text ?? '')?.[1] ?? '');
  };
  const stripeEvent = (event: object, secret = WEBHOOK_SECRET) => {
    const body = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    return call('POST', '/v1/billing/stripe/webhook', body, undefined, { 'stripe-signature': `t=${t},v1=${sig}` });
  };

  beforeAll(async () => {
    const stripeUrl = await listen(stripe.server);
    const googleUrl = await listen(google.server);
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    dataDir = mkdtempSync(join(tmpdir(), 'fbrx-billing-'));
    cp = await buildServer(
      loadConfig(
        {},
        {
          dataDir,
          port: 0,
          host: '127.0.0.1',
          trustProxy: true,
          logLevel: 'silent',
          setupToken: 'setup-token-123',
          adminConsoleDir: null,
          cloud: {
            publicSignup: true,
            returnUrl: 'https://fbrx.example/account',
            websiteOrigins: ['https://fbrx.example'],
            stripe: { secretKey: 'sk_test_123', webhookSecret: WEBHOOK_SECRET, apiBase: stripeUrl },
            apple: { bundleId: 'com.fbrx.app', rootCertificates: [chain.root.pem], allowSandbox: false },
            google: {
              packageName: 'com.fbrx.app',
              serviceAccount: { clientEmail: 'play@fbrx.iam.example', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), tokenUri: `${googleUrl}/token` },
              rtdnToken: RTDN_TOKEN,
              apiBase: googleUrl,
              allowTest: false,
            },
            mail: null,
            ai: null,
          },
        },
      ),
    );
    await cp.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(cp.app.server.address() as AddressInfo).port}`;
  });
  beforeEach(() => {
    client++;
  });

  afterAll(async () => {
    await cp.close();
    stripe.server.close();
    google.server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('lets the website (its own origin) call the account API, and nothing else', async () => {
    const pre = await fetch(`${base}/v1/accounts/login`, { method: 'OPTIONS', headers: { origin: 'https://fbrx.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://fbrx.example');
    expect((await fetch(`${base}/v1/plans`, { headers: { origin: 'https://fbrx.example' } })).headers.get('access-control-allow-origin')).toBe('https://fbrx.example');
    expect((await fetch(`${base}/v1/plans`, { headers: { origin: 'https://evil.example' } })).headers.get('access-control-allow-origin')).toBeNull();
    expect((await fetch(`${base}/v1/admin/devices`, { headers: { origin: 'https://fbrx.example' } })).headers.get('access-control-allow-origin')).toBeNull();
  });

  it('publishes the price list and the ways to pay', async () => {
    const plans = await ok('GET', '/v1/plans');
    expect(plans).toMatchObject({ publicSignup: true, payments: { stripe: true, apple: true, google: true }, command: { monthly: 5499 }, server: { available: false, price: 10000 } });
    expect(plans.editions.ultra).toMatchObject({ monthly: 1199, tenantMonthly: 959, productId: 'fbrx_ultra_monthly' });
  });

  it('makes an account, signs in, and signs computers up to nothing until something is bought', async () => {
    const made = await ok('POST', '/v1/accounts/signup', { email: 'sam@example.com', name: 'Sam', password: PASSWORD, device: 'sam-laptop' });
    expect(made.account).toMatchObject({ email: 'sam@example.com', tier: 'essentials', entitlements: [] });
    expect((await call('POST', '/v1/accounts/signup', { email: 'SAM@example.com', name: 'Sam', password: PASSWORD })).status).toBe(409);
    expect((await call('POST', '/v1/accounts/login', { email: 'sam@example.com', password: 'nope-nope-nope' })).status).toBe(401);
    const { token } = await ok('POST', '/v1/accounts/login', { email: 'sam@example.com', password: PASSWORD, device: 'sam-phone' });
    expect(await ok('GET', '/v1/accounts/license', undefined, token)).toEqual({ key: null, tier: 'essentials', expiresAt: null, computers: null, note: null });
    // An account token is not an FBRX Command console session.
    expect((await call('GET', '/v1/admin/devices', undefined, token)).status).toBe(401);
    expect((await call('GET', '/v1/accounts/me')).status).toBe(401);
  });

  it('confirms the email, resets a forgotten password, and lists and signs out where the account is signed in', async () => {
    const email = 'rae@example.com';
    const desk = { name: 'rae-desk', kind: 'computer', platform: 'Windows', appVersion: '2.0.0', installId: 'inst-1' };
    const made = await ok('POST', '/v1/accounts/signup', { email, name: 'Rae', password: PASSWORD, device: desk });
    expect(made.account.emailVerified).toBe(false);
    // The link FBRX emailed confirms the address, once.
    const verify = linkFor(email, 'verify');
    expect(verify).toMatch(/^fbrx_ver/);
    await ok('POST', '/v1/accounts/verify', { token: verify });
    expect((await call('POST', '/v1/accounts/verify', { token: verify })).status).toBe(400);
    expect((await ok('GET', '/v1/accounts/me', undefined, made.token)).emailVerified).toBe(true);

    // The same computer signing in again takes the place of its last sign-in; a phone adds one.
    const desk2 = await ok('POST', '/v1/accounts/login', { email, password: PASSWORD, device: desk });
    expect((await call('GET', '/v1/accounts/me', undefined, made.token)).status).toBe(401);
    const phone = await ok('POST', '/v1/accounts/login', { email, password: PASSWORD, device: { name: 'iPhone or iPad app', kind: 'phone', platform: 'iOS' } });
    const list = await ok('GET', '/v1/accounts/sessions', undefined, desk2.token);
    expect(list).toHaveLength(2);
    expect(list).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'rae-desk', kind: 'computer', platform: 'Windows', appVersion: '2.0.0', current: true }), expect.objectContaining({ kind: 'phone', current: false })]));
    // Signed out from the computer, the phone's token stops working.
    const onPhone = list.find((d: any) => d.kind === 'phone');
    await ok('DELETE', `/v1/accounts/sessions/${onPhone.id}`, undefined, desk2.token);
    expect((await call('GET', '/v1/accounts/me', undefined, phone.token)).status).toBe(401);
    expect((await call('DELETE', `/v1/accounts/sessions/${onPhone.id}`, undefined, desk2.token)).status).toBe(404);

    // Forgot the password: the same answer for an unknown email; the link works once, and signs out everywhere.
    expect(await ok('POST', '/v1/accounts/password/forgot', { email: 'nobody@example.com' })).toEqual({ ok: true });
    await ok('POST', '/v1/accounts/password/forgot', { email: 'RAE@example.com' });
    const reset = linkFor(email, 'reset');
    expect(reset).toMatch(/^fbrx_rst/);
    expect((await call('POST', '/v1/accounts/password/reset', { token: reset, password: 'short' })).status).toBe(400);
    const NEW = 'A-brand-new-password-2';
    expect(await ok('POST', '/v1/accounts/password/reset', { token: reset, password: NEW })).toEqual({ ok: true, email });
    expect((await call('POST', '/v1/accounts/password/reset', { token: reset, password: 'A-third-password-33' })).status).toBe(400);
    expect((await call('GET', '/v1/accounts/me', undefined, desk2.token)).status).toBe(401);
    expect((await call('POST', '/v1/accounts/login', { email, password: PASSWORD })).status).toBe(401);
    await ok('POST', '/v1/accounts/login', { email, password: NEW });
  });

  it('sells Ultra with Stripe Checkout, follows the subscription by webhook, and signs a license up to Ultra', async () => {
    const { token } = await ok('POST', '/v1/accounts/login', { email: 'sam@example.com', password: PASSWORD });
    expect((await call('POST', '/v1/billing/checkout', { productId: 'fbrx_blackhole_tenant_monthly' }, token)).status).toBe(400);
    const checkout = await ok('POST', '/v1/billing/checkout', { productId: 'fbrx_ultra_monthly' }, token);
    expect(checkout.url).toBe('https://checkout.example/cs_1');
    const session = decodeURIComponent(stripe.calls.find((c) => c.path === '/v1/checkout/sessions')!.body);
    expect(session).toContain('line_items[0][price]=price_fbrx_ultra_monthly');
    expect(session).toContain('mode=subscription');
    expect(session).toMatch(/metadata\]\[fbrx_account\]=acc_/);

    const me = await ok('GET', '/v1/accounts/me', undefined, token);
    const end = Math.floor(Date.now() / 1000) + 30 * 86400;
    const sub = { id: 'sub_1', customer: 'cus_1', status: 'active', metadata: { fbrx_account: me.id }, items: { data: [{ id: 'si_1', quantity: 1, current_period_end: end, price: { id: 'price_x', lookup_key: 'fbrx_ultra_monthly' } }] } };
    // Only Stripe can send these.
    expect((await stripeEvent({ id: 'evt_0', type: 'customer.subscription.created', data: { object: sub } }, 'whsec_wrong')).status).toBe(400);
    expect((await stripeEvent({ id: 'evt_1', type: 'customer.subscription.created', data: { object: sub } })).json).toEqual({ received: true });
    expect((await stripeEvent({ id: 'evt_1', type: 'customer.subscription.created', data: { object: sub } })).json).toMatchObject({ duplicate: true });

    expect(await ok('GET', '/v1/accounts/me', undefined, token)).toMatchObject({ tier: 'ultra', billingPortal: true, entitlements: [{ productId: 'fbrx_ultra_monthly', source: 'stripe', status: 'active', valid: true }] });
    const lic = await ok('GET', '/v1/accounts/license', undefined, token);
    expect(lic.tier).toBe('ultra');
    // A real license for this computer: up to Ultra, no organization in it, a few days past the period paid for.
    const st = licenseStatusFrom(lic.key, [cp.ctx.keys.licensePublicPem], 'local', 2);
    expect(st).toMatchObject({ state: 'valid', tier: 'ultra', edition: 'pro', commandUrl: null, customer: 'Sam' });
    expect(Date.parse(st.expiresAt!) - end * 1000).toBeGreaterThan(2 * 86_400_000);
    expect((await call('POST', '/v1/billing/checkout', { productId: 'fbrx_standard_monthly' }, token)).status).toBe(409);

    // Payment failed: still counts while Stripe retries. Then it ends.
    await stripeEvent({ id: 'evt_2', type: 'customer.subscription.updated', data: { object: { ...sub, status: 'past_due' } } });
    expect((await ok('GET', '/v1/accounts/me', undefined, token)).tier).toBe('ultra');
    await stripeEvent({ id: 'evt_3', type: 'customer.subscription.deleted', data: { object: { ...sub, status: 'canceled' } } });
    expect((await ok('GET', '/v1/accounts/me', undefined, token)).tier).toBe('essentials');
    // Checkout finished: FBRX reads the subscription from Stripe.
    stripe.subscriptions.set('sub_2', { ...sub, id: 'sub_2', items: { data: [{ ...sub.items.data[0], price: { id: 'p', lookup_key: 'fbrx_standard_monthly' } }] } });
    await stripeEvent({ id: 'evt_4', type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: 'sub_2' } } });
    expect((await ok('GET', '/v1/accounts/me', undefined, token)).tier).toBe('basic');
    expect((await ok('POST', '/v1/billing/portal', {}, token)).url).toBe('https://billing.example/portal');
  });

  it('takes App Store purchases, checked against the Apple root, and follows the App Store notifications', async () => {
    const { token, account } = await ok('POST', '/v1/accounts/signup', { email: 'ios@example.com', name: 'Ira', password: PASSWORD });
    const appToken = cp.ctx.db.get<{ app_account_token: string }>('SELECT app_account_token FROM accounts WHERE id = ?', account.id)!.app_account_token;
    const tx = { bundleId: 'com.fbrx.app', productId: 'fbrx_ultra_monthly', transactionId: '2000001', originalTransactionId: '1000001', appAccountToken: appToken, expiresDate: Date.now() + 30 * 86_400_000 };
    // Bought in TestFlight or the sandbox: nothing was charged, so nothing turns on.
    expect((await call('POST', '/v1/billing/apple/transactions', { signedTransaction: signJws({ ...tx, environment: 'Sandbox' }, chain) }, token)).status).toBe(400);
    expect(await ok('POST', '/v1/billing/apple/transactions', { signedTransaction: signJws({ ...tx, environment: 'Production' }, chain) }, token)).toMatchObject({ tier: 'ultra' });
    // Signed by anyone else, or bought by another account: refused.
    expect((await call('POST', '/v1/billing/apple/transactions', { signedTransaction: signJws(tx, appleLikeChain()) }, token)).status).toBe(400);
    const tampered = signJws(tx, chain).split('.');
    tampered[1] = Buffer.from(JSON.stringify({ ...tx, productId: 'fbrx_ultra_monthly', expiresDate: Date.now() + 9e12 })).toString('base64url');
    expect((await call('POST', '/v1/billing/apple/transactions', { signedTransaction: tampered.join('.') }, token)).status).toBe(400);
    const other = await ok('POST', '/v1/accounts/signup', { email: 'thief@example.com', name: 'T', password: PASSWORD });
    expect((await call('POST', '/v1/billing/apple/transactions', { signedTransaction: signJws(tx, chain) }, other.token)).status).toBe(403);
    expect((await call('POST', '/v1/billing/apple/transactions', { signedTransaction: signJws({ ...tx, appAccountToken: undefined }, chain) }, other.token)).status).toBe(403);
    // A refund ends it.
    const refund = { notificationType: 'REFUND', notificationUUID: 'n-1', data: { bundleId: 'com.fbrx.app', signedTransactionInfo: signJws({ ...tx, revocationDate: Date.now() }, chain) } };
    expect(await ok('POST', '/v1/billing/apple/notifications', { signedPayload: signJws(refund, chain) })).toEqual({ received: true });
    expect((await ok('GET', '/v1/accounts/me', undefined, token)).tier).toBe('essentials');
  });

  it('takes Google Play purchases, acknowledges them, and follows Play notifications', async () => {
    const { token, account } = await ok('POST', '/v1/accounts/signup', { email: 'droid@example.com', name: 'Dee', password: PASSWORD });
    const purchase = { subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE', acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING', lineItems: [{ productId: 'fbrx_standard_monthly', expiryTime: new Date(Date.now() + 30 * 86_400_000).toISOString() }], externalAccountIdentifiers: { obfuscatedExternalAccountId: account.id } };
    google.purchases.set('tok-1-abcdef', purchase);
    expect(await ok('POST', '/v1/billing/google/purchases', { productId: 'fbrx_standard_monthly', purchaseToken: 'tok-1-abcdef' }, token)).toMatchObject({ tier: 'basic' });
    expect(google.acknowledged).toEqual(['tok-1-abcdef']);
    const other = await ok('POST', '/v1/accounts/signup', { email: 'droid2@example.com', name: 'E', password: PASSWORD });
    expect((await call('POST', '/v1/billing/google/purchases', { productId: 'fbrx_standard_monthly', purchaseToken: 'tok-1-abcdef' }, other.token)).status).toBe(403);
    // A license tester's purchase costs nothing: it turns nothing on.
    google.purchases.set('tok-test-abcdef', { ...purchase, testPurchase: {} });
    expect((await call('POST', '/v1/billing/google/purchases', { productId: 'fbrx_standard_monthly', purchaseToken: 'tok-test-abcdef' }, token)).status).toBe(400);

    const push = (data: object, t = RTDN_TOKEN, id = 'm-1') => call('POST', `/v1/billing/google/rtdn?token=${t}`, { message: { data: Buffer.from(JSON.stringify(data)).toString('base64'), messageId: id } });
    expect((await push({ packageName: 'com.fbrx.app' }, 'wrong')).status).toBe(403);
    google.purchases.set('tok-1-abcdef', { ...purchase, subscriptionState: 'SUBSCRIPTION_STATE_EXPIRED', acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' });
    // The notification says nothing about the state: FBRX asks Play.
    expect((await push({ packageName: 'com.fbrx.app', subscriptionNotification: { notificationType: 13, purchaseToken: 'tok-1-abcdef', subscriptionId: 'fbrx_standard_monthly' } })).json).toEqual({ received: true });
    expect((await ok('GET', '/v1/accounts/me', undefined, token)).tier).toBe('essentials');
  });

  it('runs an organization’s FBRX Command plan: each computer at its edition, Black Hole as an add-on, Essentials free', async () => {
    const owner = await ok('POST', '/v1/accounts/signup', { email: 'owner@river.example', name: 'Riv', password: PASSWORD });
    // An organization is started from a confirmed email.
    expect((await call('POST', '/v1/accounts/tenants', { name: 'River Design', kind: 'business' }, owner.token)).json.error.code).toBe('EMAIL_NOT_CONFIRMED');
    await ok('POST', '/v1/accounts/verify', { token: linkFor('owner@river.example', 'verify') });
    const t = await ok('POST', '/v1/accounts/tenants', { name: 'River Design', kind: 'business' }, owner.token);
    // The owner signs in to the console with the account's password.
    expect((await call('POST', '/v1/auth/login', { email: 'owner@river.example', password: 'not-the-password' })).status).toBe(401);
    const { token: admin, user } = await ok('POST', '/v1/auth/login', { email: 'owner@river.example', password: PASSWORD });
    expect(user).toMatchObject({ role: 'owner', tenantId: t.tenantId });
    expect((await ok('GET', '/v1/accounts/me', undefined, owner.token)).memberships).toEqual([{ tenantId: t.tenantId, tenantName: 'River Design', tier: 'essentials' }]);
    expect((await ok('GET', '/v1/admin/billing', undefined, admin)).plan).toMatchObject({ billing: 'cloud', active: false, monthly: 5499 });

    // Three computers join; one is given Ultra, one Black Hole.
    const { token: enroll } = await ok('POST', '/v1/admin/enrollment-tokens', { label: 'Everyone' }, admin);
    const devices: Array<{ deviceId: string; deviceToken: string }> = [];
    for (const n of [1, 2, 3]) {
      devices.push(await ok('POST', '/v1/enroll', { token: enroll, protocolVersion: 1, device: { name: `pc-${n}`, hostname: `pc-${n}`, platform: 'win32', arch: 'x64', osVersion: '11', appVersion: '2.0.0', machineId: `m-${n}` } }));
    }
    await ok('PATCH', `/v1/admin/devices/${devices[0]!.deviceId}`, { tier: 'ultra' }, admin);
    await ok('PATCH', `/v1/admin/devices/${devices[1]!.deviceId}`, { tier: 'blackhole' }, admin);
    const config = (i: number) => ok('GET', '/v1/device/config', undefined, devices[i]!.deviceToken);
    // No plan yet: every computer runs Essentials.
    expect((await config(1)).edition.tier).toBe('essentials');

    const checkout = await ok('POST', '/v1/admin/billing/checkout', {}, admin);
    expect(checkout.url).toBe('https://checkout.example/cs_1');
    const session = decodeURIComponent(stripe.calls.filter((c) => c.path === '/v1/checkout/sessions').at(-1)!.body);
    expect(session).toContain('line_items[0][price]=price_fbrx_command_tenant_monthly');
    expect(session).toContain(`metadata][fbrx_tenant]=${t.tenantId}`);

    const end = Math.floor(Date.now() / 1000) + 30 * 86400;
    stripe.subscriptions.set('sub_t', { id: 'sub_t', customer: 'cus_1', status: 'active', metadata: { fbrx_tenant: t.tenantId }, items: { data: [{ id: 'si_cmd', quantity: 1, current_period_end: end, price: { id: 'p', lookup_key: 'fbrx_command_tenant_monthly' } }] } });
    await stripeEvent({ id: 'evt_t1', type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: 'sub_t' } } });
    // The plan runs: the organization's license allows everything, each computer runs what it was given.
    expect((await config(0)).edition.tier).toBe('ultra');
    expect((await config(1)).edition.tier).toBe('blackhole');
    expect((await config(2)).edition.tier).toBe('essentials');
    const lic = licenseStatusFrom((await config(1)).license, [cp.ctx.keys.licensePublicPem], 'managed', 2);
    expect(lic).toMatchObject({ state: 'valid', tier: 'blackhole', edition: 'enterprise' });
    // The plan counts the computers by itself: Ultra at 20% off, Black Hole at full price, Essentials free.
    await new Promise((r) => setTimeout(r, 300));
    expect((await ok('POST', '/v1/admin/billing/sync', {}, admin)).plan).toMatchObject({ active: true, computers: { essentials: 1, basic: 0, ultra: 1, blackhole: 1 }, monthly: 5499 + 959 + 2499 });
    const items = stripe.subscriptions.get('sub_t').items.data.map((i: any) => `${i.price.lookup_key}=${i.quantity}`);
    expect(items.sort()).toEqual(['fbrx_blackhole_tenant_monthly=1', 'fbrx_command_tenant_monthly=1', 'fbrx_ultra_tenant_monthly=1']);
    await ok('PATCH', `/v1/admin/devices/${devices[2]!.deviceId}`, { tier: 'ultra' }, admin);
    expect((await ok('POST', '/v1/admin/billing/sync', {}, admin)).changed).toEqual(['fbrx_ultra_tenant_monthly=2']);
    // A computer still marked as a student's (from when this was a school) runs, and counts as, its own edition.
    cp.ctx.db.run("UPDATE devices SET audience = 'student' WHERE id = ?", devices[0]!.deviceId);
    expect((await config(0)).edition).toMatchObject({ audience: 'staff', tier: 'ultra' });
    expect((await ok('POST', '/v1/admin/billing/sync', {}, admin)).plan.computers).toMatchObject({ basic: 0, ultra: 2 });

    // The plan ends: the license goes, and the computers run Essentials.
    await stripeEvent({ id: 'evt_t2', type: 'customer.subscription.deleted', data: { object: { ...stripe.subscriptions.get('sub_t'), status: 'canceled' } } });
    expect((await config(1)).edition.tier).toBe('essentials');
    expect((await config(1)).license).toBeNull();
  });

  it('lets the platform operator give an edition, and people delete their account', async () => {
    const setup = await ok('POST', '/v1/setup', { setupToken: 'setup-token-123', organization: 'FBRX', name: 'Op', email: 'op@fbrx.example', password: PASSWORD });
    expect(setup.ok).toBe(true);
    const { token: admin } = await ok('POST', '/v1/auth/login', { email: 'op@fbrx.example', password: PASSWORD });
    const list = await ok('GET', '/v1/admin/accounts?q=droid@', undefined, admin);
    expect(list).toHaveLength(1);
    expect(await ok('POST', `/v1/admin/accounts/${list[0].id}/grant`, { tier: 'ultra', days: 14 }, admin)).toMatchObject({ tier: 'ultra' });

    const { token } = await ok('POST', '/v1/accounts/login', { email: 'sam@example.com', password: PASSWORD });
    expect((await call('DELETE', '/v1/accounts/me', { password: 'wrong-wrong-wrong' }, token)).status).toBe(401);
    expect(await ok('DELETE', '/v1/accounts/me', { password: PASSWORD }, token)).toMatchObject({ ok: true, note: null });
    expect(stripe.calls.some((c) => c.method === 'DELETE' && c.path === '/v1/subscriptions/sub_2')).toBe(true);
    expect((await call('GET', '/v1/accounts/me', undefined, token)).status).toBe(401);
  });

  it('sells the MDM add-on at the price the operator sets, the same for every computer whatever its edition', async () => {
    const { token: op } = await ok('POST', '/v1/auth/login', { email: 'op@fbrx.example', password: PASSWORD });
    // Not sold until the operator says so; Stripe's price under the add-on's lookup key is checked against it.
    expect(await ok('GET', '/v1/admin/pricing', undefined, op)).toMatchObject({ mdm: { available: false, perEndpoint: 400 }, stripe: { fbrx_mdm_tenant_monthly: { found: true, unitAmount: 400, interval: 'month' } } });
    expect((await ok('GET', '/v1/plans')).mdm).toEqual({ available: false, perEndpoint: 400 });
    expect((await call('POST', '/v1/admin/pricing', { mdm: { perEndpoint: 40_000 } }, op)).status).toBe(400);

    // An organization with two computers in a group managed with MDM: one runs Ultra, the other Essentials.
    const email = 'owner@lake.example';
    const owner = await ok('POST', '/v1/accounts/signup', { email, name: 'Lake', password: PASSWORD });
    await ok('POST', '/v1/accounts/verify', { token: linkFor(email, 'verify') });
    const t = await ok('POST', '/v1/accounts/tenants', { name: 'Lake Labs', kind: 'business' }, owner.token);
    const { token: admin } = await ok('POST', '/v1/auth/login', { email, password: PASSWORD });
    // Only the operator sets prices.
    expect((await call('POST', '/v1/admin/pricing', { mdm: { available: true } }, admin)).status).toBe(403);
    const group = await ok('POST', '/v1/admin/groups', { name: 'Managed', mdm: true }, admin);
    expect(group.mdm).toBe(true);
    const { token: enroll } = await ok('POST', '/v1/admin/enrollment-tokens', { label: 'Managed', groupId: group.id }, admin);
    const pcs: Array<{ deviceId: string }> = [];
    for (const n of [1, 2]) pcs.push(await ok('POST', '/v1/enroll', { token: enroll, protocolVersion: 1, device: { name: `lake-${n}`, hostname: `lake-${n}`, platform: 'win32', arch: 'x64', osVersion: '11', appVersion: '2.2.0', machineId: `lake-m-${n}` } }));
    await ok('PATCH', `/v1/admin/devices/${pcs[0]!.deviceId}`, { tier: 'ultra' }, admin);
    const end = Math.floor(Date.now() / 1000) + 30 * 86400;
    stripe.subscriptions.set('sub_m', { id: 'sub_m', customer: 'cus_1', status: 'active', metadata: { fbrx_tenant: t.tenantId }, items: { data: [{ id: 'si_mcmd', quantity: 1, current_period_end: end, price: { id: 'p', lookup_key: 'fbrx_command_tenant_monthly' } }] } });
    await stripeEvent({ id: 'evt_m1', type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: 'sub_m' } } });
    const items = () => stripe.subscriptions.get('sub_m').items.data.map((i: any) => `${i.price.lookup_key}=${i.quantity}`).sort();

    // Not sold yet: the computers are counted, nothing is charged for them.
    const before = (await ok('POST', '/v1/admin/billing/sync', {}, admin)).plan;
    expect(before).toMatchObject({ monthly: 5499 + 959, mdm: { available: false, perEndpoint: 400, managed: 2 } });
    expect(items()).not.toContain('fbrx_mdm_tenant_monthly=2');

    // The operator sells it at $3.50: both computers, Ultra and Essentials alike, at $3.50 each.
    await ok('POST', '/v1/admin/pricing', { mdm: { available: true, perEndpoint: 350 } }, op);
    expect((await ok('GET', '/v1/plans')).mdm).toEqual({ available: true, perEndpoint: 350 });
    expect((await ok('POST', '/v1/admin/billing/sync', {}, admin)).plan).toMatchObject({ monthly: 5499 + 959 + 2 * 350, mdm: { available: true, managed: 2 } });
    expect(items()).toContain('fbrx_mdm_tenant_monthly=2');
    // Stripe charges $4 while the operator asks $3.50: the Pricing page says so.
    expect((await ok('GET', '/v1/admin/pricing', undefined, op)).stripe.fbrx_mdm_tenant_monthly.unitAmount).toBe(400);

    // A computer leaves the group: one fewer. The operator stops selling it: none.
    await ok('PATCH', `/v1/admin/devices/${pcs[1]!.deviceId}`, { groupId: null }, admin);
    expect((await ok('POST', '/v1/admin/billing/sync', {}, admin)).changed).toEqual(['fbrx_mdm_tenant_monthly=1']);
    await ok('POST', '/v1/admin/pricing', { mdm: { available: false } }, op);
    const after = await ok('POST', '/v1/admin/billing/sync', {}, admin);
    expect(after.plan.monthly).toBe(5499 + 959);
    expect(items()).toContain('fbrx_mdm_tenant_monthly=0');
    // Every change of price is in the audit log.
    expect(cp.ctx.db.all<{ action: string }>("SELECT action FROM audit_log WHERE action = 'pricing.mdm'")).toHaveLength(2);
  });

  it('covers as many of a person’s computers as their edition includes, and the ones they add', async () => {
    const email = 'three@computers.example';
    const device = (n: number) => ({ name: `pc-${n}`, kind: 'computer', installId: `inst-${n}` });
    const t1 = (await ok('POST', '/v1/accounts/signup', { email, name: 'Three', password: PASSWORD, device: device(1) })).token as string;
    await ok('POST', '/v1/accounts/verify', { token: linkFor(email, 'verify') });
    const signIn = async (n: number) => (await ok('POST', '/v1/accounts/login', { email, password: PASSWORD, device: device(n) })).token as string;
    const [t2, t3] = [await signIn(2), await signIn(3)];
    const me = await ok('GET', '/v1/accounts/me', undefined, t1);
    // Standard, bought with Stripe.
    const end = Math.floor(Date.now() / 1000) + 30 * 86400;
    const sub = { id: 'sub_three', customer: 'cus_3', status: 'active', metadata: { fbrx_account: me.id }, items: { data: [{ id: 'si_three', quantity: 1, current_period_end: end, price: { id: 'price_three', lookup_key: 'fbrx_standard_monthly' } }] } };
    stripe.subscriptions.set('sub_three', sub);
    await stripeEvent({ id: 'evt_three', type: 'customer.subscription.created', data: { object: sub } });
    const license = (token: string) => ok('GET', '/v1/accounts/license', undefined, token);

    // Standard covers 2 computers: the first two to sign in get a key, each for its own computer only.
    const first = await license(t1);
    expect(first).toMatchObject({ tier: 'basic', note: null, computers: { used: 3, allowed: 2, included: 2, extra: 0, extraPrice: 199, canAdd: true } });
    expect(licenseStatusFrom(first.key, [cp.ctx.keys.licensePublicPem], 'account', 2, 'inst-1').state).toBe('valid');
    expect(licenseStatusFrom(first.key, [cp.ctx.keys.licensePublicPem], 'account', 2, 'inst-3').state).toBe('invalid');
    expect((await license(t2)).key).toBeTruthy();
    const third = await license(t3);
    expect(third).toMatchObject({ key: null, tier: 'basic' });
    expect(third.note).toBe('Your Standard covers 2 computers, and 3 are signed in: this one runs Essentials. Sign one of the others out, or add a computer for $1.99 a month.');
    // Signing in again from the same computer keeps its place.
    expect((await license(await signIn(1))).key).toBeTruthy();
    expect((await license(t3)).key).toBeNull();

    // A third computer, added to the Stripe plan: it gets its key.
    const added = await ok('POST', '/v1/billing/computers', { extra: 1 }, t3);
    expect(added).toMatchObject({ computers: { allowed: 3, extra: 1 }, note: null });
    expect(licenseStatusFrom(added.key, [cp.ctx.keys.licensePublicPem], 'account', 2, 'inst-3').state).toBe('valid');
    expect(stripe.subscriptions.get('sub_three').items.data.map((i: any) => `${i.price.lookup_key}=${i.quantity}`)).toContain('fbrx_standard_extra_computer_monthly=1');

    // Back to none: signing a computer out frees its place for the third.
    await ok('POST', '/v1/billing/computers', { extra: 0 }, t3);
    expect((await license(t3)).key).toBeNull();
    await ok('DELETE', `/v1/accounts/sessions/${(await ok('GET', '/v1/accounts/sessions', undefined, t3)).find((s: any) => s.name === 'pc-2').id}`, undefined, t3);
    expect((await license(t3)).key).toBeTruthy();
    // The computer signed out hears so, and gives its license back.
    expect(await call('GET', '/v1/accounts/license', undefined, t2)).toMatchObject({ status: 401, json: { error: { code: 'SIGNED_OUT' } } });
    // Without a computer's sign-in (the website, the phone app), no key: licenses go to computers.
    expect(accountLicense(cp.ctx, me, null)).toMatchObject({ key: null, note: 'A license goes to a computer: sign in to your FBRX account in FBRX on it.' });

    // A plan moved to Ultra in the Stripe portal takes its extra computer along, at Ultra's price.
    await ok('POST', '/v1/billing/computers', { extra: 1 }, t3);
    sub.items.data[0]!.price = { id: 'price_three_ultra', lookup_key: 'fbrx_ultra_monthly' };
    await stripeEvent({ id: 'evt_three_ultra', type: 'customer.subscription.updated', data: { object: sub } });
    expect(sub.items.data.map((i: any) => `${i.price.lookup_key}=${i.quantity}`)).toEqual(['fbrx_ultra_monthly=1', 'fbrx_ultra_extra_computer_monthly=1']);
    expect(await license(t3)).toMatchObject({ tier: 'ultra', computers: { allowed: 6, included: 5, extra: 1, extraPrice: 299 } });
  });

  it('bills organizations from the operator’s price list, and brings Stripe to it', async () => {
    const { token: op } = await ok('POST', '/v1/auth/login', { email: 'op@fbrx.example', password: PASSWORD });
    // Until the operator sets one, the price list is the one in plans.ts; Stripe charges $4 for everything here.
    const first = await ok('GET', '/v1/admin/pricing', undefined, op);
    expect(first.book).toMatchObject({ personal: { basic: 499, ultra: 1199 }, seats: { ultra: 959 }, volume: [], fees: { base: 5499, large: null, home: null } });
    expect(first.stripe.fbrx_ultra_tenant_monthly).toMatchObject({ found: true, unitAmount: 400 });

    const book = {
      personal: { basic: 1200, ultra: 2900 },
      seats: { basic: 1200, ultra: 2900, blackhole: 9900 },
      volume: [{ from: 2, percentOff: 10 }],
      fees: { base: 5000, large: { from: 3, monthly: 10000 }, home: 1499 },
    };
    // Volume steps go up; only the operator sets prices.
    expect((await call('POST', '/v1/admin/pricing', { book: { ...book, volume: [{ from: 5, percentOff: 10 }, { from: 3, percentOff: 20 }] } }, op)).status).toBe(400);
    await ok('POST', '/v1/admin/pricing', { book }, op);
    const plans = await ok('GET', '/v1/plans');
    // A price list without computers takes the prices in plans.ts for them: 2, 5 and 15 included.
    expect(plans.prices).toMatchObject({ ...book, computers: { included: { basic: 2, ultra: 5, blackhole: 15 } } });
    expect([plans.editions.ultra.monthly, plans.editions.ultra.tenantMonthly, plans.command.monthly]).toEqual([2900, 2900, 5000]);

    // A Work organization with two Ultra computers: the fee, and both computers 10% off.
    const email = 'owner@delta.example';
    const owner = await ok('POST', '/v1/accounts/signup', { email, name: 'Delta', password: PASSWORD });
    await ok('POST', '/v1/accounts/verify', { token: linkFor(email, 'verify') });
    const t = await ok('POST', '/v1/accounts/tenants', { name: 'Delta Co', kind: 'business' }, owner.token);
    const { token: admin } = await ok('POST', '/v1/auth/login', { email, password: PASSWORD });
    expect((await call('POST', '/v1/admin/pricing', { book }, admin)).status).toBe(403);
    const { token: enroll } = await ok('POST', '/v1/admin/enrollment-tokens', { label: 'All' }, admin);
    const pc = (n: number) => ok('POST', '/v1/enroll', { token: enroll, protocolVersion: 1, device: { name: `delta-${n}`, hostname: `delta-${n}`, platform: 'win32', arch: 'x64', osVersion: '11', appVersion: '2.2.0', machineId: `delta-m-${n}` } });
    for (const n of [1, 2]) await ok('PATCH', `/v1/admin/devices/${(await pc(n)).deviceId}`, { tier: 'ultra' }, admin);
    const end = Math.floor(Date.now() / 1000) + 30 * 86400;
    stripe.subscriptions.set('sub_r', { id: 'sub_r', customer: 'cus_1', status: 'active', metadata: { fbrx_tenant: t.tenantId }, items: { data: [{ id: 'si_rcmd', quantity: 1, current_period_end: end, price: { id: 'price_fbrx_command_tenant_monthly', lookup_key: 'fbrx_command_tenant_monthly' } }] } });
    await stripeEvent({ id: 'evt_r1', type: 'checkout.session.completed', data: { object: { mode: 'subscription', subscription: 'sub_r' } } });
    const items = () => stripe.subscriptions.get('sub_r').items.data.map((i: any) => `${i.price.lookup_key}=${i.quantity}`).sort();
    const coupon = () => stripe.subscriptions.get('sub_r').discounts?.map((d: any) => d.source.coupon) ?? [];

    let r = await ok('POST', '/v1/admin/billing/sync', {}, admin);
    expect(r.plan).toMatchObject({ monthly: 5000 + 5220, bill: { fee: 'base', paid: 2, percentOff: 10 } });
    expect(items()).toEqual(['fbrx_command_tenant_monthly=1', 'fbrx_ultra_tenant_monthly=2']);
    // Stripe takes the discount off the computers' prices only, with a coupon of FBRX Command's.
    expect(coupon()).toEqual([expect.stringMatching(/^fbrx_volume_10_/)]);
    expect(stripe.coupons.get(coupon()[0])).toMatchObject({ percent_off: '10', duration: 'forever', 'applies_to[products][]': 'prod_fbrx_ultra_tenant_monthly' });

    // A third computer (Essentials, free) makes it a larger organization: the larger fee takes the other's place.
    await pc(3);
    r = await ok('POST', '/v1/admin/billing/sync', {}, admin);
    expect(r.plan).toMatchObject({ monthly: 10000 + 5220, bill: { fee: 'large' } });
    expect(items()).toEqual(['fbrx_command_large_monthly=1', 'fbrx_command_tenant_monthly=0', 'fbrx_ultra_tenant_monthly=2']);
    expect(r.changed).toEqual(['fbrx_command_large_monthly=1', 'fbrx_command_tenant_monthly=0']);

    // Stripe charges $4 where the list says otherwise; Update Stripe gives each such price a new one under its key.
    const updated = await ok('POST', '/v1/admin/pricing/stripe', {}, op);
    expect(updated.created).toEqual(expect.arrayContaining(['fbrx_standard_monthly', 'fbrx_command_large_monthly', 'fbrx_ultra_tenant_monthly']));
    // The MDM add-on too: it has been $3.50 since the operator set it so.
    expect(updated.created).toContain('fbrx_mdm_tenant_monthly');
    expect(Object.values(updated.stripe).every((p: any) => p.found && p.interval === 'month')).toBe(true);
    expect(updated.stripe.fbrx_ultra_tenant_monthly.unitAmount).toBe(2900);
    expect(stripe.prices.get('fbrx_ultra_tenant_monthly')!.product).toBe('prod_fbrx_ultra_tenant_monthly');
    // The organization moves to the new prices at its next seat update: the same items, not new ones beside them.
    r = await ok('POST', '/v1/admin/billing/sync', {}, admin);
    expect(items()).toEqual(['fbrx_command_large_monthly=1', 'fbrx_command_tenant_monthly=0', 'fbrx_ultra_tenant_monthly=2']);
    expect(stripe.subscriptions.get('sub_r').items.data.find((i: any) => i.price.lookup_key === 'fbrx_ultra_tenant_monthly').price.id).toBe(stripe.prices.get('fbrx_ultra_tenant_monthly')!.id);

    // Per person: the owner becomes an Ultra member and joins 7 computers of their own. Their seat covers 5; the other
    // 2 are extra computers, never discounted.
    const me = await ok('GET', '/v1/accounts/me', undefined, owner.token);
    await ok('PATCH', `/v1/admin/members/${me.id}`, { tier: 'ultra' }, admin);
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      const e = await ok('POST', `/v1/accounts/memberships/${t.tenantId}/enroll`, {}, owner.token);
      await ok('POST', '/v1/enroll', { token: e.token, protocolVersion: 1, device: { name: `own-${n}`, hostname: `own-${n}`, platform: 'win32', arch: 'x64', osVersion: '11', appVersion: '2.3.0', machineId: `delta-own-${n}` } });
    }
    r = await ok('POST', '/v1/admin/billing/sync', {}, admin);
    const line = (item: string, tier: string) => r.plan.bill.lines.find((l: any) => l.item === item && l.tier === tier);
    expect(line('seats', 'ultra')).toMatchObject({ quantity: 3, people: 1, shared: 2, percentOff: 10 });
    expect(line('extra', 'ultra')).toMatchObject({ quantity: 2, each: 299, percentOff: 0, total: 598 });
    expect(items()).toEqual(expect.arrayContaining(['fbrx_ultra_tenant_monthly=3', 'fbrx_ultra_extra_computer_monthly=2']));
    // Leaving one computer: one extra fewer.
    const own = cp.ctx.db.get<{ id: string }>("SELECT id FROM devices WHERE hostname = 'own-7'")!;
    await ok('DELETE', `/v1/admin/devices/${own.id}`, undefined, admin);
    r = await ok('POST', '/v1/admin/billing/sync', {}, admin);
    expect(line('extra', 'ultra')).toMatchObject({ quantity: 1, total: 299 });
    expect(items()).toContain('fbrx_ultra_extra_computer_monthly=1');

    // Someone who bought Standard at the old price keeps it: the price lost its lookup key, and is still Standard.
    const old = { id: 'sub_old', customer: 'cus_9', status: 'active', metadata: { fbrx_account: me.id }, items: { data: [{ id: 'si_old', quantity: 1, current_period_end: end, price: { id: 'price_fbrx_standard_monthly', lookup_key: null } }] } };
    await stripeEvent({ id: 'evt_old', type: 'customer.subscription.updated', data: { object: old } });
    expect((await ok('GET', '/v1/accounts/me', undefined, owner.token)).tier).toBe('basic');

    // No volume discount any more: the coupon comes off.
    await ok('POST', '/v1/admin/pricing', { book: { ...book, volume: [] } }, op);
    r = await ok('POST', '/v1/admin/billing/sync', {}, admin);
    expect(r.plan.bill.percentOff).toBe(0);
    expect(coupon()).toEqual([]);
    expect(cp.ctx.db.all<{ action: string }>("SELECT action FROM audit_log WHERE action IN ('pricing.book', 'pricing.stripe')")).toHaveLength(3);
  });
});
