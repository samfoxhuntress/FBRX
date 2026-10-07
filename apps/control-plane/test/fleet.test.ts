import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as tar from 'tar';
import { readFileSync } from 'node:fs';
import { totp } from '@fbrx/shared/node';
import { DEFAULT_POLICY } from '@fbrx/shared';
import { buildServer, type BuiltServer } from '../src/server';
import { loadConfig } from '../src/config';
import { Kernel } from '../../../packages/core/src/kernel';
import { createNodePlatform } from '../../../packages/core/src/node-platform';
import { StaticKeyKeychain } from '../../../packages/core/src/platform';
import { randomBytes } from 'node:crypto';

const USER = { origin: 'user' as const, actor: 'tester' };
const ADMIN_PASSWORD = 'Super-Secret-Admin-Pass-1';

async function waitFor<T>(fn: () => T | Promise<T>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout${last ? `: ${(last as Error).message}` : ''}`);
}

describe('control plane ⇄ device fleet', () => {
  let server: BuiltServer;
  let base: string;
  let dataDir: string;
  let token: string;
  let tenantId: string;
  let kernel: Kernel;
  let kernelDir: string;

  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'x-fbrx-tenant': tenantId ?? '', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status >= 400) throw Object.assign(new Error(`${res.status} ${JSON.stringify(json)}`), { status: res.status, json });
    return json as any;
  };

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'fbrx-cp-'));
    server = await buildServer(loadConfig({}, { dataDir, port: 0, host: '127.0.0.1', logLevel: 'silent', setupToken: 'setup-token-123', adminConsoleDir: null, heartbeatSeconds: 10 }));
    await server.app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
    server.ctx.config.publicUrl = base;
  });

  afterAll(async () => {
    await kernel?.stop().catch(() => undefined);
    await server?.close();
    rmSync(dataDir, { recursive: true, force: true });
    if (kernelDir) rmSync(kernelDir, { recursive: true, force: true });
  });

  it('runs first-time setup, login and MFA', async () => {
    expect((await (await fetch(`${base}/v1/setup/status`)).json()).needsSetup).toBe(true);
    const bad = await fetch(`${base}/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setupToken: 'nope', organization: 'Fabrics Inc', name: 'Sam', email: 'sam@fabrics.example', password: ADMIN_PASSWORD }) });
    expect(bad.status).toBe(401);
    expect((await bad.json()).error.message).toMatch(/not the setup token.*installer/);
    // Copied from a terminal with a space or line break around it: still the token.
    const setup = await (await fetch(`${base}/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setupToken: ' setup-token-123\n', organization: 'Fabrics Inc', name: 'Sam', email: 'sam@fabrics.example', password: ADMIN_PASSWORD }) })).json();
    tenantId = setup.tenantId;
    const login = await (await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'sam@fabrics.example', password: ADMIN_PASSWORD }) })).json();
    token = login.token;
    expect(login.user.role).toBe('superadmin');

    const mfa = await api('POST', '/v1/auth/mfa/setup', {});
    await api('POST', '/v1/auth/mfa/enable', { code: totp(mfa.secret) });
    const step1 = await (await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'sam@fabrics.example', password: ADMIN_PASSWORD }) })).json();
    expect(step1.mfaRequired).toBe(true);
    const step2 = await (await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'sam@fabrics.example', password: ADMIN_PASSWORD, totp: totp(mfa.secret) }) })).json();
    expect(step2.token).toBeTruthy();
    const me = await api('GET', '/v1/auth/me');
    expect(me.permissions).toContain('releases.manage');
  });

  it('enrolls a workstation and keeps a real-time connection', async () => {
    const enr = await api('POST', '/v1/admin/enrollment-tokens', { label: 'Office laptops', maxUses: 5, expiresInDays: 7 });
    expect(enr.provisioning).toMatchObject({ fbrxProvisioning: 1, serverUrl: base });
    const { publicKeyPem } = await api('GET', '/v1/admin/licensing/public-key');

    kernelDir = mkdtempSync(join(tmpdir(), 'fbrx-dev-'));
    process.env.FBRX_ALLOW_INSECURE_FLEET = '1';
    kernel = await Kernel.create({
      dataDir: kernelDir,
      platform: createNodePlatform({ dataDir: kernelDir, devMode: false, keychain: new StaticKeyKeychain(randomBytes(32), 'memory'), licensePublicKeys: [publicKeyPem] }),
    });
    kernel.settings.update({ localApi: { enabled: false }, runtime: { enabled: false }, protection: { shield: { updateSignatures: false } } });
    await kernel.start();
    expect(kernel.license.status().edition).toBe('community');

    const status = (await kernel.call('fleet.enroll', { serverUrl: base, token: enr.token, deviceName: 'Sam Workstation' }, USER)) as any;
    expect(status.tenantName).toBe('Fabrics Inc');
    await waitFor(() => kernel.fleet.status().state === 'online');
    const devices = await waitFor(async () => {
      const d = await api('GET', '/v1/admin/devices');
      return d.length && d[0].health ? d : null;
    });
    expect(devices[0]).toMatchObject({ name: 'Sam Workstation', online: true, realtime: true });
    expect(devices[0].health.vaultState).toBe('unlocked');
  });

  it('pushes managed settings, policy, secrets and license in real time', async () => {
    const profile = await api('POST', '/v1/admin/profiles', {
      name: 'Standard workstation',
      settings: { ai: { temperature: 0.15 }, backup: { scheduleEnabled: true } },
      locked: ['ai.temperature'],
      policy: { ...DEFAULT_POLICY, mode: 'enforce', shell: { ...DEFAULT_POLICY.shell, enabled: false } },
    });
    await api('PATCH', `/v1/admin/tenants/${tenantId}`, { defaultProfileId: profile.id });
    await api('POST', '/v1/admin/secrets', { scope: 'tenant', name: 'FBRX_BACKUP_PASSPHRASE', value: 'org backup passphrase 1', description: 'Org backup key' });
    await api('POST', '/v1/admin/licenses', { edition: 'enterprise', seats: 10 });

    await waitFor(() => kernel.settings.get().ai.temperature === 0.15 && kernel.license.status().edition === 'enterprise' && kernel.vault.has('FBRX_BACKUP_PASSPHRASE'));
    expect(kernel.settings.effective().locked).toContain('ai.temperature');
    await expect(kernel.call('settings.update', { patch: { ai: { temperature: 0.9 } } }, USER)).rejects.toThrow(/managed/);
    expect(kernel.policy.effective().source).toBe('managed');
    const shell = await kernel.gate.invoke('shell.run', { command: 'echo hi' }, USER);
    expect(shell.status).toBe('denied');
    expect(kernel.vault.list().find((s) => s.name === 'FBRX_BACKUP_PASSPHRASE')?.managed).toBe(true);
    expect(kernel.license.status()).toMatchObject({ state: 'valid', source: 'managed', customer: 'Fabrics Inc' });
  });

  it('executes remote commands and reports results', async () => {
    const [device] = await api('GET', '/v1/admin/devices');
    const cmd = await api('POST', `/v1/admin/devices/${device.id}/commands`, { type: 'ping' });
    const done = await waitFor(async () => {
      const c = await api('GET', `/v1/admin/commands/${cmd.id}`);
      return c.status === 'succeeded' ? c : null;
    });
    expect(done.result.pong).toBe(true);

    const diag = await api('POST', `/v1/admin/devices/${device.id}/commands`, { type: 'diagnostics.collect', payload: { auditEntries: 5 } });
    const d2 = await waitFor(async () => {
      const c = await api('GET', `/v1/admin/commands/${diag.id}`);
      return c.status === 'succeeded' ? c : null;
    });
    expect(d2.result.auditVerify.ok).toBe(true);
    await expect(api('POST', `/v1/admin/devices/${device.id}/commands`, { type: 'not.a.command' })).rejects.toThrow(/400/);
  });

  it('backs up a device to the control plane with the org passphrase', async () => {
    const [device] = await api('GET', '/v1/admin/devices');
    const cmd = await api('POST', `/v1/admin/devices/${device.id}/commands`, { type: 'backup.create', payload: { label: 'nightly', upload: true } });
    const done = await waitFor(async () => {
      const c = await api('GET', `/v1/admin/commands/${cmd.id}`);
      return ['succeeded', 'failed'].includes(c.status) ? c : null;
    }, 30_000);
    expect(done.error ?? null).toBeNull();
    expect(done.result.uploadedSnapshotId).toBeTruthy();
    const snaps = await api('GET', '/v1/admin/snapshots');
    expect(snaps[0]).toMatchObject({ deviceName: 'Sam Workstation', label: 'nightly' });
    expect(snaps[0].header.encryption.cipher).toBe('aes-256-gcm');
  });

  it('distributes a plugin package to devices', async () => {
    const out = mkdtempSync(join(tmpdir(), 'fbrx-pkg-'));
    const pkgFile = join(out, 'toolkit.tgz');
    const example = resolve(__dirname, '../../../plugins/example-toolkit');
    await tar.c({ gzip: true, file: pkgFile, cwd: example }, ['fbrx-plugin.json', 'index.mjs']);
    const upload = await fetch(`${base}/v1/admin/packages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-fbrx-tenant': tenantId, 'content-type': 'application/octet-stream' },
      body: readFileSync(pkgFile),
    });
    const pkg = await upload.json();
    expect(pkg.pluginId).toBe('com.fbrx.example-toolkit');
    const deployed = await api('POST', `/v1/admin/packages/${pkg.id}/deploy`, { all: true });
    expect(deployed.queued).toBe(1);
    await waitFor(() => kernel.plugins.list().find((p) => p.id === 'com.fbrx.example-toolkit' && p.state === 'running'), 20_000);
    const r = await kernel.gate.invoke('toolkit.uuid', { count: 2 }, USER);
    expect(r.status).toBe('succeeded');
    rmSync(out, { recursive: true, force: true });
  });

  it('serves electron-updater feeds per device channel, pin and rollout', async () => {
    const rel = await api('POST', '/v1/admin/releases', { version: '1.1.0', channel: 'stable', notes: 'Faster agent' });
    const up = await fetch(`${base}/v1/admin/releases/${rel.id}/files?platform=win32&arch=x64&fileName=FBRX-OS-Setup-1.1.0.exe`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
      body: Buffer.from('fake installer bytes'),
    });
    expect(up.status).toBe(200);
    const devToken = kernel.vault.get('fbrx.fleet.deviceToken', { allowInternal: true })!;
    const feed = () => fetch(`${base}/v1/updates/feed/latest.yml`, { headers: { authorization: `Bearer ${devToken}` } });
    expect((await feed()).status).toBe(404); // not published yet
    await api('PATCH', `/v1/admin/releases/${rel.id}`, { published: true });
    const yml = await (await feed()).text();
    expect(yml).toContain('version: 1.1.0');
    expect(yml).toMatch(/sha512: [A-Za-z0-9+/=]+/);
    const url = /url: '([^']+)'/.exec(yml)![1];
    const file = await fetch(`${base}/v1/updates/feed/${url}`, { headers: { authorization: `Bearer ${devToken}` } });
    expect(await file.text()).toBe('fake installer bytes');
    await api('PATCH', `/v1/admin/releases/${rel.id}`, { rolloutPct: 0 });
    expect((await feed()).status).toBe(404);
  });

  it('enforces roles and tenant isolation', async () => {
    const other = await api('POST', '/v1/admin/tenants', { name: 'Customer B' });
    await api('POST', '/v1/admin/users', { email: 'viewer@b.example', name: 'Vee', role: 'viewer', password: 'Viewer-Password-123' }, { 'x-fbrx-tenant': other.id });
    const vLogin = await (await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'viewer@b.example', password: 'Viewer-Password-123' }) })).json();
    const asViewer = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${vLogin.token}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
    expect(await (await asViewer('/v1/admin/devices')).json()).toEqual([]);
    const [device] = await api('GET', '/v1/admin/devices');
    expect((await asViewer(`/v1/admin/devices/${device.id}`)).status).toBe(403);
    expect((await asViewer(`/v1/admin/devices/${device.id}/commands`, { method: 'POST', body: JSON.stringify({ type: 'ping' }) })).status).toBe(403);
    expect((await asViewer('/v1/admin/releases', { method: 'POST', body: JSON.stringify({ version: '9.9.9', channel: 'stable' }) })).status).toBe(403);
  });

  it('only lets tenants whose license includes fleet management enroll devices, within their seats', async () => {
    const c = await api('POST', '/v1/admin/tenants', { name: 'Customer C' });
    const asC = { 'x-fbrx-tenant': c.id };
    const enroll = async () => {
      const t = await api('POST', '/v1/admin/enrollment-tokens', { label: 'c', maxUses: 5 }, asC);
      return fetch(`${base}/v1/enroll`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: t.token, protocolVersion: 1, device: { name: 'c-1', hostname: 'c-1', platform: 'win32', arch: 'x64', osVersion: '11', appVersion: '1.0.0', machineId: randomBytes(8).toString('hex') } }),
      });
    };
    const pro = await api('POST', '/v1/admin/licenses', { edition: 'pro', seats: 1 }, asC);
    const refused = await enroll();
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.message).toMatch(/does not include fleet management/);
    await api('POST', `/v1/admin/licenses/${pro.id}/revoke`, {}, asC);
    await api('POST', '/v1/admin/licenses', { edition: 'pro', seats: 1, features: ['fleet'] }, asC);
    expect((await enroll()).status).toBe(200);
    const full = await enroll();
    expect(full.status).toBe(403);
    expect((await full.json()).error.message).toMatch(/seat limit/);
  });

  it('joins its tenant on its own when an Endpoint Basic computer activates a license from FBRX Command', async () => {
    const d = await api('POST', '/v1/admin/tenants', { name: 'Customer D' });
    const asD = { 'x-fbrx-tenant': d.id };
    const lic = await api('POST', '/v1/admin/licenses', { edition: 'pro', seats: 3, joinTenant: true }, asD);
    expect(lic).toMatchObject({ tier: 'ultra', commandUrl: base });
    expect(lic.features).toContain('fleet');
    const { publicKeyPem } = await api('GET', '/v1/admin/licensing/public-key');
    const dir = mkdtempSync(join(tmpdir(), 'fbrx-dev-'));
    const k = await Kernel.create({ dataDir: dir, platform: createNodePlatform({ dataDir: dir, devMode: false, keychain: new StaticKeyKeychain(randomBytes(32), 'memory'), licensePublicKeys: [publicKeyPem] }) });
    try {
      k.settings.update({ localApi: { enabled: false }, runtime: { enabled: false }, protection: { shield: { updateSignatures: false } } });
      await k.start();
      expect(k.license.status().tier).toBe('basic');
      const st = (await k.call('license.activate', { key: lic.key }, USER)) as any;
      expect(st).toMatchObject({ state: 'valid', tier: 'ultra', commandUrl: base });
      expect(st.message).toMatch(/Joined Customer D/);
      expect(k.fleet.status().tenantName).toBe('Customer D');
      expect(await api('GET', '/v1/admin/devices', undefined, asD)).toHaveLength(1);
      // Leaving the tenant on purpose sticks: the license does not join it again by itself.
      await k.call('fleet.unenroll', {}, USER);
      expect(await k.joinLicenseTenant('test')).toMatchObject({ joined: false });
      expect(k.fleet.enrolled).toBe(false);
      // The tenant decides the product: an Enterprise license can still run Endpoint Basic.
      expect(await api('POST', '/v1/admin/licenses', { edition: 'enterprise', seats: 0, tier: 'basic' }, asD)).toMatchObject({ tier: 'basic', commandUrl: null });
    } finally {
      await k.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cuts off a retired device immediately', async () => {
    const [device] = await api('GET', '/v1/admin/devices');
    await api('DELETE', `/v1/admin/devices/${device.id}`);
    await waitFor(() => kernel.fleet.status().state === 'error', 20_000);
    expect(kernel.fleet.status().message).toMatch(/rejected|revoked/i);
    const audit = await api('GET', '/v1/admin/audit?limit=200');
    expect(audit.map((a: any) => a.action)).toEqual(expect.arrayContaining(['device.enrolled', 'license.issued', 'command.ping', 'device.retired']));
    expect((await api('GET', '/v1/admin/audit/verify')).ok).toBe(true);
  });
});
