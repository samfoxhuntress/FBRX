import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomBytes, X509Certificate } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FleetProbe, FleetStatus, TicketDetail } from '@fbrx/shared';
import { certificateInfo, createSelfSignedCertificate } from '@fbrx/shared/node';
import { buildServer, type BuiltServer } from '../src/server';
import { loadConfig } from '../src/config';
import { loadTls } from '../src/tls';
import { Kernel } from '../../../packages/core/src/kernel';
import { createNodePlatform } from '../../../packages/core/src/node-platform';
import { StaticKeyKeychain } from '../../../packages/core/src/platform';

const USER = { origin: 'user' as const, actor: 'tester' };
const PASSWORD = 'Super-Secret-Admin-Pass-1';

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

describe('self-signed certificates', () => {
  it('makes a certificate OpenSSL and Node accept, with the names and fingerprint asked for', () => {
    const c = createSelfSignedCertificate({ commonName: 'fbrx-home', names: ['localhost', '127.0.0.1', '192.168.1.20', '::1'] });
    const x = new X509Certificate(c.certPem);
    expect(x.fingerprint256).toBe(c.fingerprint);
    expect(x.subjectAltName).toContain('IP Address:192.168.1.20');
    expect(x.subjectAltName).toContain('DNS:localhost');
    expect(x.verify(x.publicKey)).toBe(true);
    expect(certificateInfo(c.certPem, c.keyPem)).toMatchObject({ fingerprint: c.fingerprint, selfSigned: true, matchesKey: true });
    expect(certificateInfo(c.certPem, createSelfSignedCertificate({ commonName: 'other' }).keyPem).matchesKey).toBe(false);
  });

  it('keeps FBRX Command’s certificate across restarts, so computers that trusted it keep working', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'fbrx-cp-tls-'));
    try {
      const config = loadConfig({}, { dataDir, tls: { mode: 'self-signed', names: ['command.example.lan'] } });
      const first = loadTls(config)!;
      const again = loadTls(config)!;
      expect(again.fingerprint).toBe(first.fingerprint);
      expect(first.selfSigned).toBe(true);
      expect(new X509Certificate(first.cert).subjectAltName).toContain('DNS:command.example.lan');
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

/**
 * FBRX Command on a home or school network: HTTPS with its own certificate, a plain local address for the console on
 * the same computer, and computers that join only after the fingerprint is checked, then trust nothing else.
 */
describe('FBRX Command with its own certificate', () => {
  let server: BuiltServer;
  let base: string;
  let local: string;
  let dataDir: string;
  let token: string;
  let tenantId: string;
  const kernels: Array<{ k: Kernel; dir: string }> = [];

  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${local}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'x-fbrx-tenant': tenantId ?? '', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (res.status >= 400) throw new Error(`${res.status} ${JSON.stringify(json)}`);
    return json as any;
  };

  const computer = async (name: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'fbrx-tls-pc-'));
    const k = await Kernel.create({ dataDir: dir, platform: createNodePlatform({ dataDir: dir, devMode: false, keychain: new StaticKeyKeychain(randomBytes(32), 'memory') }) });
    kernels.push({ k, dir });
    k.settings.update({ localApi: { enabled: false }, runtime: { enabled: false }, profile: { name } });
    await k.start();
    return k;
  };

  beforeAll(async () => {
    delete process.env.FBRX_ALLOW_INSECURE_FLEET;
    dataDir = mkdtempSync(join(tmpdir(), 'fbrx-cp-tls-'));
    server = await buildServer(loadConfig({}, { dataDir, port: 0, host: '127.0.0.1', logLevel: 'silent', setupToken: 'setup-token-123', adminConsoleDir: null, heartbeatSeconds: 10, tls: { mode: 'self-signed', names: [] } }));
    await server.app.listen({ port: 0, host: '127.0.0.1' });
    base = `https://127.0.0.1:${(server.app.server.address() as AddressInfo).port}`;
    server.ctx.config.publicUrl = base;
    local = `http://127.0.0.1:${await server.listenLocal(0)}`;
    const setup = await (await fetch(`${local}/v1/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ setupToken: 'setup-token-123', organization: 'The Rivera family', kind: 'home', name: 'Alex', email: 'alex@rivera.example', password: PASSWORD }) })).json();
    tenantId = setup.tenantId;
    token = (await (await fetch(`${local}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'alex@rivera.example', password: PASSWORD }) })).json()).token;
  });

  afterAll(async () => {
    for (const { k, dir } of kernels) {
      await k.stop().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
    await server?.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('serves HTTPS that no authority vouches for, and says which fingerprint to trust', async () => {
    await expect(fetch(`${base}/healthz`)).rejects.toThrow();
    const system = await api('GET', '/v1/admin/system');
    expect(system.certificate).toMatchObject({ fingerprint: server.ctx.tls!.fingerprint, selfSigned: true });
    const qs = await api('POST', `/v1/admin/tenants/${tenantId}/quick-setup`, {});
    expect(qs.groups[0].provisioning).toMatchObject({ serverUrl: base, serverFingerprint: server.ctx.tls!.fingerprint });
  });

  it('joins only after the fingerprint is checked, then works over the pinned certificate', async () => {
    const qs = await api('POST', `/v1/admin/tenants/${tenantId}/quick-setup`, {});
    const parentToken = qs.groups.find((g: any) => g.audience === 'parent').token;
    const k = await computer('Alex laptop');

    const probe = (await k.call('fleet.probe', { serverUrl: base }, USER)) as FleetProbe;
    expect(probe).toMatchObject({ serverUrl: base, local: false, certificate: { fingerprint: server.ctx.tls!.fingerprint, trusted: false } });

    await expect(k.call('fleet.enroll', { serverUrl: base, token: parentToken }, USER)).rejects.toThrow(/uses its own certificate/);
    const wrong = createSelfSignedCertificate({ commonName: 'impostor' }).fingerprint;
    await expect(k.call('fleet.enroll', { serverUrl: base, token: parentToken, fingerprint: wrong }, USER)).rejects.toThrow(/different certificate/);
    await expect(k.call('fleet.enroll', { serverUrl: 'http://command.example.lan:8787', token: parentToken }, USER)).rejects.toThrow(/https/);

    const status = (await k.call('fleet.enroll', { serverUrl: base, token: parentToken, deviceName: 'Alex laptop', fingerprint: probe.certificate!.fingerprint }, USER)) as FleetStatus;
    expect(status.serverFingerprint).toBe(server.ctx.tls!.fingerprint);
    // Live connection (WebSocket) and requests both go over the pinned certificate.
    await waitFor(() => k.fleet.status().state === 'online');
    const t = (await k.call('helpdesk.create', { subject: 'Printer is offline', body: 'It shows a red light.', category: 'computer', priority: 'normal' }, USER)) as TicketDetail;
    expect((await api('GET', `/v1/admin/helpdesk/tickets/${t.id}`)).subject).toBe('Printer is offline');
    const dev = (await api('GET', '/v1/admin/devices')).find((d: any) => d.name === 'Alex laptop');
    expect(dev).toMatchObject({ online: true, audience: 'parent' });
  });

  it('serves the console on this computer over plain HTTP, live updates included', async () => {
    const ws = await new Promise<string>((resolve, reject) => {
      const s = new WebSocket(`${local.replace('http', 'ws')}/v1/admin/ws?token=${token}`);
      s.onopen = () => {
        s.close();
        resolve('open');
      };
      s.onerror = () => reject(new Error('live connection failed'));
    });
    expect(ws).toBe('open');
  });
});
