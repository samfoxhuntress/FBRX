import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimulatedApplier } from '@fbrx/gate/node';
import { loadConfig } from '../../../apps/virtual/src/config';
import { buildServer, type BuiltVirtual } from '../../../apps/virtual/src/server';
import { SavedServers } from '../src/system/saved-servers';
import { describeNetworkReport, serverTools } from '../src/tools/builtin/server-tools';

// A real FBRX Server (a gate with MiniDome, its own certificate) and FBRX OS's saved servers talking to it over HTTPS,
// the certificate pinned by its fingerprint.
let dir: string;
let v: BuiltVirtual;
let port = 0;
const meta = new Map<string, unknown>();
const secrets = new Map<string, string>();
const vault = {
  isUnlocked: true,
  get: (name: string) => secrets.get(name),
  set: (i: { name: string; value: string }) => void secrets.set(i.name, i.value),
  delete: (name: string) => secrets.delete(name),
};
const audit: string[] = [];
const servers = new SavedServers({
  meta: { get: (k: string) => meta.get(k), set: (k: string, val: unknown) => void meta.set(k, val) } as never,
  vault: vault as never,
  audit: (action) => void audit.push(action),
  meshServers: () => [],
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fbrx-server-fabrix-'));
  const config = loadConfig({
    FBRX_V_DATA_DIR: dir,
    FBRX_V_ROLES: 'gate,minidome',
    FBRX_V_GATE: 'simulated',
    FBRX_V_GATE_WAN: 'eno1',
    FBRX_V_GATE_LAN: 'eno2',
    FBRX_V_GATE_FIRST: 'commit',
    FBRX_V_LOG_LEVEL: 'silent',
    FBRX_V_SYS_ROOT: join(dir, 'no-sysfs'),
    FBRX_V_ADMIN_USER: 'sam',
    FBRX_V_ADMIN_PASSWORD: 'correct horse battery',
    FBRX_V_TLS_NAMES: '127.0.0.1',
  });
  v = await buildServer(config, { gateApplier: new SimulatedApplier(), domeSensors: [] });
  await v.app.listen({ host: '127.0.0.1', port: 0 });
  port = (v.app.server.address() as AddressInfo).port;
});
afterAll(async () => {
  await v.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Fabrix looks at the network through FBRX Server', () => {
  it('signs in once, keeps only read-only access, reads the gate and MiniDome, and gives it back', async () => {
    const saved = servers.save({ name: 'home-server', address: `127.0.0.1:${port}` });
    expect(saved.fabrix).toBeNull();
    // The server's own certificate: trusted by its fingerprint, as the FBRX Server page does.
    const check = await servers.check(saved.id);
    expect(check.ok).toBe(false);
    servers.trust(saved.id, check.certificate!.fingerprint);
    expect(serverTools(servers)[0].unavailable?.()).toMatch(/Let Fabrix look/);

    await expect(servers.connectFabrix(saved.id, 'sam', 'wrong password')).rejects.toThrow(/user name or password is not right/);
    const on = await servers.connectFabrix(saved.id, 'sam', 'correct horse battery');
    expect(on.fabrix).toMatchObject({ name: expect.stringMatching(/^Fabrix on /), appId: expect.any(String) });
    // Only the server's read-only access is kept, never the password; the sign-in itself ended.
    expect([...secrets.values()]).toEqual([expect.stringMatching(/^fbvapp_/)]);
    expect(JSON.stringify([...meta.values()])).not.toContain('correct horse');
    expect(v.ctx.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sessions')?.n).toBe(0);

    const { report } = await servers.networkReport();
    expect(report.gate).toMatchObject({ committed: true, wan: { interface: 'eno1' } });
    const text = describeNetworkReport('home-server', report);
    expect(text).toContain('FBRX Gate (simulated');
    expect(text).toMatch(/Internet side \(eno1/);
    expect(text).toContain('FBRX MiniDome:');
    expect(serverTools(servers)[0].unavailable?.()).toBeNull();
    await expect(servers.networkReport('office')).rejects.toThrow(/looks at home-server/);

    // Revoked on the server: Fabrix says so instead of failing quietly.
    const tokens = (await v.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'sam', password: 'correct horse battery' } })).json().token as string;
    const list = (await v.app.inject({ method: 'GET', url: '/v1/auth/app-tokens', headers: { authorization: `Bearer ${tokens}` } })).json().tokens;
    expect(list).toHaveLength(1);
    await v.app.inject({ method: 'DELETE', url: `/v1/auth/app-tokens/${list[0].id}`, headers: { authorization: `Bearer ${tokens}` } });
    await expect(servers.networkReport()).rejects.toThrow(/no longer lets Fabrix look/);

    // Again, then stop: the access goes back to the server and is forgotten here.
    await servers.connectFabrix(saved.id, 'sam', 'correct horse battery');
    const off = await servers.disconnectFabrix(saved.id);
    expect(off.fabrix).toBeNull();
    expect(secrets.size).toBe(0);
    const after = (await v.app.inject({ method: 'GET', url: '/v1/auth/app-tokens', headers: { authorization: `Bearer ${tokens}` } })).json().tokens;
    expect(after).toEqual([]);
    expect(audit).toEqual(expect.arrayContaining(['server.fabrix.connected', 'server.fabrix.disconnected']));
  });
});
