import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServer, type BuiltServer } from '../src/server';
import { loadConfig } from '../src/config';
import { Kernel } from '../../../packages/core/src/kernel';
import { createNodePlatform } from '../../../packages/core/src/node-platform';
import { StaticKeyKeychain } from '../../../packages/core/src/platform';

const USER = { origin: 'user' as const, actor: 'tester' };
const PASSWORD = 'A-long-enough-password-1';

async function waitFor<T>(fn: () => T | Promise<T>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timeout');
}

describe('signing in on a computer with an FBRX account', () => {
  let cp: BuiltServer;
  let base: string;
  let dataDir: string;
  let admin: string;
  let tenantId: string;

  const api = async (method: string, path: string, body?: unknown, token = admin, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as any;
    if (res.status >= 400) throw new Error(`${res.status} ${JSON.stringify(json)}`);
    return json;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'fbrx-acct-'));
    cp = await buildServer(
      loadConfig({}, { dataDir, port: 0, host: '127.0.0.1', logLevel: 'silent', setupToken: 'setup-token-123', adminConsoleDir: null, heartbeatSeconds: 10, cloud: { publicSignup: true, returnUrl: 'https://fbrx.example/account', stripe: null, apple: null, google: null } }),
    );
    await cp.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(cp.app.server.address() as AddressInfo).port}`;
    cp.ctx.config.publicUrl = base;
    tenantId = (await api('POST', '/v1/setup', { setupToken: 'setup-token-123', organization: 'Harbor Lane', name: 'Op', email: 'op@harbor.example', password: PASSWORD }, '')).tenantId;
    admin = (await api('POST', '/v1/auth/login', { email: 'op@harbor.example', password: PASSWORD }, '')).token;
  });

  afterAll(async () => {
    await cp.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('brings what the account bought, follows it, and joins the organization at the edition it gives the person', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fbrx-dev-'));
    const k = await Kernel.create({ dataDir: dir, platform: createNodePlatform({ dataDir: dir, devMode: false, keychain: new StaticKeyKeychain(randomBytes(32), 'memory'), licensePublicKeys: [cp.ctx.keys.licensePublicPem] }) });
    try {
      k.settings.update({ localApi: { enabled: false }, runtime: { enabled: false }, protection: { shield: { updateSignatures: false } } });
      await k.start();
      expect(k.license.status()).toMatchObject({ tier: 'essentials', ceiling: 'essentials' });

      // A new account, made from the computer: nothing bought yet.
      const made = (await k.call('account.signIn', { server: base, email: 'sam@harbor.example', password: PASSWORD, name: 'Sam', create: true }, USER)) as any;
      expect(made).toMatchObject({ signedIn: true, email: 'sam@harbor.example', tier: 'essentials', memberships: [], canBuy: false });
      await expect(k.call('account.signIn', { server: base, email: 'sam@harbor.example', password: 'wrong-password-123' }, USER)).rejects.toThrow(/Wrong email or password/);

      // Ultra bought (here: given by FBRX): the computer picks it up and turns it on.
      const acct = (await api('GET', '/v1/admin/accounts?q=sam@')).at(0);
      await api('POST', `/v1/admin/accounts/${acct.id}/grant`, { tier: 'ultra', days: 30 });
      expect(await k.call('account.refresh', {}, USER)).toMatchObject({ tier: 'ultra' });
      expect(k.license.status()).toMatchObject({ source: 'account', tier: 'ultra', chosen: 'ultra', ceiling: 'ultra', ceilingReason: 'license', commandUrl: null });
      expect(k.edition().productName).toBe('FBRX Endpoint Ultra');

      // The organization adds Sam as a Black Hole member (its license allows it): Sam's computer joins at Black Hole.
      await api('POST', '/v1/admin/licenses', { edition: 'enterprise', seats: 0, tier: 'blackhole' }, admin, { 'x-fbrx-tenant': tenantId });
      await api('POST', '/v1/admin/members', { email: 'sam@harbor.example', tier: 'blackhole' }, admin, { 'x-fbrx-tenant': tenantId });
      await expect(api('POST', '/v1/admin/members', { email: 'nobody@harbor.example' }, admin, { 'x-fbrx-tenant': tenantId })).rejects.toThrow(/no FBRX account with that email/);
      expect((await k.call('account.refresh', {}, USER)) as any).toMatchObject({ memberships: [{ tenantId, tenantName: 'Harbor Lane', tier: 'blackhole' }] });
      await k.call('account.join', { tenantId }, USER);
      expect(k.fleet.status()).toMatchObject({ state: expect.stringMatching(/online|connecting|offline/), tenantName: 'Harbor Lane' });
      await waitFor(() => k.license.status().tier === 'blackhole');
      expect(k.license.status()).toMatchObject({ source: 'managed', ceiling: 'blackhole', chosen: 'blackhole' });
      expect(await api('GET', '/v1/admin/members', undefined, admin, { 'x-fbrx-tenant': tenantId })).toMatchObject([{ email: 'sam@harbor.example', tier: 'blackhole', devices: 1 }]);

      // The organization moves Sam to Ultra: the computer follows.
      await api('PATCH', `/v1/admin/members/${acct.id}`, { tier: 'ultra' }, admin, { 'x-fbrx-tenant': tenantId });
      await waitFor(async () => {
        await k.fleet.sync();
        return k.license.status().tier === 'ultra';
      });
      expect(k.license.status()).toMatchObject({ ceiling: 'ultra', ceilingReason: 'organization' });

      // Signing out takes the account's license away (the organization's stays).
      expect(await k.call('account.signOut', {}, USER)).toMatchObject({ signedIn: false, email: null, tier: 'essentials' });
      expect(k.meta.get('license.account')).toBeNull();
      expect(k.license.status()).toMatchObject({ source: 'managed', tier: 'ultra' });
    } finally {
      await k.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
