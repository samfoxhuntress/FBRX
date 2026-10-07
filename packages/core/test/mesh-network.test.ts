import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { meshQosNftables } from '@fbrx/shared';
import { makeKernel, waitFor, USER } from './helpers';
import { MeshNetwork, type MeshNetworkSettings } from '../src/mesh/mesh-network';
import type { Kernel } from '../src/kernel';

const settings = (o: Partial<MeshNetworkSettings> = {}): MeshNetworkSettings => ({ preferMesh: true, subnets: ['10.20.0.0/24'], trafficClass: 'af41', jumbo: true, ...o });

describe('Prefer Mesh: this computer', () => {
  it('finds the mesh network, its MTU, and what is not set up yet', async () => {
    const calls: string[][] = [];
    const net = new MeshNetwork({
      settings: () => settings(),
      port: () => 47800,
      peers: () => [],
      hello: async () => ({}),
      elevated: async () => false,
      platform: 'linux',
      interfaces: () => ({
        eno1: [{ address: '192.168.1.20', netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:01', internal: false, cidr: '192.168.1.20/24' }],
        'eno2.20': [{ address: '10.20.0.5', netmask: '255.255.255.0', family: 'IPv4', mac: '00:00:00:00:00:02', internal: false, cidr: '10.20.0.5/24' }],
        lo: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', mac: '00:00:00:00:00:00', internal: true, cidr: '127.0.0.1/8' }],
      }),
      mtu: async (iface) => (iface === 'eno2.20' ? 1500 : 1500),
      exec: async (cmd, args) => {
        calls.push([cmd, ...args]);
        return { code: 1, out: '', err: 'Error: No such file or directory; did you mean table ‘fbrx_mesh’ in family inet?' };
      },
    });
    const st = await net.status();
    expect(st.local.map((a) => [a.iface, a.preferred])).toEqual([
      ['eno2.20', true],
      ['eno1', false],
    ]);
    expect(st.dscp).toBe(34);
    expect(st.qos).toMatchObject({ method: 'nftables', applied: false, canApply: false });
    expect(st.qos.script).toContain('ip dscp set af41');
    expect(st.warnings.join(' ')).toMatch(/eno2\.20 \(10\.20\.0\.5\) has an MTU of 1500/);
    expect(st.warnings.join(' ')).toMatch(/not marked/);
    await expect(net.applyQos()).rejects.toThrow(/needs root/);
    expect(calls[0]).toEqual(['nft', 'list', 'table', 'inet', 'fbrx_mesh']);
  });

  it('tests the round trip and whether jumbo frames get through', async () => {
    const net = new MeshNetwork({
      settings: () => settings(),
      port: () => 47800,
      peers: () => [
        { id: 'a', name: 'server-a', address: '10.20.0.6' },
        { id: 'b', name: 'server-b', address: '192.168.1.30' },
      ],
      hello: async (id) => {
        if (id === 'b') throw new Error('server-b is not reachable');
        return {};
      },
      elevated: async () => true,
      platform: 'linux',
      interfaces: () => ({}),
      exec: async (_cmd, args) =>
        args.includes('10.20.0.6')
          ? { code: 0, out: '9008 bytes from 10.20.0.6: icmp_seq=1 ttl=64 time=0.3 ms', err: '' }
          : { code: 1, out: '', err: 'ping: local error: message too long, mtu=1500' },
    });
    const [a, b] = await net.test();
    expect(a).toMatchObject({ peerName: 'server-a', preferred: true, error: null, jumbo: { tested: true, ok: true } });
    expect(a.rttMs).toBeGreaterThanOrEqual(0);
    expect(b).toMatchObject({ peerName: 'server-b', preferred: false, rttMs: null, error: 'server-b is not reachable', jumbo: { tested: true, ok: false } });
  });
});

// The marking itself, on the real kernel: needs root and nftables (Linux CI runs it with sudo; skipped elsewhere).
const canNetns = process.platform === 'linux' && process.getuid?.() === 0 && spawnSync('nft', ['--version']).status === 0 && spawnSync('ip', ['netns', 'list']).status === 0;

describe.runIf(canNetns)('Prefer Mesh: marking on Linux', () => {
  const ns = `fbrxmesh${process.pid}`;
  const inNs = (...cmd: string[]) => execFileSync('ip', ['netns', 'exec', ns, ...cmd], { encoding: 'utf8' });
  let dir = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'fbrx-mesh-nft-'));
    execFileSync('ip', ['netns', 'add', ns]);
    execFileSync('ip', ['-n', ns, 'link', 'set', 'lo', 'up']);
  });
  afterAll(() => {
    spawnSync('ip', ['netns', 'del', ns]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('marks mesh packets AF41 and can be applied again', () => {
    const nft = (text: string) => {
      const file = join(dir, `${Math.random().toString(36).slice(2)}.nft`);
      writeFileSync(file, text);
      inNs('nft', '-f', file);
    };
    const script = meshQosNftables(47800, 'af41');
    nft(script);
    nft(script);
    nft('table inet probe {\n chain post {\n  type filter hook postrouting priority 100;\n  tcp dport 47800 ip dscp af41 counter\n  tcp dport 47801 ip dscp af41 counter\n }\n}\n');
    // One connection to the mesh port and one to another port.
    inNs(process.execPath, '-e', "const net=require('net');let n=0;const s=net.createServer(c=>c.end('x'));s.listen(47800,'127.0.0.1');const t=net.createServer(c=>c.end('x'));t.listen(47801,'127.0.0.1',()=>{for(const p of [47800,47801]){const c=net.connect(p,'127.0.0.1');c.on('data',()=>{c.end();if(++n===2){s.close();t.close()}})}})");
    const out = inNs('nft', 'list', 'table', 'inet', 'probe');
    const [mesh, other] = [...out.matchAll(/counter packets (\d+)/g)].map((m) => Number(m[1]));
    expect(mesh).toBeGreaterThan(0);
    expect(other).toBe(0);
  });
});

describe('Prefer Mesh: reaching paired computers', () => {
  let A: Awaited<ReturnType<typeof makeKernel>>;
  let B: Awaited<ReturnType<typeof makeKernel>>;
  let ka: Kernel;
  let kb: Kernel;
  let bOnA = '';
  beforeAll(async () => {
    A = await makeKernel();
    B = await makeKernel();
    ka = A.kernel;
    kb = B.kernel;
    ka.settings.update({ mesh: { enabled: true, port: 47861 }, general: { deviceName: 'server-a' } });
    kb.settings.update({ mesh: { enabled: true, port: 47862, assist: { roles: ['gate', 'minidome'] } }, general: { deviceName: 'server-b' } });
    await waitFor(() => ka.mesh.running && kb.mesh.running);
    const pairing = (await kb.call('mesh.startPairing', undefined, USER)) as { code: string };
    bOnA = ((await ka.call('mesh.pair', { code: pairing.code, host: '127.0.0.1:47862' }, USER)) as { id: string }).id;
  }, 60_000);
  afterAll(async () => {
    await B?.cleanup();
    await A?.cleanup();
  }, 60_000);

  it('learns the other computer’s addresses and roles', async () => {
    const h = await ka.mesh.hello(bOnA);
    expect(h.roles).toEqual(['gate', 'minidome']);
    expect(ka.mesh.rolesOf(bOnA)).toEqual(['gate', 'minidome']);
    expect(h.addresses).toEqual(kb.mesh.addresses());
    // Without Prefer Mesh: the address it was paired on.
    expect(ka.mesh.addressFor(bOnA)).toBe('127.0.0.1');
  });

  it('goes through the preferred mesh network, and back to the usual address when it does not answer', async () => {
    const lan = kb.mesh.addresses()[0];
    if (lan) {
      ka.settings.update({ mesh: { network: { preferMesh: true, subnets: [`${lan}/32`] } } });
      expect(ka.mesh.addressFor(bOnA)).toBe(lan);
      await expect(ka.mesh.hello(bOnA)).resolves.toMatchObject({ name: 'server-b' });
    }
    // A preferred address that cannot be reached: the request still arrives, on the usual address.
    ka.db.run('UPDATE mesh_devices SET addrs = ? WHERE id = ?', JSON.stringify(['255.255.255.255']), bOnA);
    ka.settings.update({ mesh: { network: { preferMesh: true, subnets: ['255.255.255.255/32'] } } });
    expect(ka.mesh.addressFor(bOnA)).toBe('255.255.255.255');
    await expect(ka.call('mesh.peerInfo', { id: bOnA }, USER)).resolves.toBeTruthy();
    expect(ka.mesh.addressFor(bOnA)).toBe('127.0.0.1');
    const [path] = await ka.meshNetwork.test(bOnA);
    expect(path).toMatchObject({ peerName: 'server-b', address: '127.0.0.1', preferred: false, error: null });
  });
});
