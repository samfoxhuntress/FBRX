import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { NetEnvOverview, NetEnvProbe } from '@fbrx/shared';
import { makeKernel, USER } from './helpers';

// Two throwaway self-signed certificates (test fixtures only), like the ones UniFi consoles make for themselves.
const CERT_A = `-----BEGIN CERTIFICATE-----
MIIBrjCCAVWgAwIBAgIUQISTrv93Sc8DVe/vu172qNBhEcIwCgYIKoZIzj0EAwIw
LDETMBEGA1UEAwwKdW5pZmkudGVzdDEVMBMGA1UECgwMVGVzdCBDb25zb2xlMCAX
DTI2MTAwNTE1MTMxNVoYDzIxMjYwOTExMTUxMzE1WjAsMRMwEQYDVQQDDAp1bmlm
aS50ZXN0MRUwEwYDVQQKDAxUZXN0IENvbnNvbGUwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAARk1llwr5ATV4OFWfYAVJWyhgrch1EtMu0tZTL0adQXX4wWOq2g3MWK
/I2TAV0g+roTfZ02fMtMvloMG+9B7ysWo1MwUTAdBgNVHQ4EFgQU50gACjme1g8O
Z+K9WWDBJhaXWBcwHwYDVR0jBBgwFoAU50gACjme1g8OZ+K9WWDBJhaXWBcwDwYD
VR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNHADBEAiBm4cuKv1VpvpVZxQZDp4Jf
eLCvzuspNxeIEJQac5nJJAIgHvEbfpk+/pUlMUs+GV19ABBh+ae4aNmPCUgmz4sf
Gok=
-----END CERTIFICATE-----`;
const KEY_A = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgsLOYkpdaJV9K1I1A
f/nHDX+p8B5DKjw1tS5gRCkRPV6hRANCAARk1llwr5ATV4OFWfYAVJWyhgrch1Et
Mu0tZTL0adQXX4wWOq2g3MWK/I2TAV0g+roTfZ02fMtMvloMG+9B7ysW
-----END PRIVATE KEY-----`;
const CERT_B = `-----BEGIN CERTIFICATE-----
MIIBrzCCAVWgAwIBAgIUd1HHhaTOnF/bKlNy7y+T6DsYlkowCgYIKoZIzj0EAwIw
LDETMBEGA1UEAwwKdW5pZmkudGVzdDEVMBMGA1UECgwMVGVzdCBDb25zb2xlMCAX
DTI2MTAwNTE1MTMxNVoYDzIxMjYwOTExMTUxMzE1WjAsMRMwEQYDVQQDDAp1bmlm
aS50ZXN0MRUwEwYDVQQKDAxUZXN0IENvbnNvbGUwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAQUmIRyly6tOnmZz3PXwChWx5tuXRWUg/oE79UUK1MvoRWMF/mDPjm9
w/wT6eNJOZmsQjvm3ngfM11zJhwWmA3jo1MwUTAdBgNVHQ4EFgQU0GmOd2H9F0Rt
cqgldJxytB89RaIwHwYDVR0jBBgwFoAU0GmOd2H9F0RtcqgldJxytB89RaIwDwYD
VR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNIADBFAiEAzlJ9Q282pNaqZihSgAy2
xdiBjKMspmYHmYCTxcrnbiACIEmjA67gFPPMt4hfNH8p/xeg9XaD+QyV9FmimqT3
8g76
-----END CERTIFICATE-----`;
const KEY_B = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgbtyB5T70lkURmDjF
er8mtuLAYPZh4rXe1OmXHE9iQFOhRANCAAQUmIRyly6tOnmZz3PXwChWx5tuXRWU
g/oE79UUK1MvoRWMF/mDPjm9w/wT6eNJOZmsQjvm3ngfM11zJhwWmA3j
-----END PRIVATE KEY-----`;

const KEY = 'unifi-test-key';

