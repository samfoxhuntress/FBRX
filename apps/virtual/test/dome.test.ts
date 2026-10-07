import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DOME_TEST_DOMAIN, type DomeEvent } from '@fbrx/dome';
import type { DomeSensor } from '@fbrx/dome/node';
import { SimulatedApplier } from '@fbrx/gate/node';
import { loadConfig } from '../src/config';
import { buildServer, type BuiltVirtual } from '../src/server';

// FBRX Server as a gate with FBRX MiniDome, the FBRX core (ai role) played by a stand-in.
let dir: string;
let s: BuiltVirtual;
let admin = '';
let operator = '';
let viewer = '';
const calls: Array<{ method: string; params: any }> = [];

class Sensor implements DomeSensor {
  readonly name = 'test';
  emit: (e: DomeEvent) => void = () => undefined;
  start(emit: (e: DomeEvent) => void) {
    this.emit = emit;
  }
  stop() {}
  status() {
    return { name: this.name, ok: true, detail: 'test' };
  }
}
const sensor = new Sensor();

const coreFetch = (async (url: string, init?: RequestInit) => {
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  if (String(url).endsWith('/v1/health')) return json({ ok: true, version: '1.9.5' });
  const { method, params } = JSON.parse(String(init?.body ?? '{}'));
  calls.push({ method, params });
  if (method === 'ai.quick') return json({ result: { answer: 'Most likely something on the phone tried to reach a bad site. Run a scan.', model: 'm' } });
  if (method === 'mesh.network.notify') return json({ result: { delivered: params.address === '192.168.1.120' ? 'Sam phone' : null } });
  if (method === 'mesh.network.computers') return json({ result: [{ id: 'd1', name: 'Sam phone', online: true, addresses: ['192.168.1.120'], protection: { name: 'FBRX Shield', state: 'protected', realtime: true, threats: 0 } }] });
  return new Response(JSON.stringify({ error: { message: `no ${method}` } }), { status: 404 });
}) as typeof fetch;

const req = async (method: string, url: string, token: string, payload?: unknown) => {
  const r = await s.app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${token}` }, payload: payload as never });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fbrx-dome-api-'));
  const tokenFile = join(dir, 'console.token');
  writeFileSync(tokenFile, 'fbrx_console_x\n', { mode: 0o600 });
  const config = loadConfig({
    FBRX_V_DATA_DIR: dir,
    FBRX_V_ROLES: 'gate,minidome,ai',
    FBRX_V_GATE: 'simulated',
    FBRX_V_GATE_WAN: 'eno1',
    FBRX_V_GATE_LAN: 'eno2',
    FBRX_V_GATE_FIRST: 'commit',
    FBRX_V_TLS: 'off',
    FBRX_V_LOG_LEVEL: 'silent',
    FBRX_V_SYS_ROOT: join(dir, 'no-sysfs'),
    FBRX_V_ADMIN_USER: 'sam',
    FBRX_V_ADMIN_PASSWORD: 'correct horse battery',
    FBRX_V_CORE_URL: 'http://127.0.0.1:1/',
    FBRX_V_CORE_TOKEN_FILE: tokenFile,
  });
  s = await buildServer(config, { gateApplier: new SimulatedApplier(), domeSensors: [sensor], coreFetch });
  const login = async (username: string, password: string) => (await s.app.inject({ method: 'POST', url: '/v1/auth/login', payload: { username, password } })).json().token as string;
  admin = await login('sam', 'correct horse battery');
  await req('POST', '/v1/users', admin, { username: 'olly', password: 'operator password', role: 'operator' });
  await req('POST', '/v1/users', admin, { username: 'vic', password: 'viewer password', role: 'viewer' });
  operator = await login('olly', 'operator password');
  viewer = await login('vic', 'viewer password');
});
afterAll(async () => {
  await s.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('FBRX MiniDome on FBRX Server', () => {
  it('reports what it hears, by device, and tells the FBRX computer it is about', async () => {
    const st = await req('GET', '/v1/dome', viewer);
    expect(st.body).toMatchObject({ mode: 'simulated', settings: { enabled: true, sensitivity: 'normal' }, learningUntil: expect.any(String) });
    sensor.emit({ type: 'lease', at: Date.now(), ip: '192.168.1.120', mac: 'aa:bb:cc:00:00:01', name: 'sam-phone', network: 'lan' });
    sensor.emit({ type: 'dns', at: Date.now(), client: '192.168.1.120', name: `x.${DOME_TEST_DOMAIN}`, qtype: 'A' });
    await wait(30);
    const list = (await req('GET', '/v1/dome/findings?status=active', viewer)).body.findings;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: 'bad-domain', title: 'sam-phone asked for a known-bad name', notified: 'Sam phone', device: { network: 'lan' } });
    expect(calls.find((c) => c.method === 'mesh.network.notify')?.params).toMatchObject({ address: '192.168.1.120', finding: { kind: 'bad-domain', severity: 'serious' } });
    const devices = (await req('GET', '/v1/dome/devices', viewer)).body.devices;
    expect(devices[0]).toMatchObject({ mac: 'aa:bb:cc:00:00:01', fbrx: { name: 'Sam phone', protection: { name: 'FBRX Shield' } } });
  });

  it('lets operators handle findings and ask the AI about them; administrators block and set it up', async () => {
    const f = (await req('GET', '/v1/dome/findings', viewer)).body.findings[0];
    expect((await req('POST', `/v1/dome/findings/${f.id}`, viewer, { status: 'acknowledged' })).status).toBe(403);
    expect((await req('POST', `/v1/dome/findings/${f.id}`, operator, { status: 'acknowledged' })).body.finding.status).toBe('acknowledged');
    const ex = await req('POST', `/v1/dome/findings/${f.id}/explain`, operator);
    expect(ex.body.answer).toMatch(/Run a scan/);
    expect(calls.find((c) => c.method === 'ai.quick')?.params.prompt).toContain('sam-phone asked for a known-bad name');
    expect((await req('POST', `/v1/dome/findings/${f.id}/block`, operator)).status).toBe(403);
    const blocked = await req('POST', `/v1/dome/findings/${f.id}/block`, admin);
    expect(blocked.body.domain).toBe('fbrx.invalid');
    expect(blocked.body.state.candidate.dns.block).toMatchObject({ enabled: true, domains: ['fbrx.invalid'] });
    expect(blocked.body.state.changes.length).toBeGreaterThan(0);
    expect((await req('PUT', '/v1/dome/settings', operator, { settings: {} })).status).toBe(403);
    const bad = await req('PUT', '/v1/dome/settings', admin, { settings: { enabled: true, sensitivity: 'paranoid', feeds: [], allow: [], notifyComputers: true, newDevices: true } });
    expect(bad.status).toBe(400);
    const ok = await req('PUT', '/v1/dome/settings', admin, { settings: { enabled: true, sensitivity: 'high', feeds: [], allow: ['Example.org'], notifyComputers: false, newDevices: true } });
    expect(ok.body.settings).toMatchObject({ sensitivity: 'high', allow: ['example.org'], notifyComputers: false });
    expect(s.ctx.audit.list(30).map((e) => e.action)).toEqual(expect.arrayContaining(['dome.acknowledged', 'dome.block', 'dome.settings']));
  });

  it('shows the MiniDome role to the console', async () => {
    expect((await req('GET', '/v1/auth/me', viewer)).body.roles).toEqual(['gate', 'minidome', 'ai']);
  });
});
