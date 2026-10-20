import { createHmac, generateKeyPairSync } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { licenseStatusFrom } from '@fbrx/shared/node';
import { buildServer, type BuiltServer } from '../src/server';
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

/** Just enough of Stripe: prices by lookup key, customers, Checkout, subscriptions. */
function fakeStripe() {
  const calls: Array<{ method: string; path: string; body: string }> = [];
  const subscriptions = new Map<string, any>();
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    const url = new URL(req.url!, 'http://x');
    calls.push({ method: req.method!, path: url.pathname, body: body || url.search });
    const json = (o: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    if (req.headers.authorization !== 'Bearer sk_test_123') return json({ error: { message: 'bad key' } }, 401);
    if (url.pathname === '/v1/prices') return json({ data: [{ id: `price_${url.searchParams.get('lookup_keys[]')}` }] });
    if (url.pathname === '/v1/customers') return json({ id: 'cus_1' });
    if (url.pathname === '/v1/checkout/sessions') return json({ id: 'cs_1', url: 'https://checkout.example/cs_1' });
    if (url.pathname === '/v1/billing_portal/sessions') return json({ url: 'https://billing.example/portal' });
    if (url.pathname === '/v1/subscription_items' && req.method === 'POST') {
      const f = new URLSearchParams(body);
      const sub = subscriptions.get(f.get('subscription')!);
      const item = { id: `si_${sub.items.data.length + 1}`, quantity: Number(f.get('quantity')), price: { id: f.get('price'), lookup_key: f.get('price')!.replace(/^price_/, '') } };
      sub.items.data.push(item);
      return json(item);
    }
    const si = /^\/v1\/subscription_items\/(.+)$/.exec(url.pathname);
    if (si && req.method === 'POST') {
      for (const sub of subscriptions.values()) for (const i of sub.items.data) if (i.id === si[1]) i.quantity = Number(new URLSearchParams(body).get('quantity'));
      return json({ id: si[1] });
    }
    const m = /^\/v1\/subscriptions\/(.+)$/.exec(url.pathname);
    if (m && req.method === 'GET') return json(subscriptions.get(m[1]!));
    if (m && req.method === 'DELETE') return json({ id: m[1], status: 'canceled' });
    json({ error: { message: `no route ${url.pathname}` } }, 404);
  });
  return { server, calls, subscriptions };
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
  const stripe = fakeStripe();
  const google = fakeGoogle();
  const chain = appleLikeChain();

  const call = async (method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
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
          },
        },
      ),
    );
    await cp.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(cp.app.server.address() as AddressInfo).port}`;
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
    expect(await ok('GET', '/v1/accounts/license', undefined, token)).toEqual({ key: null, tier: 'essentials', expiresAt: null });
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
});
