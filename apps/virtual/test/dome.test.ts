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

describe('Fabrix on a computer looks at the network through the server', () => {
  it('gets read-only access from an administrator, sees the gate and MiniDome, and can give its access up', async () => {
    expect((await req('POST', '/v1/auth/app-tokens', operator, { name: 'Fabrix on sam-laptop' })).status).toBe(403);
    const t = (await req('POST', '/v1/auth/app-tokens', admin, { name: 'Fabrix on sam-laptop' })).body;
    expect(t.token).toMatch(/^fbvapp_/);
    expect((await req('GET', '/v1/auth/app-tokens', admin)).body.tokens).toEqual([expect.objectContaining({ id: t.id, name: 'Fabrix on sam-laptop', createdBy: 'sam' })]);
    // A viewer: it reads, never changes.
    expect((await req('GET', '/v1/auth/me', t.token)).body.user).toMatchObject({ username: 'app:Fabrix on sam-laptop', role: 'viewer' });
    expect((await req('PUT', '/v1/gate/candidate', t.token, { config: {} })).status).toBe(403);
    expect((await req('GET', '/v1/auth/app-tokens', t.token)).status).toBe(403);

    sensor.emit({ type: 'dns', at: Date.now(), client: '192.168.1.120', name: `again.${DOME_TEST_DOMAIN}`, qtype: 'A' });
    await wait(30);
    const r = (await req('GET', '/v1/troubleshoot', t.token)).body;
    expect(r.server).toMatchObject({ roles: ['gate', 'minidome', 'ai'], warnings: expect.any(Array) });
    expect(r.gate).toMatchObject({ mode: 'simulated', committed: true, wan: { interface: 'eno1' }, dns: { blocking: expect.any(Boolean) }, problems: expect.any(Array) });
    expect(r.gate.networks[0]).toMatchObject({ interface: expect.any(String), address: expect.stringMatching(/\/\d+$/), dhcp: true });
    expect(r.dome).toMatchObject({ mode: 'simulated', sensors: [{ name: 'test', ok: true }] });
    expect(r.dome.findings[0]).toMatchObject({ severity: 'serious', title: expect.stringContaining('known-bad name'), device: 'sam-phone' });
    // Nothing secret goes out.
    expect(JSON.stringify(r)).not.toMatch(/privateKey|password|psk/i);

    // The app gives its own access up; then the token is worthless.
    expect((await req('DELETE', `/v1/auth/app-tokens/${t.id}`, t.token)).body).toEqual({ ok: true });
    expect((await req('GET', '/v1/troubleshoot', t.token)).status).toBe(401);
    const audit = (await req('GET', '/v1/audit', admin)).body.entries.map((e: { action: string }) => e.action);
    expect(audit).toEqual(expect.arrayContaining(['app-token.create', 'app-token.revoke']));
  });
});

describe('FBRX Gate What If', () => {
  it('replays what the gate saw against a change, warns about the console, and has the AI explain it', async () => {
    const st = (await req('GET', '/v1/gate', viewer)).body.state;
    const lan = st.running.networks[0];
    const host = lan.dhcp.start as string;
    // Devices on lan used the web and the gate's console in the last hour.
    sensor.emit({ type: 'flow', at: Date.now(), proto: 'tcp', src: host, dst: '142.250.1.1', dport: 443 });
    sensor.emit({ type: 'flow', at: Date.now(), proto: 'tcp', src: host, dst: '142.250.1.1', dport: 443 });
    // The change: lan loses the internet and may no longer manage the gate.
    const next = structuredClone(st.candidate);
    next.networks[0].access = 'isolated';
    next.networks[0].manage = false;
    expect((await req('PUT', '/v1/gate/candidate', admin, { config: next })).status).toBe(200);

    const r = await s.app.inject({ method: 'GET', url: '/v1/gate/whatif', headers: { authorization: `Bearer ${viewer}` }, remoteAddress: host });
    const w = r.json();
    expect(w.you).toMatchObject({ address: host, from: 'lan', before: { verdict: 'allowed' }, after: { verdict: 'blocked' } });
    expect(w.summary).toMatchObject({ youCutOff: true, flowsCutOff: 1 });
    expect(w.flows[0]).toMatchObject({ src: host, dst: '142.250.1.1', port: 443, count: 2, before: { verdict: 'allowed' }, after: { verdict: 'blocked' } });
    expect(w.matrix.find((m: { from: string; to: string }) => m.from === 'lan' && m.to === 'wan')).toMatchObject({ after: { verdict: 'blocked' } });

    expect((await req('POST', '/v1/gate/whatif/explain', viewer)).status).toBe(403);
    const ex = await req('POST', '/v1/gate/whatif/explain', operator);
    expect(ex.status).toBe(200);
    const prompt = calls.filter((c) => c.method === 'ai.quick').at(-1)!.params.prompt as string;
    expect(prompt).toContain('lan → the internet (web): now allowed');
    expect(prompt).toMatch(/1 would be cut off/);
    await req('POST', '/v1/gate/candidate/reset', admin, {});
  });
});