/** A UniFi console's Network API: sites, devices, clients, statistics, a restart action and guest vouchers. */
function mockConsole(cert: string, key: string) {
  const seen: Array<{ method: string; path: string; body: string }> = [];
  const server: Server = createServer({ cert, key }, (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'https://x');
      seen.push({ method: req.method ?? '', path: url.pathname, body });
      const json = (status: number, b: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(b));
      if (req.headers['x-api-key'] !== KEY) return json(401, { statusCode: 401, statusName: 'UNAUTHORIZED', message: 'Unauthorized' });
      const p = url.pathname.replace('/proxy/network/integration/v1', '');
      const page = (data: unknown[]) => json(200, { offset: 0, limit: 200, count: data.length, totalCount: data.length, data });
      if (p === '/info') return json(200, { applicationVersion: '9.4.19' });
      if (p === '/sites') return page([{ id: 'site-1', internalReference: 'default', name: 'Main campus' }]);
      if (p === '/sites/site-1/devices')
        return page([
          { id: 'dev-gw', name: 'Gateway', model: 'UDM Pro', macAddress: 'f0:9f:c2:00:00:01', ipAddress: '10.0.0.1', state: 'ONLINE', features: ['switching'], firmwareUpdatable: false },
          { id: 'dev-ap1', name: 'AP Library', model: 'U7 Pro', macAddress: 'f0:9f:c2:00:00:02', ipAddress: '10.0.0.21', state: 'ONLINE', features: ['accessPoint'], firmwareUpdatable: true },
          { id: 'dev-ap2', name: 'AP Gym', model: 'U6 LR', macAddress: 'f0:9f:c2:00:00:03', ipAddress: '10.0.0.22', state: 'OFFLINE', features: ['accessPoint'] },
        ]);
      if (p === '/sites/site-1/clients')
        return page([
          { type: 'WIRELESS', id: 'c1', name: 'Room 12 MacBook', ipAddress: '10.0.1.50', macAddress: 'aa:bb:cc:00:00:01', uplinkDeviceId: 'dev-ap1', connectedAt: '2026-10-05T08:00:00Z' },
          { type: 'WIRED', id: 'c2', name: 'Office printer', ipAddress: '10.0.1.9', macAddress: 'aa:bb:cc:00:00:02', uplinkDeviceId: 'dev-gw' },
        ]);
      if (p === '/sites/site-1/devices/dev-ap1') return json(200, { id: 'dev-ap1', name: 'AP Library', model: 'U7 Pro', macAddress: 'f0:9f:c2:00:00:02', state: 'ONLINE', firmwareVersion: '8.0.21' });
      if (p === '/sites/site-1/devices/dev-ap1/statistics/latest') return json(200, { uptimeSec: 90061, cpuUtilizationPct: 12.5, memoryUtilizationPct: 41, loadAverage1Min: 0.3, uplink: { txRateBps: 2_000_000, rxRateBps: 9_000_000 } });
      if (p === '/sites/site-1/devices/dev-ap1/actions' && req.method === 'POST') return json(200, {});
      if (p === '/sites/site-1/hotspot/vouchers' && req.method === 'POST') {
        const b = JSON.parse(body);
        return json(201, { vouchers: Array.from({ length: b.count }, (_, i) => ({ id: `v${i}`, code: `1234${i}56789`, name: b.name, timeLimitMinutes: b.timeLimitMinutes, expired: false })) });
      }
      if (p === '/sites/site-1/hotspot/vouchers') return page([]);
      json(404, { statusCode: 404, message: 'Not found' });
    });
  });
  return { server, seen, url: () => `https://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const listen = (s: Server) => new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));

describe('network environments (UniFi)', () => {
  it('trusts a self-signed console by fingerprint, reads the network, and refuses a swapped certificate', async () => {
    const { kernel, cleanup } = await makeKernel();
    const unifi = mockConsole(CERT_A, KEY_A);
    await listen(unifi.server);
    try {
      // First contact: the certificate is not vouched for, so nothing is sent until its fingerprint is trusted.
      const first = (await kernel.call('netenv.probe', { url: unifi.url(), apiKey: KEY }, USER)) as NetEnvProbe;
      expect(first.ok).toBe(false);
      expect(first.certificate?.subject).toContain('unifi.test');
      expect(unifi.seen).toHaveLength(0);

      const fp = first.certificate!.fingerprint;
      const wrongKey = (await kernel.call('netenv.probe', { url: unifi.url(), apiKey: 'nope', fingerprint: fp }, USER)) as NetEnvProbe;
      expect(wrongKey.ok).toBe(false);
      expect(wrongKey.message).toMatch(/did not accept the API key/);

      const ok = (await kernel.call('netenv.probe', { url: unifi.url(), apiKey: KEY, fingerprint: fp }, USER)) as NetEnvProbe;
      expect(ok).toMatchObject({ ok: true, version: '9.4.19', sites: [{ id: 'site-1', name: 'Main campus' }] });

      const env = (await kernel.call('netenv.save', { kind: 'unifi', name: 'Hillside', url: unifi.url(), apiKey: KEY, fingerprint: fp, defaultSiteId: 'site-1' }, USER)) as { id: string; trust: string; hasKey: boolean };
      expect(env).toMatchObject({ trust: 'pinned', hasKey: true });
      expect(JSON.stringify(await kernel.call('netenv.list', undefined, USER))).not.toContain(KEY);

      const o = (await kernel.call('netenv.overview', { id: env.id }, USER)) as NetEnvOverview;
      expect(o.devices.map((d) => [d.name, d.state, d.roles[0]])).toEqual([
        ['Gateway', 'online', 'gateway'],
        ['AP Library', 'online', 'access point'],
        ['AP Gym', 'offline', 'access point'],
      ]);
      expect(o.clients[0]).toMatchObject({ name: 'Room 12 MacBook', type: 'wireless', uplinkDeviceId: 'dev-ap1' });

      const stats = (await kernel.call('netenv.deviceStats', { id: env.id, deviceId: 'dev-ap1' }, USER)) as any;
      expect(stats).toMatchObject({ cpuPct: 12.5, memPct: 41, device: { firmware: '8.0.21' } });

      // The agent sees the network but never the key; restarting waits for approval.
      const overview = await kernel.gate.invoke('network_env.overview', {}, { origin: 'agent', actor: 'agent:test' });
      expect(overview.ok).toBe(true);
      expect(overview.output).toContain('1 offline');
      expect(overview.output).toContain('AP Gym');
      expect(overview.output).not.toContain(KEY);
      const found = await kernel.gate.invoke('network_env.clients', { search: 'printer' }, { origin: 'agent', actor: 'agent:test' });
      expect(found.output).toContain('Office printer');
      expect(found.output).toContain('on Gateway');

      await kernel.call('netenv.deviceAction', { id: env.id, deviceId: 'dev-ap1', action: 'restart' }, USER);
      expect(unifi.seen.find((s) => s.path.endsWith('/actions'))?.body).toBe('{"action":"RESTART"}');

      const codes = (await kernel.call('netenv.createVouchers', { id: env.id, name: 'Parent night', count: 2, timeLimitMinutes: 240 }, USER)) as any[];
      expect(codes.map((c) => c.code)).toEqual(['1234056789', '1234156789']);

      // Someone swaps the console's certificate: FBRX stops before sending the key.
      const before = unifi.seen.length;
      unifi.server.setSecureContext({ cert: CERT_B, key: KEY_B });
      await expect(kernel.call('netenv.overview', { id: env.id }, USER)).rejects.toThrow(/different certificate/);
      expect(unifi.seen.length).toBe(before);
      expect(((await kernel.call('netenv.list', undefined, USER)) as any[])[0].lastError).toMatch(/different certificate/);
    } finally {
      unifi.server.close();
      await cleanup();
    }
  });

  it('is part of Endpoint Ultra: Basic refuses it and the agent does not see the tools', async () => {
    const { kernel, cleanup } = await makeKernel({ devMode: false });
    try {
      await expect(kernel.call('netenv.probe', { url: 'https://192.0.2.1', apiKey: KEY }, USER)).rejects.toThrow(/Endpoint Ultra/);
      const r = await kernel.gate.invoke('network_env.overview', {}, { origin: 'agent', actor: 'agent:test' });
      expect(r.ok).toBe(false);
      expect(r.output).toMatch(/Endpoint Ultra/);
    } finally {
      await cleanup();
    }
  });
});
