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
      loadConfig({}, { dataDir, port: 0, host: '127.0.0.1', logLevel: 'silent', setupToken: 'setup-token-123', adminConsoleDir: null, heartbeatSeconds: 10, cloud: { publicSignup: true, returnUrl: 'https://fbrx.example/account', websiteOrigins: [], stripe: null, apple: null, google: null, mail: null, ai: null } }),
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

      // The computer signed in as itself: its name, system, version and install.
      const devices = (await k.call('account.devices', {}, USER)) as any[];
      expect(devices).toEqual([expect.objectContaining({ kind: 'computer', current: true, appVersion: k.platform.appVersion })]);
      expect(cp.ctx.db.get<{ install_id: string }>('SELECT install_id FROM account_sessions WHERE id = ?', devices[0].id)?.install_id).toBe(k.meta.get('install.id'));
      // Forgot the password: FBRX emails a link (it opens on the website).
      await k.call('account.forgotPassword', { email: 'sam@harbor.example', server: base }, USER);
      expect(cp.ctx.mail.kept.at(-1)).toMatchObject({ to: 'sam@harbor.example', subject: 'Reset your FBRX password' });

      // Ultra bought (here: given by FBRX): the computer picks it up and turns it on.
      const acct = (await api('GET', '/v1/admin/accounts?q=sam@')).at(0);
      await api('POST', `/v1/admin/accounts/${acct.id}/grant`, { tier: 'ultra', days: 30 });
      expect(await k.call('account.refresh', {}, USER)).toMatchObject({ tier: 'ultra' });
      expect(k.license.status()).toMatchObject({ source: 'account', tier: 'ultra', chosen: 'ultra', ceiling: 'ultra', ceilingReason: 'license', commandUrl: null });
      expect(k.edition().productName).toBe('FBRX Endpoint Ultra');

      // The organization adds Sam as a Black Hole member (its license allows it): Sam's computer joins at Black Hole.
      await api('POST', '/v1/admin/licenses', { edition: 'enterprise', seats: 0, tier: 'blackhole' }, admin, { 'x-fbrx-tenant': tenantId });
      // Only an account whose email is confirmed becomes a member.
      await expect(api('POST', '/v1/admin/members', { email: 'sam@harbor.example', tier: 'blackhole' }, admin, { 'x-fbrx-tenant': tenantId })).rejects.toThrow(/has not confirmed/);
      const confirm = cp.ctx.mail.kept.filter((m) => m.to === 'sam@harbor.example' && m.subject === 'Confirm your FBRX account').at(-1)!;
      await api('POST', '/v1/accounts/verify', { token: decodeURIComponent(/#verify=(\S+)/.exec(confirm.text)![1]!) });
      expect(await k.call('account.refresh', {}, USER)).toMatchObject({ emailVerified: true });
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

  it('invites someone with no FBRX account: the code makes their account on a computer and joins them, no website needed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fbrx-inv-'));
    const k = await Kernel.create({ dataDir: dir, platform: createNodePlatform({ dataDir: dir, devMode: false, keychain: new StaticKeyKeychain(randomBytes(32), 'memory'), licensePublicKeys: [cp.ctx.keys.licensePublicPem] }) });
    const t = { 'x-fbrx-tenant': tenantId };
    try {
      k.settings.update({ localApi: { enabled: false }, runtime: { enabled: false }, protection: { shield: { updateSignatures: false } } });
      await k.start();
      // Adding someone without an account makes an invitation; the code is shown once (and "emailed": kept here, since
      // this FBRX Command has no email set up, so it says it was not emailed).
      const r = await api('POST', '/v1/admin/invitations', { email: 'robin@harbor.example', tier: 'ultra' }, admin, t);
      expect(r).toMatchObject({ kind: 'invited', emailed: false, server: base, invitation: { email: 'robin@harbor.example', tier: 'ultra', status: 'pending' } });
      expect(r.code).toMatch(/^FBRX(-[0-9A-Z]{4}){4}$/);
      expect(cp.ctx.mail.kept.at(-1)).toMatchObject({ to: 'robin@harbor.example', subject: 'You are invited to Harbor Lane on FBRX' });
      expect(cp.ctx.mail.kept.at(-1)!.text).toContain(r.code);
      expect(await api('GET', '/v1/admin/invitations', undefined, admin, t)).toMatchObject([{ email: 'robin@harbor.example', status: 'pending' }]);
      // Inviting again replaces the first code.
      const again = await api('POST', '/v1/admin/invitations', { email: 'robin@harbor.example', tier: 'ultra' }, admin, t);
      await expect(k.call('account.previewInvitation', { code: r.code, server: base }, USER)).rejects.toThrow(/does not work/);

      // On the computer: the code, typed loosely, says what it is for; accepting makes the account and joins.
      const loose = again.code.toLowerCase().replace(/-/g, ' ');
      expect(await k.call('account.previewInvitation', { code: loose, server: base }, USER)).toMatchObject({ tenantName: 'Harbor Lane', email: 'robin@harbor.example', tier: 'ultra', accountExists: false });
      const st = (await k.call('account.acceptInvitation', { code: loose, server: base, name: 'Robin', password: PASSWORD }, USER)) as any;
      expect(st).toMatchObject({ signedIn: true, emailVerified: true, email: 'robin@harbor.example', memberships: [{ tenantId, tier: 'ultra' }] });
      expect(k.fleet.status()).toMatchObject({ tenantName: 'Harbor Lane' });
      await waitFor(() => k.license.status().tier === 'ultra');
      expect(await api('GET', '/v1/admin/members', undefined, admin, t)).toEqual(expect.arrayContaining([expect.objectContaining({ email: 'robin@harbor.example', tier: 'ultra', devices: 1 })]));
      // The code works once; the invitation is gone from the list.
      await expect(k.call('account.previewInvitation', { code: again.code, server: base }, USER)).rejects.toThrow(/does not work/);
      expect(await api('GET', '/v1/admin/invitations', undefined, admin, t)).toEqual([]);

      // Someone with a confirmed account is added at once; inviting a member is refused.
      expect(await api('POST', '/v1/admin/invitations', { email: 'robin@harbor.example' }, admin, t).catch((e: Error) => e.message)).toMatch(/already a member/);
      const other = (await api('POST', '/v1/admin/invitations', { email: 'lee@harbor.example', tier: 'basic' }, admin, t)).code;
      // An invitation for an email whose account exists and is confirmed asks for that account's password.
      await api('POST', '/v1/accounts/signup', { email: 'lee@harbor.example', name: 'Lee', password: PASSWORD }, '');
      cp.ctx.db.run('UPDATE accounts SET email_verified_at = ? WHERE email = ?', new Date().toISOString(), 'lee@harbor.example');
      expect(await api('POST', '/v1/accounts/invitations/preview', { code: other }, '')).toMatchObject({ accountExists: true });
      await expect(api('POST', '/v1/accounts/invitations/accept', { code: other, password: 'not-the-password-1' }, '')).rejects.toThrow(/already has an FBRX account/);
      expect(await api('POST', '/v1/accounts/invitations/accept', { code: other, password: PASSWORD }, '')).toMatchObject({ tenantId, account: { email: 'lee@harbor.example' } });
      // A withdrawn invitation stops working.
      const gone = await api('POST', '/v1/admin/invitations', { email: 'kim@harbor.example' }, admin, t);
      await api('DELETE', `/v1/admin/invitations/${gone.invitation.id}`, undefined, admin, t);
      await expect(api('POST', '/v1/accounts/invitations/preview', { code: gone.code }, '')).rejects.toThrow(/does not work/);
    } finally {
      await k.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('FBRX Command mints a support pass that puts one computer into support mode, and refusing to brew ends it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fbrx-sup-'));
    const k = await Kernel.create({ dataDir: dir, platform: createNodePlatform({ dataDir: dir, devMode: false, keychain: new StaticKeyKeychain(randomBytes(32), 'memory'), licensePublicKeys: [cp.ctx.keys.licensePublicPem] }) });
    try {
      k.settings.update({ localApi: { enabled: false }, runtime: { enabled: false }, protection: { shield: { updateSignatures: false } } });
      await k.start();
      const installId = k.meta.get<string>('install.id')!;
      expect(k.license.status().tier).toBe('essentials');

      // The admin mints a pass for this computer's install id.
      const minted = await api('POST', '/v1/admin/support-passes', { installId, note: 'Ticket 42', hours: 2 }, admin, { 'x-fbrx-tenant': tenantId });
      expect(minted).toMatchObject({ tier: 'blackhole' });
      // A pass for a different computer is refused on the endpoint it is pasted into.
      const wrong = await api('POST', '/v1/admin/support-passes', { installId: 'not-this-one', hours: 1 }, admin, { 'x-fbrx-tenant': tenantId });
      await expect(k.call('support.activate', { pass: wrong.pass }, USER)).rejects.toMatchObject({ code: 'FORBIDDEN' });

      // The right pass turns this computer into Black Hole with everything on; "refusetobrew" ends it.
      expect((await k.call('support.activate', { pass: minted.pass }, USER)) as any).toMatchObject({ active: true, tier: 'blackhole' });
      expect(k.license.status()).toMatchObject({ tier: 'blackhole', source: 'support', support: true });
      expect((await k.call('support.end', {}, USER)) as any).toMatchObject({ active: false });
      expect(k.license.status().tier).toBe('essentials');
    } finally {
      await k.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
