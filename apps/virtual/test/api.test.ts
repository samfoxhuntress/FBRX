import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';
import { buildServer, type BuiltVirtual } from '../src/server';
import { SimulatedHypervisor } from '../src/drivers/simulated';

let dir: string;
let s: BuiltVirtual;
let admin = '';
let viewer = '';
let operator = '';

const call = async (method: string, url: string, token: string | null, payload?: unknown) => {
  const r = await s.app.inject({ method: method as 'GET', url, headers: token ? { authorization: `Bearer ${token}` } : {}, payload: payload as never });
  return { status: r.statusCode, body: r.body ? JSON.parse(r.body) : null };
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'fbrx-virtual-'));
  const config = loadConfig({ FBRX_V_DATA_DIR: dir, FBRX_V_DRIVER: 'simulated', FBRX_V_TLS: 'off', FBRX_V_LOG_LEVEL: 'silent', FBRX_V_SYS_ROOT: join(dir, 'no-sysfs'), FBRX_V_SETUP_TOKEN: 'setup-123' });
  s = await buildServer(config, { hypervisor: new SimulatedHypervisor({ dataDir: dir, isosDir: config.isosDir, seed: false }) });
});
afterAll(async () => {
  await s.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('FBRX Virtual API', () => {
  it('sets up the first administrator with the setup code', async () => {
    expect((await call('GET', '/v1/setup', null)).body).toMatchObject({ needed: true, driver: 'simulated' });
    expect((await call('GET', '/v1/vms', null)).status).toBe(401);
    expect((await call('POST', '/v1/setup', null, { setupToken: 'nope', username: 'sam', password: 'correct horse battery' })).status).toBe(401);
    expect((await call('POST', '/v1/setup', null, { setupToken: 'setup-123', username: 'sam', password: 'short' })).status).toBe(400);
    const r = await call('POST', '/v1/setup', null, { setupToken: 'setup-123', username: 'sam', name: 'Sam', password: 'correct horse battery' });
    expect(r.status).toBe(200);
    admin = r.body.token;
    expect(r.body.user).toMatchObject({ username: 'sam', role: 'admin' });
    expect((await call('POST', '/v1/setup', null, { setupToken: 'setup-123', username: 'eve', password: 'correct horse battery' })).status).toBe(403);
    expect((await call('GET', '/v1/auth/me', admin)).body.user.username).toBe('sam');
  });

  it('signs people in with roles', async () => {
    expect((await call('POST', '/v1/users', admin, { username: 'olly', name: 'Olly', password: 'operator password', role: 'operator' })).status).toBe(200);
    expect((await call('POST', '/v1/users', admin, { username: 'vic', password: 'viewer password', role: 'viewer' })).status).toBe(200);
    expect((await call('POST', '/v1/users', admin, { username: 'vic', password: 'viewer password', role: 'viewer' })).status).toBe(409);
    expect((await call('POST', '/v1/auth/login', null, { username: 'vic', password: 'wrong password' })).status).toBe(401);
    viewer = (await call('POST', '/v1/auth/login', null, { username: 'vic', password: 'viewer password' })).body.token;
    operator = (await call('POST', '/v1/auth/login', null, { username: 'OLLY', password: 'operator password' })).body.token;
    expect(viewer).toMatch(/^fbv_/);
    expect((await call('GET', '/v1/users', viewer)).status).toBe(403);
    const users = (await call('GET', '/v1/users', admin)).body.users;
    const me = users.find((u: { username: string }) => u.username === 'sam');
    expect((await call('PATCH', `/v1/users/${me.id}`, admin, { role: 'viewer' })).status).toBe(409); // last administrator
    expect((await call('DELETE', `/v1/users/${me.id}`, admin)).status).toBe(403);
  });

  it('creates, runs, changes and snapshots virtual machines', async () => {
    const spec = { name: 'web-01', os: 'linux', cpus: 2, memoryMb: 2048, diskGb: 20, network: { kind: 'network', source: 'default' }, firmware: 'bios', description: 'Web server' };
    expect((await call('POST', '/v1/vms', viewer, spec)).status).toBe(403);
    expect((await call('POST', '/v1/vms', operator, { ...spec, name: 'bad name!' })).status).toBe(400);
    expect((await call('POST', '/v1/vms', operator, { ...spec, secureBoot: true })).status).toBe(400);
    expect((await call('POST', '/v1/vms', operator, { ...spec, iso: 'missing.iso' })).status).toBe(404);
    const made = await call('POST', '/v1/vms', operator, spec);
    expect(made.status).toBe(200);
    const id = made.body.id;
    expect(made.body).toMatchObject({ name: 'web-01', state: 'stopped', cpus: 2, memoryMb: 2048, diskGb: 20, firmware: 'bios' });
    expect((await call('POST', '/v1/vms', operator, spec)).status).toBe(409);
    const list = await call('GET', '/v1/vms', viewer);
    expect(list.body.vms.map((v: { name: string }) => v.name)).toEqual(['web-01']);

    expect((await call('POST', `/v1/vms/${id}/power`, operator, { action: 'start' })).body.state).toBe('running');
    expect((await call('POST', `/v1/vms/${id}/power`, operator, { action: 'start' })).status).toBe(409);
    expect((await call('POST', `/v1/vms/${id}/snapshots`, operator, { name: 'before-update', description: 'Clean' })).body.snapshots).toHaveLength(1);
    const changed = await call('PATCH', `/v1/vms/${id}`, operator, { cpus: 4, memoryMb: 4096, diskGb: 40, autostart: true });
    expect(changed.body).toMatchObject({ cpus: 4, memoryMb: 4096, diskGb: 40, autostart: true });
    expect((await call('PATCH', `/v1/vms/${id}`, operator, { diskGb: 10 })).status).toBe(400);
    expect((await call('PATCH', `/v1/vms/${id}`, operator, { cpuset: '0-3' })).status).toBe(403); // placement is for administrators
    expect((await call('PATCH', `/v1/vms/${id}`, admin, { cpuset: '0-3' })).body.cpuset).toBe('0-3');
    await call('POST', `/v1/vms/${id}/snapshots/before-update/revert`, operator);
    expect((await call('GET', `/v1/vms/${id}`, viewer)).body).toMatchObject({ cpus: 2, memoryMb: 2048 });
    expect((await call('DELETE', `/v1/vms/${id}/snapshots/before-update`, operator)).body.snapshots).toEqual([]);

    expect((await call('POST', `/v1/vms/${id}/console`, operator)).status).toBe(409); // simulated: no screen
    expect((await call('DELETE', `/v1/vms/${id}`, admin)).status).toBe(409); // running
    await call('POST', `/v1/vms/${id}/power`, operator, { action: 'stop' });
    expect((await call('DELETE', `/v1/vms/${id}`, operator)).status).toBe(403);
    expect((await call('DELETE', `/v1/vms/${id}`, admin)).status).toBe(200);
    expect((await call('GET', `/v1/vms/${id}`, admin)).status).toBe(404);
  });

  it('keeps an ISO library and puts ISOs in CD drives', async () => {
    const up = await s.app.inject({ method: 'PUT', url: '/v1/isos/tiny.iso', headers: { authorization: `Bearer ${operator}`, 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(4096, 1) });
    expect(up.statusCode).toBe(200);
    expect(JSON.parse(up.body)).toMatchObject({ name: 'tiny.iso', sizeBytes: 4096 });
    const again = await s.app.inject({ method: 'PUT', url: '/v1/isos/tiny.iso', headers: { authorization: `Bearer ${operator}`, 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(10) });
    expect(again.statusCode).toBe(409);
    expect((await s.app.inject({ method: 'PUT', url: '/v1/isos/..%2Fevil.iso', headers: { authorization: `Bearer ${operator}`, 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(10) })).statusCode).toBe(400);
    const vm = (await call('POST', '/v1/vms', operator, { name: 'installer', os: 'linux', cpus: 1, memoryMb: 1024, diskGb: 8, network: { kind: 'network', source: 'default' }, firmware: 'uefi', iso: 'tiny.iso' })).body;
    expect(vm.isoName ?? vm.iso).toBeTruthy();
    expect((await call('GET', `/v1/vms/${vm.id}`, viewer)).body.isoName).toBe('tiny.iso');
    const isos = (await call('GET', '/v1/isos', viewer)).body.isos;
    expect(isos[0]).toMatchObject({ name: 'tiny.iso', usedBy: ['installer'] });
    expect((await call('DELETE', '/v1/isos/tiny.iso', operator)).status).toBe(409);
    expect((await call('PATCH', `/v1/vms/${vm.id}`, operator, { iso: null })).body.iso).toBeNull();
    expect((await call('DELETE', '/v1/isos/tiny.iso', operator)).status).toBe(200);
    expect((await call('POST', '/v1/isos/download', operator, { url: 'ftp://example.com/x.iso', name: 'x.iso' })).status).toBe(400);
  });

  it('manages networks', async () => {
    expect((await call('POST', '/v1/networks', operator, { name: 'lab', kind: 'isolated', subnet: '10.50.0.0/24' })).status).toBe(403);
    expect((await call('POST', '/v1/networks', admin, { name: 'lab', kind: 'isolated', subnet: '8.8.8.0/24' })).status).toBe(400);
    expect((await call('POST', '/v1/networks', admin, { name: 'lab', kind: 'isolated', subnet: '10.50.0.0/24' })).body).toMatchObject({ name: 'lab', kind: 'isolated', subnet: '10.50.0.0/24' });
    const nets = (await call('GET', '/v1/networks', viewer)).body.networks;
    expect(nets.map((n: { name: string }) => n.name)).toEqual(expect.arrayContaining(['default', 'lab', 'br0']));
    expect((await call('DELETE', '/v1/networks/default', admin)).status).toBe(409); // "installer" uses it
    expect((await call('DELETE', '/v1/networks/lab', admin)).status).toBe(200);
  });

  it('shows the host and the hardware (a sample server here) and steers interrupts', async () => {
    const host = (await call('GET', '/v1/host', viewer)).body;
    expect(host.hypervisor.driver).toBe('simulated');
    expect(host.warnings[0]).toMatch(/Simulated/);
    const topo = (await call('GET', '/v1/hardware/topology', viewer)).body;
    expect(topo.source).toBe('sample');
    const nic = topo.devices.find((d: { kind: string }) => d.kind === 'network');
    expect((await call('PUT', `/v1/hardware/devices/${nic.address}/irqs`, operator, { cpus: '0-3' })).status).toBe(403);
    const moved = (await call('PUT', `/v1/hardware/devices/${nic.address}/irqs`, admin, { cpus: '2-3' })).body;
    expect(moved.topology.pinned[nic.address]).toBe('2-3');
    expect(moved.topology.devices.find((d: { address: string }) => d.address === nic.address).irqs[0].cpus).toBe('2-3');
    expect((await call('PUT', `/v1/hardware/devices/${nic.address}/irqs`, admin, { cpus: '0-99' })).status).toBe(400);
    const flows = (await call('GET', '/v1/hardware/flows', viewer)).body;
    expect(flows.items.length).toBeGreaterThan(0);

    const vm = (await call('GET', '/v1/vms', admin)).body.vms[0];
    const given = await call('POST', `/v1/vms/${vm.id}/hostdevs`, admin, { address: nic.address });
    expect(given.body.hostdevs[0].address).toBe(nic.address);
    expect((await call('POST', `/v1/vms/${vm.id}/hostdevs`, admin, { address: nic.address })).status).toBe(409);
    expect((await call('GET', '/v1/hardware/topology', viewer)).body.devices.find((d: { address: string }) => d.address === nic.address).passthroughVm).toBe('installer');
    expect((await call('DELETE', `/v1/vms/${vm.id}/hostdevs/${nic.address}`, admin)).body.hostdevs).toEqual([]);
  });

  it('answers server management questions only once connected', async () => {
    expect((await call('GET', '/v1/bmc', viewer)).body.config).toBeNull();
    expect((await call('GET', '/v1/bmc/bios', viewer)).status).toBe(409);
    expect((await call('PUT', '/v1/bmc', operator, { host: 'x', username: 'a', password: 'b', fingerprint: null })).status).toBe(403);
  });

  it('keeps an audit log', async () => {
    expect((await call('GET', '/v1/audit', operator)).status).toBe(403);
    const entries = (await call('GET', '/v1/audit', admin)).body.entries as Array<{ action: string; outcome: string; actor: string }>;
    expect(entries.some((e) => e.action === 'vm.create' && e.actor === 'olly' && e.outcome === 'success')).toBe(true);
    expect(entries.some((e) => e.action === 'auth.login' && e.outcome === 'failure')).toBe(true);
    expect(entries.some((e) => e.action === 'hardware.irqs')).toBe(true);
  });

  it('signs out', async () => {
    await call('POST', '/v1/auth/logout', viewer);
    expect((await call('GET', '/v1/vms', viewer)).status).toBe(401);
  });
});
