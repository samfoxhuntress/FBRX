import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SimulatedApplier } from '@fbrx/gate/node';
import type { GateConfig } from '@fbrx/gate';
import { loadConfig } from '../src/config';
import { buildServer, type BuiltVirtual } from '../src/server';

// FBRX Server with the gate role only (no virtual machines), FBRX Gate applying to a simulated system.
let dir: string;
let s: BuiltVirtual;
let admin = '';
let viewer = '';
const applier = new SimulatedApplier();

const req = async (method: string, url: string, token: string | null, payload?: unknown, remoteAddress?: string) => {
  const r = await s.app.inject({ method: method as 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: payload as never, remoteAddress });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fbrx-gate-api-'));
  const config = loadConfig({
    FBRX_V_DATA_DIR: dir,
    FBRX_V_ROLES: 'gate',
    FBRX_V_GATE_WAN: 'eno1',
    FBRX_V_GATE_LAN: 'eno2',
    FBRX_V_TLS: 'off',
    FBRX_V_LOG_LEVEL: 'silent',
    FBRX_V_SYS_ROOT: join(dir, 'no-sysfs'),
    FBRX_V_ADMIN_USER: 'sam',
    FBRX_V_ADMIN_PASSWORD: 'correct horse battery',
  });
  s = await buildServer(config, { gateApplier: applier });
  admin = (await s.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'sam', password: 'correct horse battery' } })).json().token;
  await req('POST', '/v1/users', admin, { username: 'vic', password: 'viewer password', role: 'viewer' });
  viewer = (await s.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username: 'vic', password: 'viewer password' } })).json().token;
});
afterAll(async () => {
  await s.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('FBRX Server as a gate', () => {
  it('runs without the virtual role', async () => {
    expect((await req('GET', '/v1/auth/me', admin)).body).toMatchObject({ driver: 'none', roles: ['gate'] });
    expect((await req('GET', '/v1/vms', admin)).body).toEqual({ vms: [] });
    expect((await req('POST', '/v1/vms', admin, { name: 'x', os: 'linux', cpus: 1, memoryMb: 512, diskGb: 1, network: { kind: 'network', source: 'default' }, firmware: 'bios' })).status).toBe(409);
  });

  it('starts from a starter configuration on the ports it was given', async () => {
    const g = await req('GET', '/v1/gate', viewer);
    expect(g.body.mode).toBe('simulated');
    expect(g.body.state.running).toBeNull();
    expect(g.body.state.candidate.wan.interface).toBe('eno1');
    expect(g.body.state.candidate.networks[0]).toMatchObject({ name: 'lan', interface: 'eno2' });
    expect((await req('GET', '/v1/gate/interfaces', viewer)).body.interfaces.map((i: { name: string }) => i.name)).toContain('eno1');
  });

  it('lets administrators edit and commit, with the problems next to the fields', async () => {
    const cand: GateConfig = (await req('GET', '/v1/gate', admin)).body.state.candidate;
    expect((await req('PUT', '/v1/gate/candidate', viewer, { config: cand })).status).toBe(403);
    // A semantic problem is kept, to fix; a commit is refused with it.
    const bad = structuredClone(cand);
    bad.networks[0].dhcp.end = '10.0.0.9';
    const put = await req('PUT', '/v1/gate/candidate', admin, { config: bad });
    expect(put.status).toBe(200);
    expect(put.body.check.errors[0].path).toBe('networks.lan.dhcp');
    const refused = await req('POST', '/v1/gate/commit', admin, {});
    expect(refused.status).toBe(400);
    expect(refused.body.error.issues[0].message).toMatch(/must be inside/);
    // The wrong shape is not even kept.
    expect((await req('PUT', '/v1/gate/candidate', admin, { config: { ...cand, version: 7 } })).status).toBe(400);

    expect((await req('PUT', '/v1/gate/candidate', admin, { config: cand })).body.check.ok).toBe(true);
    const preview = await req('GET', '/v1/gate/preview', admin);
    expect(preview.body.nftables).toContain('table inet fbrx_gate {');
    const c = await req('POST', '/v1/gate/commit', admin, { comment: 'First light', confirmMinutes: 5 });
    expect(c.status).toBe(200);
    expect(c.body.commit).toMatchObject({ id: 1, status: 'applied', comment: 'First light' });
    expect(c.body.state.confirm.commitId).toBe(1);
    expect(applier.applied).toBe(1);
    expect((await req('POST', '/v1/gate/confirm', admin, {})).body.commit.status).toBe('confirmed');
    expect((await req('POST', '/v1/gate/commit', admin, {})).body.error.message).toMatch(/Nothing to commit/);
    expect(s.ctx.audit.list(20).map((e) => e.action)).toEqual(expect.arrayContaining(['gate.commit', 'gate.confirm']));
    const live = await req('GET', '/v1/gate/live', viewer);
    expect(live.body.interfaces.map((i: { name: string }) => i.name)).toEqual(['eno1', 'eno2']);
  });

  it('makes a VPN device with its settings and a QR code, keeping only its public key', async () => {
    const r = await req('POST', '/v1/gate/vpn/peers', admin, { name: 'Sam phone', endpoint: 'gate.example.com' });
    expect(r.status).toBe(200);
    expect(r.body.peer).toMatchObject({ name: 'Sam phone', address: '10.99.0.2' });
    expect(r.body.config).toMatch(/PrivateKey = [A-Za-z0-9+/]{43}=/);
    expect(r.body.config).toContain('Endpoint = gate.example.com:51820');
    expect(r.body.qr).toMatch(/^data:image\/png;base64,/);
    const cand: GateConfig = r.body.state.candidate;
    expect(cand.vpn.enabled).toBe(true);
    expect(JSON.stringify(cand)).not.toContain(r.body.config.match(/PrivateKey = (\S+)/)[1]);
    expect((await req('POST', '/v1/gate/vpn/peers', admin, { name: 'Sam phone' })).status).toBe(409);
    const second = await req('POST', '/v1/gate/vpn/peers', admin, { name: 'Laptop' });
    expect(second.body.peer.address).toBe('10.99.0.3');
  });

  it('lets the command line in from the gate itself only', async () => {
    const cli = readFileSync(join(dir, 'cli.token'), 'utf8').trim();
    expect((await req('GET', '/v1/gate', cli)).status).toBe(200);
    expect((await req('POST', '/v1/gate/candidate/reset', cli, {})).status).toBe(200);
    expect((await req('GET', '/v1/gate', cli, undefined, '10.0.0.5')).status).toBe(401);
  });
});

describe('a gate set up by the installer', () => {
  it('puts the starter configuration in place at the first start, manageable from the office network outside', async () => {
    const d = mkdtempSync(join(tmpdir(), 'fbrx-gate-first-'));
    const sim = new SimulatedApplier();
    const env = {
      FBRX_V_DATA_DIR: d,
      FBRX_V_ROLES: 'gate',
      FBRX_V_GATE_WAN: 'eno1',
      FBRX_V_GATE_LAN: 'eno2',
      FBRX_V_GATE_FIRST: 'commit',
      FBRX_V_GATE_MANAGE_WAN: '10.20.0.57/24',
      FBRX_V_PORT: '9443',
      FBRX_V_TLS: 'off',
      FBRX_V_LOG_LEVEL: 'silent',
      FBRX_V_SYS_ROOT: join(d, 'no-sysfs'),
    };
    const first = await buildServer(loadConfig(env), { gateApplier: sim });
    try {
      const running = first.ctx.gate!.engine.running()!;
      expect(running.management.consolePort).toBe(9443);
      expect(running.firewall.rules[0]).toMatchObject({ from: 'wan', to: 'gate', ports: '22,9443', source: '10.20.0.0/24', action: 'accept' });
      expect(first.ctx.gate!.engine.history()[0]).toMatchObject({ id: 1, by: 'installer', status: 'confirmed' });
      expect(first.ctx.gate!.engine.state().warnings.map((w) => w.message).join(' ')).not.toMatch(/opens SSH/);
      expect(sim.applied).toBe(1);
    } finally {
      await first.close();
    }
    // Once is enough: the next start applies what runs again, without a new commit.
    const again = await buildServer(loadConfig(env), { gateApplier: sim });
    try {
      expect(again.ctx.gate!.engine.history()).toHaveLength(1);
      expect(sim.applied).toBe(2);
    } finally {
      await again.close();
      rmSync(d, { recursive: true, force: true });
    }
  });
});
