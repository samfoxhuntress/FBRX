import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CloudAiAccountView, CloudAiOverview, CloudAiUsage, PromoCodeView } from '@fbrx/shared';
import { buildServer, type BuiltServer } from '../src/server';
import { loadConfig, parseAiModels } from '../src/config';
import { Kernel } from '../../../packages/core/src/kernel';
import { createNodePlatform } from '../../../packages/core/src/node-platform';
import { StaticKeyKeychain } from '../../../packages/core/src/platform';
import type { ProviderChunk } from '../../../packages/core/src/ai/providers/types';

const USER = { origin: 'user' as const, actor: 'tester' };
const PASSWORD = 'A-long-enough-password-1';
const UPSTREAM_KEY = 'up-key-only-command-has';

const readBody = (req: IncomingMessage) => new Promise<string>((r) => {
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => r(b));
});
const listen = (s: Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));

/** Just enough of an OpenAI-compatible model provider: answers stream (counting at the end) or come whole. */
function fakeProvider() {
  const seen: Array<{ authorization?: string; body: any }> = [];
  let open = 0;
  const server = createServer(async (req, res) => {
    const body = JSON.parse((await readBody(req)) || '{}');
    seen.push({ authorization: req.headers.authorization, body });
    const json = (o: unknown, status = 200) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(o));
    };
    if (req.headers.authorization !== `Bearer ${UPSTREAM_KEY}`) return json({ error: { message: 'bad key' } }, 401);
    if (body.messages?.[0]?.content === 'too long') return json({ error: { message: 'org/model-a takes at most 1000 tokens' } }, 400);
    const chunk = (o: object) => res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: body.model, ...o })}\n\n`);
    if (body.model === 'org/slow') {
      // Says a little, then waits for whoever asked to stop listening.
      open++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      chunk({ choices: [{ index: 0, delta: { content: 'Thinking it over' } }] });
      res.on('close', () => open--);
      return;
    }
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' } }] });
      chunk({ choices: [{ index: 0, delta: { content: ' there' }, finish_reason: 'stop' }] });
      if (body.stream_options?.include_usage) chunk({ choices: [], usage: { prompt_tokens: 30, completion_tokens: 20 } });
      res.end('data: [DONE]\n\n');
      return;
    }
    json({ id: 'c2', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'Hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 8 } });
  });
  return { server, seen, open: () => open };
}

describe('FBRX Cloud AI', () => {
  let cp: BuiltServer;
  let base: string;
  let dataDir: string;
  let admin: string;
  const provider = fakeProvider();

  const call = async (method: string, path: string, body?: unknown, token?: string) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as any };
  };
  const ok = async <T = any>(method: string, path: string, body?: unknown, token?: string): Promise<T> => {
    const r = await call(method, path, body, token);
    if (r.status >= 400) throw new Error(`${r.status} ${JSON.stringify(r.json)}`);
    return r.json as T;
  };
  /** A new FBRX account's id and token. */
  const signUp = async (email: string) => {
    const r = await ok('POST', '/v1/accounts/signup', { email, name: email.split('@')[0], password: PASSWORD });
    return { id: r.account.id as string, token: r.token as string };
  };
  const usage = (token: string) => ok<CloudAiUsage>('GET', '/v1/accounts/ai', undefined, token);
  const chat = (token: string, body: Record<string, unknown>) =>
    fetch(`${base}/v1/ai/chat/completions`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello?' }], ...body }) });
  /** The data of each event in a streamed answer. */
  const events = async (res: Response) => (await res.text()).split('\n\n').filter((e) => e.startsWith('data: ')).map((e) => e.slice(6));
  const change = (id: string, body: object) => ok<CloudAiAccountView>('POST', `/v1/admin/ai/accounts/${id}`, body, admin);
  async function until<T>(fn: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
    for (let i = 0; i < 100; i++) {
      const v = await fn();
      if (done(v)) return v;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('timeout');
  }

  beforeAll(async () => {
    const upstream = await listen(provider.server);
    dataDir = mkdtempSync(join(tmpdir(), 'fbrx-cloud-ai-'));
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
            websiteOrigins: [],
            stripe: null,
            apple: null,
            google: null,
            mail: null,
            ai: { baseUrl: upstream, apiKey: UPSTREAM_KEY, models: parseAiModels('fbrx-everyday=org/model-a, fbrx-thorough=org/model-b*3, fbrx-slow=org/slow') },
          },
        },
      ),
    );
    await cp.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(cp.app.server.address() as AddressInfo).port}`;
    await ok('POST', '/v1/setup', { setupToken: 'setup-token-123', organization: 'FBRX', name: 'Op', email: 'op@fbrx.example', password: PASSWORD });
    admin = (await ok('POST', '/v1/auth/login', { email: 'op@fbrx.example', password: PASSWORD })).token;
  });

  afterAll(async () => {
    await cp.close();
    provider.server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('reads the models from FBRX_AI_MODELS: FBRX’s name, the provider’s, and a weight', () => {
    expect(parseAiModels('fbrx-everyday=org/model-a,fbrx-thorough=org/model-b*3, org/plain')).toEqual([
      { id: 'fbrx-everyday', upstream: 'org/model-a', weight: 1 },
      { id: 'fbrx-thorough', upstream: 'org/model-b', weight: 3 },
      { id: 'org/plain', upstream: 'org/plain', weight: 1 },
    ]);
  });

  it('passes chats on under FBRX’s names with the key only FBRX Command holds, and counts their tokens', async () => {
    const { id, token } = await signUp('ana@example.com');
    // Essentials comes with none: the chat never reaches the provider.
    expect(await usage(token)).toMatchObject({ state: 'limit', tier: 'essentials', allowance: 0, message: 'FBRX Cloud AI comes with Standard and Ultra, and a promo code adds tokens.' });
    const refused = await chat(token, { stream: true });
    expect(refused.status).toBe(402);
    expect(provider.seen).toHaveLength(0);
    expect((await call('GET', '/v1/ai/models')).status).toBe(401);

    await ok('POST', `/v1/admin/accounts/${id}/grant`, { tier: 'ultra', days: 30 }, admin);
    expect(await usage(token)).toMatchObject({ state: 'ok', tier: 'ultra', allowance: 3_000_000, used: 0, models: [{ id: 'fbrx-everyday', weight: 1 }, { id: 'fbrx-thorough', weight: 3 }, { id: 'fbrx-slow', weight: 1 }] });
    expect((await ok('GET', '/v1/ai/models', undefined, token)).data.map((m: { id: string }) => m.id)).toEqual(['fbrx-everyday', 'fbrx-thorough', 'fbrx-slow']);

    // Streamed, as the computers ask: the provider's model name never comes back.
    const streamed = await chat(token, { stream: true, max_tokens: 100_000, user: 'ana@example.com', metadata: { x: 1 } });
    expect(streamed.headers.get('content-type')).toMatch(/text\/event-stream/);
    const data = await events(streamed);
    expect(data.at(-1)).toBe('[DONE]');
    const chunks = data.slice(0, -1).map((d) => JSON.parse(d));
    expect(chunks.map((c) => c.choices[0]?.delta?.content ?? '').join('')).toBe('Hello there');
    expect(new Set(chunks.map((c) => c.model))).toEqual(new Set(['fbrx-everyday']));
    const sent = provider.seen.at(-1)!;
    expect(sent.authorization).toBe(`Bearer ${UPSTREAM_KEY}`);
    expect(sent.body).toMatchObject({ model: 'org/model-a', stream: true, stream_options: { include_usage: true }, max_tokens: 8192 });
    // Only what a chat needs goes on: nothing about who asked.
    expect(sent.body).not.toHaveProperty('user');
    expect(sent.body).not.toHaveProperty('metadata');
    expect(await usage(token)).toMatchObject({ used: 50, inputTokens: 30, outputTokens: 20, requests: 1 });

    // Whole, on a model whose tokens count three times.
    const whole = await (await chat(token, { model: 'fbrx-thorough' })).json();
    expect(whole).toMatchObject({ model: 'fbrx-thorough', choices: [{ message: { content: 'Hi' } }] });
    expect(provider.seen.at(-1)!.body.model).toBe('org/model-b');
    expect(await usage(token)).toMatchObject({ used: 50 + 3 * 20, inputTokens: 42, outputTokens: 28, requests: 2 });

    const unknown = await chat(token, { model: 'nope' });
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error.message).toMatch(/has no model "nope": it has fbrx-everyday, fbrx-thorough, fbrx-slow/);
    // The provider's complaint about the chat itself is passed on, under FBRX's name for the model.
    const long = await chat(token, { messages: [{ role: 'user', content: 'too long' }] });
    expect(long.status).toBe(400);
    expect((await long.json()).error.message).toBe('FBRX Cloud AI could not take that chat: fbrx-everyday takes at most 1000 tokens');
  });

  it('blocks at the limit, spends extra tokens past it, and lets the operator lift, limit and turn it off', async () => {
    const { id, token } = await signUp('ben@example.com');
    await ok('POST', `/v1/admin/accounts/${id}/grant`, { tier: 'basic', days: 30 }, admin);
    await chat(token, { stream: true }).then((r) => r.text());
    // Its own limit, under what it used: blocked until the month renews.
    expect(await change(id, { monthlyLimit: 40, note: 'Testing limits' })).toMatchObject({ state: 'limit', allowance: 40, customLimit: true, used: 50, note: 'Testing limits' });
    const blocked = await chat(token, { stream: true });
    expect(blocked.status).toBe(402);
    expect((await blocked.json()).error).toMatchObject({ code: 'AI_LIMIT', message: expect.stringMatching(/^You have used this month’s FBRX Cloud AI \(40 tokens\)\. It renews on \w+ 1, or a promo code adds tokens\.$/) });

    // Extra tokens carry it on, and are spent.
    expect(await change(id, { tokens: 60 })).toMatchObject({ state: 'credit', credit: 60 });
    await chat(token, { stream: true }).then((r) => r.text());
    expect(await usage(token)).toMatchObject({ state: 'credit', credit: 10, used: 100 });
    await chat(token, { stream: true }).then((r) => r.text());
    expect(await usage(token)).toMatchObject({ state: 'limit', credit: 0, used: 150 });

    // Lifted for the month: it goes on, counted, and spends nothing.
    expect(await change(id, { lift: true, tokens: 5 })).toMatchObject({ state: 'lifted', lifted: true, credit: 5 });
    expect((await chat(token, {})).status).toBe(200);
    expect(await usage(token)).toMatchObject({ state: 'lifted', credit: 5, used: 170 });

    // Turned off, whatever else is set.
    expect(await change(id, { off: true })).toMatchObject({ state: 'off', off: true });
    const off = await chat(token, {});
    expect(off.status).toBe(403);
    expect((await off.json()).error.code).toBe('AI_OFF');
    expect(await change(id, { off: false, lift: false, monthlyLimit: null })).toMatchObject({ state: 'ok', allowance: 1_000_000, customLimit: false, lifted: false });

    const view = await ok<CloudAiAccountView>('GET', `/v1/admin/ai/accounts/${id}`, undefined, admin);
    expect(view.history).toEqual([{ month: view.month, used: 170, inputTokens: 102, outputTokens: 68, requests: 4 }]);
    expect((await call('POST', `/v1/admin/ai/accounts/${id}`, { off: true }, token)).status).toBe(401);
  });

  it('rests the whole service at its monthly budget, and gives Essentials its allowance once the email is confirmed', async () => {
    const { token } = await signUp('cy@example.com');
    const overview = await ok<CloudAiOverview>('GET', '/v1/admin/ai', undefined, admin);
    expect(overview).toMatchObject({ available: true, budget: null, allowance: { essentials: 0, basic: 1_000_000, ultra: 3_000_000 } });
    expect(overview.used).toBeGreaterThan(0);
    // Most used first.
    expect(overview.accounts.map((a) => [a.email, a.used])).toEqual([
      ['ben@example.com', 170],
      ['ana@example.com', 110],
    ]);

    expect(await ok('POST', '/v1/admin/ai/settings', { allowance: { essentials: 1000 }, budget: overview.used }, admin)).toMatchObject({ allowance: { essentials: 1000, basic: 1_000_000 }, budget: overview.used });
    expect(await usage(token)).toMatchObject({ state: 'busy', allowance: 0, needsEmail: true });
    const busy = await chat(token, {});
    expect(busy.status).toBe(503);
    expect((await busy.json()).error.code).toBe('AI_BUSY');

    await ok('POST', '/v1/admin/ai/settings', { budget: null }, admin);
    expect(await usage(token)).toMatchObject({ state: 'limit', needsEmail: true, message: 'Confirm your FBRX account’s email to use FBRX Cloud AI: open the link FBRX sent you.' });
    const verify = decodeURIComponent(/#verify=(\S+)/.exec(cp.ctx.mail.kept.filter((m) => m.to === 'cy@example.com').at(-1)!.text)![1]!);
    await ok('POST', '/v1/accounts/verify', { token: verify });
    expect(await usage(token)).toMatchObject({ state: 'ok', allowance: 1000, needsEmail: false });
    await ok('POST', '/v1/admin/ai/settings', { allowance: { essentials: 0 } }, admin);
  });

  it('makes promo codes for tokens and editions, each used once per account, until used up, expired or turned off', async () => {
    const make = (body: object) => ok<PromoCodeView>('POST', '/v1/admin/promos', body, admin);
    const launch = await make({ code: ' launch 50 ', tokens: 500_000, maxRedemptions: 1, note: 'Launch week' });
    expect(launch).toMatchObject({ code: 'LAUNCH-50', tokens: 500_000, tier: null, maxRedemptions: 1, redemptions: 0, status: 'active', createdBy: 'op@fbrx.example' });
    expect((await call('POST', '/v1/admin/promos', { code: 'LAUNCH50', tokens: 1 }, admin)).status).toBe(409);
    expect((await call('POST', '/v1/admin/promos', { code: 'x', tokens: 1 }, admin)).status).toBe(400);
    expect((await call('POST', '/v1/admin/promos', { tier: 'ultra' }, admin)).status).toBe(400);
    expect((await call('POST', '/v1/admin/promos', {}, admin)).status).toBe(400);
    const trial = await make({ tier: 'ultra', days: 7, tokens: 100_000, expiresAt: '2099-12-31' });
    expect(trial.code).toMatch(/^FBRX-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/);
    expect(trial.expiresAt).toBe('2099-12-31T23:59:59.999Z');

    const dee = await signUp('dee@example.com');
    const used = await ok('POST', '/v1/accounts/promo', { code: 'Launch-50' }, dee.token);
    expect(used.redeemed).toMatchObject({ code: 'LAUNCH-50', tokens: 500_000, message: 'Added to your FBRX account: 500K FBRX Cloud AI tokens.' });
    expect(used.ai).toMatchObject({ state: 'credit', credit: 500_000, allowance: 0 });
    expect((await chat(dee.token, {})).status).toBe(200);
    expect((await call('POST', '/v1/accounts/promo', { code: 'LAUNCH-50' }, dee.token)).status).toBe(409);
    const eve = await signUp('eve@example.com');
    expect((await call('POST', '/v1/accounts/promo', { code: 'LAUNCH-50' }, eve.token)).json.error.message).toBe('That promo code has been used up');
    expect((await call('POST', '/v1/accounts/promo', { code: 'NOPE-NOPE' }, eve.token)).json.error.message).toBe('That promo code does not work: check it and try again');

    // An edition for some days, as a grant, and tokens with it.
    const trialUsed = await ok('POST', '/v1/accounts/promo', { code: trial.code.toLowerCase() }, eve.token);
    expect(trialUsed.redeemed.message).toBe('Added to your FBRX account: 100K FBRX Cloud AI tokens and Ultra for 7 days.');
    expect(trialUsed.account).toMatchObject({ tier: 'ultra', entitlements: [{ productId: 'fbrx_ultra_monthly', source: 'grant', valid: true }] });
    expect(trialUsed.ai).toMatchObject({ state: 'ok', tier: 'ultra', allowance: 3_000_000, credit: 100_000 });

    expect(await ok('POST', `/v1/admin/promos/${trial.id}`, { disabled: true }, admin)).toMatchObject({ status: 'disabled' });
    const fay = await signUp('fay@example.com');
    expect((await call('POST', '/v1/accounts/promo', { code: trial.code }, fay.token)).json.error.message).toBe('That promo code was turned off');
    const old = await make({ code: 'OLD-CODE', tokens: 10, expiresAt: '2020-01-01T00:00:00Z' });
    expect(old.status).toBe('expired');
    expect((await call('POST', '/v1/accounts/promo', { code: 'old code' }, fay.token)).json.error.message).toBe('That promo code has expired');

    expect(await ok('GET', `/v1/admin/promos/${launch.id}/redemptions`, undefined, admin)).toEqual([{ accountId: dee.id, email: 'dee@example.com', redeemedAt: expect.any(String) }]);
    expect((await ok<PromoCodeView[]>('GET', '/v1/admin/promos', undefined, admin)).map((p) => [p.code, p.status, p.redemptions])).toEqual([
      ['OLD-CODE', 'expired', 0],
      [trial.code, 'disabled', 1],
      ['LAUNCH-50', 'used up', 1],
    ]);
  });

  it('counts a stopped answer up to where it stopped, and lets an account have a few chats going at once', async () => {
    const { id, token } = await signUp('gus@example.com');
    await ok('POST', `/v1/admin/accounts/${id}/grant`, { tier: 'basic', days: 30 }, admin);
    const stops = Array.from({ length: 4 }, () => new AbortController());
    const going = await Promise.all(
      stops.map((s) => fetch(`${base}/v1/ai/chat/completions`, { method: 'POST', signal: s.signal, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fbrx-slow', stream: true, messages: [{ role: 'user', content: 'x'.repeat(400) }] }) })),
    );
    // Each has started answering.
    for (const r of going) expect(new TextDecoder().decode((await r.body!.getReader().read()).value)).toContain('Thinking it over');
    const fifth = await chat(token, { stream: true });
    expect(fifth.status).toBe(429);
    for (const s of stops) s.abort();
    // The provider is stopped too, and each counts what it read (about 100 tokens) and wrote (about 4).
    await until(async () => provider.open(), (n) => n === 0);
    const after = await until(() => usage(token), (u) => u.requests === 4);
    expect(after).toMatchObject({ inputTokens: 400, outputTokens: 16, used: 416 });
    expect((await chat(token, {})).status).toBe(200);
  });

  it('lets a computer signed in to the account chat with FBRX Cloud AI, and says why when it may not', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fbrx-cloud-pc-'));
    const k = await Kernel.create({ dataDir: dir, platform: createNodePlatform({ dataDir: dir, devMode: false, keychain: new StaticKeyKeychain(randomBytes(32), 'memory'), licensePublicKeys: [cp.ctx.keys.licensePublicPem] }) });
    const drain = async (chunks: AsyncIterable<ProviderChunk>) => {
      const all: ProviderChunk[] = [];
      for await (const c of chunks) all.push(c);
      return all;
    };
    const ask = { model: '', messages: [{ role: 'user' as const, content: 'Hello?' }], tools: [], signal: new AbortController().signal };
    try {
      k.settings.update({ localApi: { enabled: false }, runtime: { enabled: false }, protection: { shield: { updateSignatures: false } } });
      await k.start();
      const cfg = { id: 'fbrx-cloud', type: 'fbrx-cloud' as const, name: 'FBRX Cloud AI', enabled: true, cloud: true };
      k.settings.update({ ai: { providers: [...k.settings.get().ai.providers, cfg] } });
      expect(k.providers.blockReason(cfg)).toBe('Sign in to your FBRX account to use FBRX Cloud AI');

      await k.call('account.signIn', { server: base, email: 'hal@example.com', password: PASSWORD, name: 'Hal', create: true }, USER);
      expect(k.providers.blockReason(cfg)).toBeNull();
      const { provider: cloud, model } = k.providers.resolve('fbrx-cloud');
      expect(model).toBe('');
      // Essentials comes with no tokens: not ready, and it says why before a chat fails on it.
      expect(await cloud.health()).toEqual({ ok: false, message: 'FBRX Cloud AI comes with Standard and Ultra, and a promo code adds tokens.' });

      await ok('POST', '/v1/admin/promos', { code: 'HELLO-HAL', tokens: 1000 }, admin);
      const used = (await k.call('account.redeemPromo', { code: 'hello hal' }, USER)) as { redeemed: { message: string }; ai: CloudAiUsage };
      expect(used.redeemed.message).toBe('Added to your FBRX account: 1,000 FBRX Cloud AI tokens.');
      expect(used.ai).toMatchObject({ state: 'credit', credit: 1000 });
      expect(await cloud.health()).toEqual({ ok: true, message: null });
      expect((await cloud.listModels()).map((m) => m.id)).toEqual(['fbrx-everyday', 'fbrx-thorough', 'fbrx-slow']);

      // A chat goes through FBRX Command with the account's sign-in, and comes back counted.
      const answer = await drain(cloud.chat(ask));
      expect(answer.flatMap((c) => (c.type === 'text' ? [c.delta] : [])).join('')).toBe('Hello there');
      expect(answer).toContainEqual({ type: 'usage', inputTokens: 30, outputTokens: 20 });
      expect(provider.seen.at(-1)!.body.model).toBe('org/model-a');
      expect(await k.call('account.cloudAi', {}, USER)).toMatchObject({ state: 'credit', credit: 950, used: 50 });

      // Out of tokens: the chat stops with the reason, the way any provider's error reaches the person.
      const { accounts } = await ok<CloudAiOverview>('GET', '/v1/admin/ai?q=hal@', undefined, admin);
      await change(accounts[0]!.accountId, { tokens: -950 });
      await expect(drain(cloud.chat(ask))).rejects.toThrow(/^FBRX Cloud AI comes with Standard and Ultra/);
      expect((await cloud.health()).ok).toBe(false);

      await k.call('account.signOut', {}, USER);
      expect(k.providers.blockReason(cfg)).toBe('Sign in to your FBRX account to use FBRX Cloud AI');
    } finally {
      await k.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
